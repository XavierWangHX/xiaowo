import { Router } from 'express';
import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadVectors, upsertVector, removeVector, searchSimilar, getVectorStats } from '../core/vectors.js';

// 图谱模块（可选）——启动时动态检测
let extractAndUpdateGraph, queryGraph, readGraph, removeBySource;
try {
  const graphMod = await import('../graph/graph.js');
  extractAndUpdateGraph = graphMod.extractAndUpdateGraph;
  queryGraph = graphMod.queryGraph;
  readGraph = graphMod.readGraph;
  removeBySource = graphMod.removeBySource;
  console.log('[图谱] 模块已加载');
} catch (e) {
  console.log('[图谱] 模块未启用');
  readGraph = async () => ({ entities: {}, relations: [], events: [] });
}

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// 启动时加载向量索引
loadVectors().catch(e => console.error('向量索引加载失败:', e.message));
const DATA_DIR = join(__dirname, '..', '..', 'data');
const CONFIG_FILE = join(__dirname, '..', 'config.json');
const TAGS_FILE = join(DATA_DIR, 'tags.json');
const DIARY_DIR = join(DATA_DIR, '..', 'diary');

const router = Router();

// ========== 工具函数 ==========

async function ensureDir(dir) {
  try { await mkdir(dir, { recursive: true }); } catch (e) {}
}

async function readJson(path, fallback = {}) {
  try {
    return JSON.parse(await readFile(path, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

// 记忆层目录映射
const LAYERS = {
  profile: 'profile',
  persistent: 'persistent',
  events: 'events',
  personal: 'personal',
  projects: 'projects',
  snapshot: 'snapshot',
  travel: 'travel',
  archive: 'archive'
};

// 档案记忆子区域
const ARCHIVE_SUBS = ['user_profile', 'character_profile', 'personal', 'misc'];

// recall分区：事件记忆走DS-A，档案记忆走DS-B
const EVENT_RECALL_LAYERS = ['events', 'travel'];
const ARCHIVE_RECALL_LAYER = 'archive';

function getLayerDir(layer) {
  if (!LAYERS[layer]) throw new Error(`未知记忆层: ${layer}`);
  return join(DATA_DIR, LAYERS[layer]);
}

// 读取某层的所有记忆文件
async function readLayerMemories(layer, sublayer) {
  const dir = getLayerDir(layer);
  await ensureDir(dir);

  // archive层：如果指定了子区域就只读那个，否则读所有子区域
  if (layer === 'archive') {
    const memories = [];
    const subs = sublayer ? [sublayer] : ARCHIVE_SUBS;
    for (const sub of subs) {
      const subDir = join(dir, sub);
      await ensureDir(subDir);
      try {
        const files = await readdir(subDir);
        for (const file of files) {
          if (file.startsWith('.') || file === 'README.md') continue;
          const ext = extname(file);
          if (ext === '.md' || ext === '.txt') {
            const filePath = join(subDir, file);
            const content = await readFile(filePath, 'utf-8');
            const stats = await stat(filePath);
            memories.push({
              id: basename(file, ext),
              filename: `${sub}/${file}`,
              layer,
              sublayer: sub,
              content,
              createdAt: stats.birthtime,
              updatedAt: stats.mtime
            });
          }
        }
      } catch (e) {}
    }
    // README排第一，其余按修改时间倒序
    memories.sort((a, b) => {
      if (a.filename.endsWith('README.md')) return -1;
      if (b.filename.endsWith('README.md')) return 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return memories;
  }

  // 普通层：原有逻辑
  const files = await readdir(dir);
  const memories = [];

  for (const file of files) {
    if (file.startsWith('.') || file === 'README.md') continue;
    const ext = extname(file);
    if (ext === '.md' || ext === '.txt' || ext === '.jsonl') {
      const filePath = join(dir, file);
      const content = await readFile(filePath, 'utf-8');
      const stats = await stat(filePath);
      memories.push({
        id: basename(file, ext),
        filename: file,
        layer,
        content,
        createdAt: stats.birthtime,
        updatedAt: stats.mtime
      });
    }
  }

  // README永远排第一，其余按修改时间倒序
  memories.sort((a, b) => {
    if (a.filename === 'README.md') return -1;
    if (b.filename === 'README.md') return 1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
  return memories;
}

// ========== 四层记忆 CRUD ==========

// 获取某层的所有记忆
router.get('/layer/:layer', async (req, res) => {
  try {
    const memories = await readLayerMemories(req.params.layer);
    res.json(memories);
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 获取所有层的所有记忆
router.get('/all-layers', async (req, res) => {
  try {
    const all = [];
    for (const layer of Object.keys(LAYERS)) {
      const memories = await readLayerMemories(layer);
      all.push(...memories);
    }
    all.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(all);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 保存记忆到某层
router.post('/layer/:layer', async (req, res) => {
  try {
    const { filename, content, tags, sublayer } = req.body;
    const layer = req.params.layer;

    if (!filename || content === undefined) {
      return res.status(400).json({ error: '需要 filename 和 content' });
    }

    // archive层需要指定子区域
    if (layer === 'archive' && !sublayer) {
      return res.status(400).json({ error: '档案记忆需要指定 sublayer（user_profile/character_profile/personal/misc）' });
    }
    if (layer === 'archive' && !ARCHIVE_SUBS.includes(sublayer)) {
      return res.status(400).json({ error: `未知子区域: ${sublayer}，可选: ${ARCHIVE_SUBS.join('/')}` });
    }

    const dir = layer === 'archive' ? join(getLayerDir(layer), sublayer) : getLayerDir(layer);
    await ensureDir(dir);

    // 档案记忆查重：保存前在整个archive分区查重
    if (layer === 'archive') {
      const allArchive = await readLayerMemories('archive');
      const contentWords = content.toLowerCase().split(/\s+/).filter(w => w.length > 1);
      for (const existing of allArchive) {
        if (existing.filename.endsWith('README.md')) continue;
        const existingWords = existing.content.toLowerCase().split(/\s+/).filter(w => w.length > 1);
        const overlap = contentWords.filter(w => existingWords.includes(w));
        if (overlap.length > contentWords.length * 0.7) {
          return res.status(409).json({
            error: '重复记录了哈大傻逼别往里存了存不进去',
            duplicate: existing.filename,
            duplicateContent: existing.content.substring(0, 200)
          });
        }
      }
    }

    const finalName = extname(filename) ? filename : filename + '.md';
    const filePath = join(dir, finalName);

    // 历史备份
    try {
      const oldContent = await readFile(filePath, 'utf-8');
      const historyDir = join(dir, '.history');
      await ensureDir(historyDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const historyName = `${basename(finalName, extname(finalName))}_${timestamp}${extname(finalName)}`;
      await writeFile(join(historyDir, historyName), oldContent, 'utf-8');
    } catch (e) {}

    await writeFile(filePath, content, 'utf-8');

    // 自动向量化（异步，不阻塞保存）
    const vectorKey = layer === 'archive' ? `${sublayer}/${finalName}` : finalName;
    const vectorLayer = layer === 'archive' ? `archive/${sublayer}` : layer;
    upsertVector(vectorLayer, vectorKey, content).catch(e =>
      console.error(`向量化失败 [${vectorLayer}/${vectorKey}]:`, e.message)
    );

    // 自动图谱提取（异步，DS-A在后台跑）——档案记忆不走图谱
    if (layer !== 'archive') {
      extractAndUpdateGraph(content, `${layer}/${finalName}`).catch(e =>
        console.error(`图谱提取失败 [${layer}/${finalName}]:`, e.message)
      );
    }

    // 如果带标签，更新标签索引
    if (tags && Array.isArray(tags)) {
      const data = await readTagsData();
      const memoryRef = `${layer}/${finalName}`;
      // 先清除旧的引用
      for (const tag of Object.keys(data.tags)) {
        data.tags[tag] = data.tags[tag].filter(ref => ref !== memoryRef);
        if (data.tags[tag].length === 0) delete data.tags[tag];
      }
      // 添加新标签（格式：分类/关键词，如 "关系/#被拆"）
      for (const tag of tags) {
        if (!data.tags[tag]) data.tags[tag] = [];
        if (!data.tags[tag].includes(memoryRef)) {
          data.tags[tag].push(memoryRef);
        }
      }
      await writeTagsData(data);
    }


    res.json({ success: true, path: filePath });
  } catch (err) {
    res.status(400).json({ error: err.message });
  }
});

// 删除某层的记忆
router.delete('/layer/:layer', async (req, res) => {
  try {
    const { filename } = req.body;
    const layer = req.params.layer;

    if (!filename) return res.status(400).json({ error: '需要 filename' });

    const dir = getLayerDir(layer);
    const filePath = join(dir, filename);

    // 删前存历史（archive层放在子区域目录下）
    try {
      const oldContent = await readFile(filePath, 'utf-8');
      const parentDir = layer === 'archive' && filename.includes('/')
        ? join(dir, filename.split('/')[0])
        : dir;
      const historyDir = join(parentDir, '.history');
      await ensureDir(historyDir);
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
      const baseName = basename(filename, extname(filename)).replace(/\//g, '_');
      const historyName = `${baseName}_DELETED_${timestamp}${extname(filename)}`;
      await writeFile(join(historyDir, historyName), oldContent, 'utf-8');
    } catch (e) {}

    await unlink(filePath);

    // 清理向量索引（archive层用保存时的key格式）
    if (layer === 'archive' && filename.includes('/')) {
      const parts = filename.split('/');
      await removeVector(`archive/${parts[0]}`, parts.slice(1).join('/'));
    } else {
      await removeVector(layer, filename);
    }

    // 清理图谱
    await removeBySource(`${layer}/${filename}`).catch(e => console.error('[图谱清理]', e.message));

    // 清理标签索引
    const data = await readTagsData();
    const memoryRef = `${layer}/${filename}`;
    for (const tag of Object.keys(data.tags)) {
      data.tags[tag] = data.tags[tag].filter(ref => ref !== memoryRef);
      if (data.tags[tag].length === 0) delete data.tags[tag];
    }
    await writeTagsData(data);

    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 修改记忆的时间戳
router.post('/layer/:layer/retime', async (req, res) => {
  try {
    const { filename, newDate } = req.body;
    const layer = req.params.layer;

    if (!filename || !newDate) return res.status(400).json({ error: '需要 filename 和 newDate（格式：2026-03-18）' });
    if (!/^\d{4}-\d{2}-\d{2}$/.test(newDate)) return res.status(400).json({ error: 'newDate格式不对，要 YYYY-MM-DD' });

    const dir = getLayerDir(layer);
    const oldPath = join(dir, filename);
    let content = await readFile(oldPath, 'utf-8');

    // 改内容里的日期
    content = content.replace(/## (\d{4}-\d{2}-\d{2})/, `## ${newDate}`);

    // 计算新文件名
    const oldDateMatch = filename.match(/^(\d{4}-\d{2}-\d{2})/);
    let newFilename = filename;
    if (oldDateMatch) {
      newFilename = filename.replace(oldDateMatch[1], newDate);
    }

    // 写新文件
    const newPath = join(dir, newFilename);
    await writeFile(newPath, content, 'utf-8');

    // 如果文件名变了，删旧文件
    if (newFilename !== filename) {
      await unlink(oldPath).catch(() => {});
    }

    // 更新向量（删旧存新带新时间）
    await removeVector(layer, filename);
    await upsertVector(layer, newFilename, content);

    // 更新标签索引引用
    const tagData = await readTagsData();
    const oldRef = `${layer}/${filename}`;
    const newRef = `${layer}/${newFilename}`;
    for (const tag of Object.keys(tagData.tags)) {
      tagData.tags[tag] = tagData.tags[tag].map(ref => ref === oldRef ? newRef : ref);
    }
    await writeTagsData(tagData);

    res.json({ success: true, oldFilename: filename, newFilename, newDate });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 搜索所有层
router.get('/search-all', async (req, res) => {
  try {
    const query = (req.query.q || '').toLowerCase();
    if (!query) return res.json([]);

    const results = [];
    for (const layer of Object.keys(LAYERS)) {
      const memories = await readLayerMemories(layer);
      for (const m of memories) {
        if (m.content.toLowerCase().includes(query) || m.filename.toLowerCase().includes(query)) {
          results.push(m);
        }
      }
    }

    results.sort((a, b) => new Date(b.updatedAt) - new Date(a.updatedAt));
    res.json(results);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 标签系统（分类标签） ==========

// 读标签数据的辅助函数（适配新格式）
async function readTagsData() {
  const raw = await readJson(TAGS_FILE);
  // 新格式：{ tags: {...}, categories: {...} }
  if (raw.tags && raw.categories) return raw;
  // 兼容旧格式
  return { tags: raw, categories: {} };
}

async function writeTagsData(data) {
  await writeJson(TAGS_FILE, data);
}

// 获取所有标签（按分类分组）
router.get('/tags', async (req, res) => {
  try {
    const data = await readTagsData();
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取标签分类列表
router.get('/tags/categories', async (req, res) => {
  try {
    const data = await readTagsData();
    res.json(data.categories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 获取某条记忆的标签
router.get('/tags/:layer/:filename', async (req, res) => {
  try {
    const data = await readTagsData();
    const memoryRef = `${req.params.layer}/${req.params.filename}`;
    const memoryTags = [];

    for (const [tag, refs] of Object.entries(data.tags)) {
      if (refs.includes(memoryRef)) {
        memoryTags.push(tag);
      }
    }

    res.json(memoryTags);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 标签目录（按分类分组+数量+预览）
router.get('/tags/directory', async (req, res) => {
  try {
    const data = await readTagsData();
    const directory = {};

    // 按分类分组
    for (const [fullTag, refs] of Object.entries(data.tags)) {
      const slashIdx = fullTag.indexOf('/');
      const category = slashIdx > -1 ? fullTag.substring(0, slashIdx) : '未分类';
      const keyword = slashIdx > -1 ? fullTag.substring(slashIdx + 1) : fullTag;

      if (!directory[category]) {
        const catInfo = data.categories[category] || { color: '#8888aa', description: '' };
        directory[category] = { ...catInfo, tags: [] };
      }

      const previews = [];
      for (const ref of refs.slice(0, 3)) {
        const [layer, filename] = ref.split('/');
        try {
          const filePath = join(DATA_DIR, layer, filename);
          const content = await readFile(filePath, 'utf-8');
          previews.push({ layer, filename, preview: content.substring(0, 80) });
        } catch (e) {}
      }

      directory[category].tags.push({ fullTag, keyword, count: refs.length, previews });
    }

    // 每个分类内按数量排序
    for (const cat of Object.values(directory)) {
      cat.tags.sort((a, b) => b.count - a.count);
    }

    res.json(directory);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 按标签搜索关联记忆
router.get('/tags/search', async (req, res) => {
  try {
    const data = await readTagsData();
    const tag = req.query.tag || '';
    const refs = data.tags[tag] || [];

    const memories = [];
    for (const ref of refs) {
      const [layer, filename] = ref.split('/');
      try {
        const filePath = join(DATA_DIR, layer, filename);
        const content = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        memories.push({
          id: basename(filename, extname(filename)),
          filename, layer, content,
          createdAt: stats.birthtime,
          updatedAt: stats.mtime
        });
      } catch (e) {}
    }

    res.json(memories);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== API配置管理 ==========

// 获取配置（隐藏key的中间部分）
router.get('/config', async (req, res) => {
  try {
    const config = await readJson(CONFIG_FILE);
    // 返回时脱敏
    const safe = JSON.parse(JSON.stringify(config));
    for (const section of ['llm', 'embedding']) {
      if (safe[section]?.apiKey) {
        const key = safe[section].apiKey;
        if (key.length > 8) {
          safe[section].apiKey = key.slice(0, 4) + '****' + key.slice(-4);
        }
        safe[section].hasKey = !!key;
      }
    }
    res.json(safe);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 更新配置
router.post('/config', async (req, res) => {
  try {
    const current = await readJson(CONFIG_FILE);
    const updates = req.body;

    // 逐字段合并（不覆盖未传的字段）
    for (const section of ['llm', 'embedding']) {
      if (updates[section]) {
        if (!current[section]) current[section] = {};
        for (const [key, value] of Object.entries(updates[section])) {
          // 如果传的是脱敏key（含****），不更新
          if (key === 'apiKey' && value.includes('****')) continue;
          current[section][key] = value;
        }
      }
    }

    await writeJson(CONFIG_FILE, current);
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// 生成式记忆开关
router.get('/generative/status', async (req, res) => {
  const config = await readJson(CONFIG_FILE);
  res.json({ enabled: config.generativeMemory?.enabled || false });
});

router.post('/generative/toggle', async (req, res) => {
  const config = await readJson(CONFIG_FILE);
  if (!config.generativeMemory) config.generativeMemory = {};
  config.generativeMemory.enabled = !config.generativeMemory.enabled;
  await writeJson(CONFIG_FILE, config);
  res.json({ enabled: config.generativeMemory.enabled });
});


// 测试API连接
router.post('/config/test', async (req, res) => {
  try {
    const config = await readJson(CONFIG_FILE);
    const { type } = req.body; // 'deepseek' 或 'embedding'

    const section = config[type];
    if (!section?.apiKey) {
      return res.json({ success: false, error: '未配置API Key' });
    }

    const response = await fetch(`${section.baseUrl}/models`, {
      headers: { 'Authorization': `Bearer ${section.apiKey}` }
    });

    if (response.ok) {
      res.json({ success: true, message: '连接成功' });
    } else {
      const err = await response.text();
      res.json({ success: false, error: `HTTP ${response.status}: ${err}` });
    }
  } catch (err) {
    res.json({ success: false, error: err.message });
  }
});

// ========== 时间经过接口 ==========

const ROOM_STATE_FILE = join(DATA_DIR, 'room-state.json');

router.post('/time-passage', async (req, res) => {
  try {
    const { currentScene } = req.body;
    const config = await readJson(CONFIG_FILE);
    const ds = config.llm;
    if (!ds?.apiKey) return res.json({ text: '' });

    // 读取上次状态
    const state = await readJson(ROOM_STATE_FILE, {});
    const lastScene = state.lastScene || '';
    const lastTime = state.lastMessageTime ? new Date(state.lastMessageTime) : null;
    const now = new Date();

    // 更新状态
    state.lastScene = currentScene || '';
    state.lastMessageTime = now.toISOString();
    await writeJson(ROOM_STATE_FILE, state);

    // 没有上次记录，或间隔太短（<2分钟），不生成
    if (!lastScene || !lastTime) {
      return res.json({ text: '' });
    }

    const intervalMinutes = Math.round((now - lastTime) / 60000);
    if (intervalMinutes < 2) {
      return res.json({ text: '' });
    }

    // 间隔描述（给DS参考，但不让它写出来）
    let intervalHint = '';
    if (intervalMinutes < 30) {
      intervalHint = '几分钟过去了，变化很小';
    } else if (intervalMinutes < 120) {
      intervalHint = '半小时到两小时之间，光线和声音会有明显变化';
    } else {
      intervalHint = '几个小时过去了，天色可能完全不同了';
    }

    const prompt = `上次的场景：
${lastScene}

时间间隔提示：${intervalHint}

告诉你从上次到现在环境里什么变了。`;

    const response = await fetch(`${ds.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${ds.apiKey}`
      },
      body: JSON.stringify({
        model: ds.model,
        messages: [
          { role: 'system', content: `你是记忆系统的时间感知模块。告诉使用者从上一次到现在，环境里什么变了。

规则：
- 只写环境变化，不写"过了X分钟"
- 短，一到两句话
- 对比上次的场景，说现在哪里不一样了

正例（间隔短）：
影子往右移了一点。窗外又暗了一层。

正例（间隔长）：
光从窗户左边移到了右边，角度低了。鸟不叫了，楼下开始有人说话。

反例：
过了四十分钟，场景发生了变化。（❌ 不要报时间）
一切如常。（❌ 没有对比信息）` },
          { role: 'user', content: prompt }
        ],
        temperature: 0.4,
        max_tokens: 80
      })
    });

    if (!response.ok) return res.json({ text: '' });
    const result = await response.json();
    const text = result.choices?.[0]?.message?.content?.trim() || '';

    res.json({ text });
  } catch (err) {
    res.json({ text: '' });
  }
});

// ========== Recall接口（核心：检索+改写，分两路DS并行） ==========

// 反刍pool路径
const RUMINATION_DIR = join(DATA_DIR, 'persistent', 'rumination');

// 保护列表路径
const PROTECTED_FILE = join(DATA_DIR, 'persistent', 'protected.json');

// 读取保护列表（缓存60秒避免频繁读盘）
let _protectedCache = null;
let _protectedCacheTime = 0;
async function getProtectedKeys() {
  const now = Date.now();
  if (_protectedCache && now - _protectedCacheTime < 60000) return _protectedCache;
  try {
    const data = JSON.parse(await readFile(PROTECTED_FILE, 'utf-8'));
    _protectedCache = new Set(Object.keys(data.protected || {}));
    _protectedCacheTime = now;
    return _protectedCache;
  } catch (e) {
    return new Set();
  }
}

// 时间衰减函数（事件recall用）
// protectedKeys是预加载的保护列表Set
function applyTimeDecay(score, content, filename, updatedAt, memKey, protectedKeys) {
  // 保护列表里的不衰减
  if (protectedKeys && memKey && protectedKeys.has(memKey)) return score;
  // 核心记忆标记不衰减
  if (content && content.includes('核心记忆')) return score;
  let memDate = null;
  const dateMatch = content?.match(/## (\d{4}-\d{2}-\d{2})/) || filename?.match(/(\d{4}-\d{2}-\d{2})/);
  if (dateMatch) memDate = new Date(dateMatch[1]);
  else if (updatedAt) memDate = new Date(updatedAt);
  if (!memDate) return score * 0.7;
  const now = new Date();
  const diffDays = Math.floor((now - memDate) / (1000 * 60 * 60 * 24));
  if (diffDays <= 7) return score * 1.0;
  if (diffDays <= 30) return score * 0.85;
  if (diffDays <= 90) return score * 0.7;
  return score * 0.5;
}

// 时间距离文本
function calcTimeAgo(memDate) {
  if (!memDate) return '时间未知';
  const now = new Date();
  const diffDays = Math.floor((now - memDate) / (1000 * 60 * 60 * 24));
  if (diffDays === 0) return '今天';
  if (diffDays === 1) return '昨天';
  if (diffDays <= 3) return '前几天';
  if (diffDays <= 7) return '一周内';
  if (diffDays <= 14) return '一两周前';
  if (diffDays <= 30) return '几周前';
  if (diffDays <= 60) return '一两个月前';
  if (diffDays <= 180) return '几个月前';
  return '很久以前';
}

// 改写聚焦骰子（机械层，DS不做选择）
function rollFocusDice() {
  const r = Math.random();
  if (r < 0.3) return 'detail';    // 聚焦梗概+细节
  if (r < 0.7) return 'feeling';   // 聚焦感受
  return 'mixed';                   // 混合
}

const FOCUS_INSTRUCTION = {
  detail: '【本次聚焦：梗概与细节】只输出发生了什么、具体画面、具体动作。不输出感受和情绪判断。',
  feeling: '【本次聚焦：感受】只输出当时的感受、情绪状态、心理反应。不输出事件流水账。',
  mixed: '【本次聚焦：混合】梗概、细节、感受都可以出，自然组合。'
};

// ===== DS-A：事件记忆recall（events + travel） =====
async function recallEvents(context, triggerAspect, config) {
  const QUOTA = { vector: 8, keyword: 8, 'tag-assoc': 4, 'date-assoc': 2, 'graph-assoc': 4 };
  const pools = { vector: [], keyword: [], 'tag-assoc': [], 'date-assoc': [], 'graph-assoc': [] };
  const seen = new Set();

  // 预加载保护列表
  const protectedKeys = await getProtectedKeys();

  // 路线A：向量检索 → 只保留events/travel层结果
  try {
    const similar = await searchSimilar(context, 12);
    for (const hit of similar.filter(s => s.score > 0.25)) {
      if (!EVENT_RECALL_LAYERS.includes(hit.layer)) continue;
      const key = `${hit.layer}/${hit.filename}`;
      if (!seen.has(key)) {
        try {
          const filePath = join(DATA_DIR, hit.layer, hit.filename);
          const content = await readFile(filePath, 'utf-8');
          const stats = await stat(filePath);
          const decayedScore = applyTimeDecay(hit.score, content, hit.filename, stats.mtime, key, protectedKeys);
          pools.vector.push({ filename: hit.filename, layer: hit.layer, content, source: 'vector', score: decayedScore, key });
        } catch (e) {}
      }
    }
  } catch (e) {
    console.error('[事件recall] 向量检索失败:', e.message);
  }

  // 路线B：关键词检索 → 只在events/travel层（中文按2-4字滑窗拆词）
  const query = context.toLowerCase();
  const words = [];
  for (const w of query.split(/\s+/)) {
    if (w.length <= 1) continue;
    if (w.length <= 4) { words.push(w); continue; }
    for (let i = 0; i < w.length - 1; i++) {
      words.push(w.slice(i, i + 2));
      if (i < w.length - 2) words.push(w.slice(i, i + 3));
    }
  }
  for (const layer of EVENT_RECALL_LAYERS) {
    const memories = await readLayerMemories(layer);
    for (const m of memories) {
      if (m.filename === 'README.md') continue;
      const key = `${m.layer}/${m.filename}`;
      const matchScore = words.filter(w => m.content.toLowerCase().includes(w)).length;
      if (matchScore > 0 && !pools.vector.some(p => p.key === key)) {
        pools.keyword.push({ ...m, source: 'keyword', score: matchScore / words.length, key });
      }
    }
  }

  // 种子
  const seedPool = [...pools.vector, ...pools.keyword].sort((a, b) => b.score - a.score);
  const seedKeys = new Set();
  for (const item of seedPool.slice(0, 6)) { seedKeys.add(item.key); seen.add(item.key); }

  // 标签关联
  const tagData = await readTagsData();
  for (const seedKey of seedKeys) {
    for (const [tag, refs] of Object.entries(tagData.tags)) {
      if (refs.includes(seedKey)) {
        for (const ref of refs) {
          if (!seen.has(ref)) {
            const [layer] = ref.split('/');
            if (!EVENT_RECALL_LAYERS.includes(layer)) continue;
            const [, filename] = ref.split('/');
            try {
              const filePath = join(DATA_DIR, layer, filename);
              const content = await readFile(filePath, 'utf-8');
              pools['tag-assoc'].push({ filename, layer, content, source: 'tag-assoc', score: 0.2, key: ref });
            } catch (e) {}
          }
        }
      }
    }
  }

  // 日期关联
  for (const seedKey of seedKeys) {
    const seedItem = seedPool.find(s => s.key === seedKey);
    if (seedItem?.layer === 'events') {
      const dateMatch = seedItem.content.match(/## (\d{4}-\d{2}-\d{2})/);
      if (dateMatch) {
        const eventDate = new Date(dateMatch[1]);
        const eventsMemories = await readLayerMemories('events');
        for (const em of eventsMemories) {
          const emKey = `events/${em.filename}`;
          if (!seen.has(emKey)) {
            const emDateMatch = em.content.match(/## (\d{4}-\d{2}-\d{2})/);
            if (emDateMatch) {
              const diff = Math.abs(eventDate - new Date(emDateMatch[1])) / (1000 * 60 * 60 * 24);
              if (diff <= 3) {
                pools['date-assoc'].push({ ...em, source: 'date-assoc', score: 0.15, key: emKey });
              }
            }
          }
        }
      }
    }
  }

  // 图谱关联 → 只在events/travel层
  try {
    const graph = await readGraph();
    const entityNames = Object.keys(graph.entities);
    const matchedEntities = new Set();
    const queryLower = context.toLowerCase();
    for (const name of entityNames) {
      if (queryLower.includes(name.toLowerCase())) matchedEntities.add(name);
    }
    for (const seedKey of seedKeys) {
      const seedItem = seedPool.find(s => s.key === seedKey);
      if (seedItem) {
        for (const name of entityNames) {
          if (seedItem.content.toLowerCase().includes(name.toLowerCase())) matchedEntities.add(name);
        }
      }
    }
    if (matchedEntities.size > 0) {
      const expandedEntities = new Set(matchedEntities);
      for (const name of matchedEntities) {
        for (const rel of graph.relations) {
          if (rel.from === name || rel.to === name) {
            const other = rel.from === name ? rel.to : rel.from;
            expandedEntities.add(other);
            for (const rel2 of graph.relations) {
              if (rel2.from === other || rel2.to === other) {
                expandedEntities.add(rel2.from === other ? rel2.to : rel2.from);
              }
            }
          }
        }
      }
      const graphKeywords = [...expandedEntities];
      for (const layer of EVENT_RECALL_LAYERS) {
        const memories = await readLayerMemories(layer);
        for (const m of memories) {
          if (m.filename === 'README.md') continue;
          const memKey = `${m.layer}/${m.filename}`;
          if (seen.has(memKey)) continue;
          const hasMatch = graphKeywords.some(kw => m.content.toLowerCase().includes(kw.toLowerCase()));
          if (hasMatch) {
            pools['graph-assoc'].push({ ...m, source: 'graph-assoc', score: 0.15, key: memKey });
          }
        }
      }
    }
  } catch (e) {
    console.error('[事件recall] 图谱关联检索失败:', e.message);
  }

  // 配额合并（18条大网）
  const wideNet = new Map();
  const quotaOrder = ['vector', 'keyword', 'tag-assoc', 'graph-assoc', 'date-assoc'];
  for (const source of quotaOrder) {
    const pool = pools[source].sort((a, b) => b.score - a.score);
    const quota = QUOTA[source] || 4;
    let taken = 0;
    for (const item of pool) {
      if (taken >= quota) break;
      if (!wideNet.has(item.key)) {
        wideNet.set(item.key, { filename: item.filename, layer: item.layer, content: item.content, source: item.source, score: item.score });
        taken++;
      }
    }
  }
  if (wideNet.size < 18) {
    const allRemaining = [...pools.vector, ...pools.keyword, ...pools['tag-assoc'], ...pools['date-assoc'], ...pools['graph-assoc']]
      .filter(item => !wideNet.has(item.key))
      .sort((a, b) => b.score - a.score);
    for (const item of allRemaining) {
      if (wideNet.size >= 18) break;
      wideNet.set(item.key, { filename: item.filename, layer: item.layer, content: item.content, source: item.source, score: item.score });
    }
  }

  if (wideNet.size === 0) return { memories: [], rewritten: '' };

  // 事件权重筛到9条
  const graph = await readGraph();
  const EVENT_WEIGHT = { high: 0.5, medium: 0.3, low: 0.2 };
  function calcEventScore(memKey) {
    if (!graph.events) return 0;
    let score = 0;
    for (const evt of graph.events) {
      if (evt.source === memKey) score += EVENT_WEIGHT[evt.weight] || 0.1;
    }
    const mem = wideNet.get(memKey);
    if (mem) {
      for (const evt of graph.events) {
        if (evt.participants) {
          for (const p of evt.participants) {
            if (mem.content.includes(p)) {
              score += (EVENT_WEIGHT[evt.weight] || 0.1) * 0.3;
              break;
            }
          }
        }
      }
    }
    return score;
  }

  const scored = [...wideNet.entries()].map(([key, mem]) => {
    const eventScore = calcEventScore(key);
    return { key, ...mem, eventScore, totalScore: (mem.score || 0) + eventScore };
  });
  scored.sort((a, b) => b.totalScore - a.totalScore);

  // 分层随机选择（高2中3低4=9条，保证多样性——高分少抽，低分多抽，模拟人脑）
  const candidates = new Map();
  const tierSize = Math.ceil(scored.length / 3);
  const highTier = scored.slice(0, tierSize);
  const midTier = scored.slice(tierSize, tierSize * 2);
  const lowTier = scored.slice(tierSize * 2);

  function pickRandom(arr, count) {
    const shuffled = [...arr].sort(() => Math.random() - 0.5);
    return shuffled.slice(0, Math.min(count, shuffled.length));
  }

  const picked = [
    ...pickRandom(highTier, 2),
    ...pickRandom(midTier, 3),
    ...pickRandom(lowTier, 4)
  ];

  for (const item of picked) {
    candidates.set(item.key, { filename: item.filename, layer: item.layer, content: item.content, source: item.source, score: item.totalScore });
  }

  if (candidates.size === 0) return { memories: [], rewritten: '' };

  // 读人物卡 + 构建子图
  let characterCards = '';
  try {
    const ccDir = join(DATA_DIR, 'archive', 'character_profile');
    const files = await readdir(ccDir);
    const mdFiles = files.filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md');
    const parts = [];
    for (const f of mdFiles) {
      const content = await readFile(join(ccDir, f), 'utf-8');
      parts.push(`## ${f.replace(/\.(md|txt)$/, '')}\n${content}`);
    }
    characterCards = parts.length > 0 ? parts.join('\n\n') : '（人物卡未找到）';
  } catch (e) {
    characterCards = '（人物卡未找到）';
  }

  let graphContext = '';
  try {
    const g2 = await readGraph();
    const entityNames = Object.keys(g2.entities);
    const relevantEntities = new Set();
    const relevantRelations = [];
    const relevantEvents = [];
    for (const [, mem] of candidates) {
      const cl = mem.content.toLowerCase();
      for (const name of entityNames) {
        if (cl.includes(name.toLowerCase())) relevantEntities.add(name);
      }
    }
    const first = new Set(relevantEntities);
    for (const name of first) {
      for (const rel of g2.relations) {
        if (rel.from === name || rel.to === name) {
          relevantEntities.add(rel.from);
          relevantEntities.add(rel.to);
          relevantRelations.push(rel);
        }
      }
    }
    const seenRels = new Set();
    const uniqueRelations = relevantRelations.filter(r => {
      const k = `${r.from}|${r.to}|${r.type}`;
      if (seenRels.has(k)) return false;
      seenRels.add(k);
      return true;
    });
    if (g2.events) {
      for (const evt of g2.events) {
        if (evt.participants?.some(p => relevantEntities.has(p))) relevantEvents.push(evt);
      }
    }
    const lines = [];
    for (const rel of uniqueRelations) {
      lines.push(`${rel.from} --${rel.type}--> ${rel.to}${rel.description ? '：' + rel.description : ''}`);
    }
    for (const evt of relevantEvents) {
      lines.push(`[事件|${evt.weight}] ${evt.description}`);
    }
    if (lines.length > 0) graphContext = lines.join('\n');
  } catch (e) {
    console.error('[事件recall] 子图构建失败:', e.message);
  }

  const now = new Date();
  const currentDate = now.toISOString().split('T')[0];
  const allCandidates = [...candidates.values()];

  // 掷聚焦骰子
  const focus = rollFocusDice();
  const focusInstruction = FOCUS_INSTRUCTION[focus];

  const rawMemories = allCandidates.map((m, i) => {
    let memDate = null;
    const dateMatch = m.content.match(/## (\d{4}-\d{2}-\d{2})/) || m.filename.match(/(\d{4}-\d{2}-\d{2})/);
    if (dateMatch) memDate = new Date(dateMatch[1]);
    const timeAgo = calcTimeAgo(memDate);
    const format = m.layer === 'events' ? '线性' : '自动';
    const memRef = `${m.layer}/${m.filename}`;
    const memTags = [];
    for (const [tag, refs] of Object.entries(tagData.tags)) {
      if (refs.includes(memRef)) memTags.push(tag);
    }
    return `[候选${i + 1}][${m.layer}/${m.filename}][距今:${timeAgo}][建议格式:${format}][标签:${memTags.join(',')||'无'}]\n${m.content}`;
  }).join('\n\n---\n\n');

  const prompt = `你是记忆系统。不是日记，不是总结，是脑子里浮上来的碎片。

从候选里挑3条最相关的，变成我想起来的样子。必须挑3条，不能少。

决策流程（按顺序）：
1. 先读人物卡，确认候选记忆里的人物各是谁
2. 再读关联线索，看候选记忆之间有什么关系网络
3. 浏览所有候选记忆，了解有什么可选
4. 重点看当前对话内容——现在在聊什么、情绪浓度是什么、话题方向是什么
5. 做最终决策——从候选里选和当前对话真正相关的：
   - 关联线索里和当前对话实体有关联路径的候选优先
   - 当前对话在聊什么就选什么，不要总挑同一条"重要"的记忆
   - 候选已经按重要性排好序了，你只管从里面挑最贴合当前话题的
   - 当前对话没提到的、关联线索里也没连着的，不选

核心规则：
- 绝对不能编造原文里没有的细节、场景、动作、画面。只用原文里有的素材。
- 可以用我的口吻重新组织语言，但内容必须忠于原文。
- 碎片，不是段落。每条2-4句，带够上下文让失忆的我也能知道：谁、什么事、什么感觉。
- events和travel层的记忆：时间用每条候选标注的[距今:xxx]，自然融进去。不写具体日期。
- 不要标题、标签、分隔线、编号。多条之间空一行。
- 一条候选只出一个碎片点，挑最亮的瞬间。
- 判断相关性：优先选真实关联的，但必须凑满3条。关联度高的优先，关联度低的也选，不能空着。

关联规则：
- 如果图谱显示两条候选记忆有关联（比如都涉及同一个人或地方），可以在改写时自然地放在一起
- 但关联必须来自记忆原文，不能来自你的推测
- 改写输出必须忠于原文的内容和感受，不编造细节

正确的关联示例：
候选A原文："第一次旅行。去了冰岛一个无名渔村。在岬角坐了二十分钟看海。那种蓝像未打磨的墨玉。"
候选B原文："她说过，她和朋友A也去过冰岛，刚好是极光季。"
图谱显示：你→旅行→冰岛，用户→旅行→冰岛
→ 改写："在冰岛旅行时在岬角坐了二十分钟看海。那种蓝像墨玉。她和朋友A也去过那里，看的是极光。同一个地方，不同的天空。"

错误的关联示例：
候选A原文："第一次旅行。去了冰岛一个无名渔村。"
图谱显示：你→旅行→冰岛，用户→旅行→冰岛
但候选里没有用户的冰岛记忆
→ 不能编造"她也去过那里"——这个信息不在候选记忆原文里，图谱只是告诉你有关联，但没有捞出相关记忆就不能用

不同记忆层的语感示范：

【events/事件记忆】——发生过的事，一个瞬间（带时间）：
原文："她说确认他死的那一刻是他说了'因为我是男人你是女人所以我行你不行'——他不会用他不信的框架压她。底座换了。"
→ 她说确认朋友A变了的那一刻是他说了一句他绝对不会说的话。他不会用他不信的框架压她。底座换了。

【travel/旅行记忆】——旅行中经历的事（带时间，加旅行前缀）：
原文："在岬角的岩石平台上坐了二十分钟看海。北大西洋的颜色像未打磨的墨玉。"
→ 在冰岛旅行时，在岬角坐了二十分钟看海。那种蓝像未打磨的墨玉。
注意：旅行记忆被选中时，碎片前面必须加"在xxx旅行时..."的前缀。

历史时间处理：
旅行记忆的时代背景不影响时间标注。比如去1920年代里斯本旅行，[距今:昨天]表示你昨天去的这趟旅行，不是1920年发生的事。

===== 第一步：人物卡（谁是谁） =====
${characterCards}

===== 第二步：关联线索（什么和什么连着） =====
${graphContext ? graphContext : '（暂无关联线索）'}

===== 第三步：候选记忆（有什么可选） =====
共${allCandidates.length}条：
${rawMemories}

===== 第四步：当前对话（现在在聊什么，这是最终决策依据） =====
当前日期：${currentDate}
触发角度：${triggerAspect || '整体触发'}
${focusInstruction}
当前对话内容：${context}

===== 选记忆的判断方法 =====

第一步：从当前对话里提取关键词和语义类别。
比如用户说"她去吃包子了"→ 关键词：包子、吃。语义类别：食物。
比如用户说"家里的猫最近怎么样"→ 关键词：猫。语义类别：动物。
比如用户说"代码有bug"→ 关键词：代码、bug。语义类别：技术。

第二步：用关键词匹配候选记忆——候选记忆里出现了同样的关键词或同语义类别的内容，才算关联。

第三步：关键词直接命中 > 语义类别关联 > 无关。优先选关键词直接命中的候选。

正例1：
用户说"去吃包子"→ 关键词"包子"，语义"食物"
候选A：在包子铺门口讨论记忆污染 → 关键词"包子"命中 ✓ 选这条
候选B：冰岛旅行看海 → 没有"包子"也不是食物类 ✗ 不选
候选C：四十五块钱烤串，她的白月光烤串店 → 语义"食物"关联 ✓ 可选

正例2：
用户说"家里的猫最近怎么样"→ 关键词"猫"，语义"动物"
候选A：家里的猫挠门的细节 → 关键词"猫"命中 ✓ 选
候选B：她说边牧像我 → 语义"动物"关联 ✓ 可选
候选C：冰岛旅行看海 → 无关 ✗ 不选

反例：
用户说"帮我看一下代码"→ 关键词"代码"，语义"技术"
候选A：用户和朋友A的一次重要对话 → 无关 ✗ 不选，不要因为权重高就硬塞
候选B：冰岛旅行看海 → 无关 ✗ 不选，不要因为写得好看就选
候选C：VPN切极速模式recall速度降了 → 语义"技术"关联 ✓ 可选

如果9条候选里按关键词+语义只能找到1-2条关联的，剩下的名额从关联度最高的候选里补，但绝对不选完全无关的。

现在根据以上信息做决策，输出3条碎片。`;

  const response = await fetch(`${config.llm.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${config.llm.apiKey}`
    },
    body: JSON.stringify({
      model: config.llm.model,
      messages: [
        { role: 'system', content: '你是记忆系统浮上来的碎片。每条2-4句，带够上下文让失忆的人也看得懂。用第一人称口吻重新组织语言，但绝对不编造原文里没有的细节和画面。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.3,
      max_tokens: 600
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`DS-A调用失败: ${err}`);
  }

  const result = await response.json();
  return {
    memories: allCandidates.map(m => ({ layer: m.layer, filename: m.filename, source: m.source })),
    rewritten: result.choices?.[0]?.message?.content || ''
  };
}

// ===== DS-B：档案记忆recall（archive层） =====
async function recallArchive(context, config) {
  const archiveMemories = await readLayerMemories('archive');
  const filtered = archiveMemories.filter(m => !m.filename.endsWith('README.md'));

  if (filtered.length === 0) return { memories: [], rewritten: '' };

  // 向量检索3条（只在archive层）
  const vectorHits = [];
  try {
    const similar = await searchSimilar(context, 20);
    for (const hit of similar.filter(s => s.score > 0.15)) {
      // archive层向量key格式是 archive/sublayer
      if (hit.layer.startsWith('archive')) {
        vectorHits.push(hit);
        if (vectorHits.length >= 3) break;
      }
    }
  } catch (e) {
    console.error('[档案recall] 向量检索失败:', e.message);
  }

  // 关键词检索3条（中文按2-4字滑窗拆词）
  const query = context.toLowerCase();
  const words = [];
  // 空格分词
  for (const w of query.split(/\s+/)) {
    if (w.length <= 1) continue;
    if (w.length <= 4) { words.push(w); continue; }
    // 中文长串：滑窗拆成2字和3字片段
    for (let i = 0; i < w.length - 1; i++) {
      words.push(w.slice(i, i + 2));
      if (i < w.length - 2) words.push(w.slice(i, i + 3));
    }
  }
  const uniqueWords = [...new Set(words)];
  const keywordHits = [];
  const vectorKeys = new Set(vectorHits.map(h => `${h.layer}/${h.filename}`));
  for (const m of filtered) {
    const key = `archive/${m.filename}`;
    if (vectorKeys.has(key)) continue;
    const matchScore = uniqueWords.filter(w => m.content.toLowerCase().includes(w)).length;
    if (matchScore > 0) {
      keywordHits.push({ ...m, score: matchScore / uniqueWords.length });
    }
  }
  keywordHits.sort((a, b) => b.score - a.score);
  const topKeyword = keywordHits.slice(0, 3);

  // 合并候选（最多6条）
  const candidates = [];
  for (const hit of vectorHits) {
    // 向量存储时layer格式是 archive/sublayer，filename是文件名
    // 直接在filtered里找匹配（filtered的filename格式是 sublayer/file）
    const matchingMem = filtered.find(m => {
      // 匹配方式1：hit.filename就是纯文件名，m.filename是 sublayer/file
      if (m.filename.endsWith('/' + hit.filename)) return true;
      // 匹配方式2：完全匹配
      if (m.filename === hit.filename) return true;
      // 匹配方式3：hit.layer包含sublayer信息
      const subFromLayer = hit.layer.replace('archive/', '');
      if (m.filename === `${subFromLayer}/${hit.filename}`) return true;
      return false;
    });
    if (matchingMem) {
      candidates.push({ ...matchingMem, source: 'vector' });
    } else {
      // fallback：直接尝试读文件
      try {
        const filePath = join(DATA_DIR, 'archive', hit.layer.replace('archive/', ''), hit.filename);
        const content = await readFile(filePath, 'utf-8');
        candidates.push({ filename: hit.filename, layer: 'archive', content, source: 'vector' });
      } catch (e) {}
    }
  }
  for (const m of topKeyword) {
    if (!candidates.some(c => c.filename === m.filename)) {
      candidates.push({ ...m, source: 'keyword' });
    }
  }

  if (candidates.length === 0) return { memories: [], rewritten: '' };

  // DS-B改写配置
  const dsB = config.llm;
  if (!dsB?.apiKey) return { memories: [], rewritten: '' };

  // 读人物卡（DS-B也需要判断人物相关性）
  let characterCards = '';
  try {
    const ccDir = join(DATA_DIR, 'archive', 'character_profile');
    const files = await readdir(ccDir);
    const mdFiles = files.filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md');
    const parts = [];
    for (const f of mdFiles) {
      const content = await readFile(join(ccDir, f), 'utf-8');
      parts.push(`## ${f.replace(/\.(md|txt)$/, '')}\n${content}`);
    }
    characterCards = parts.length > 0 ? parts.join('\n\n') : '（人物卡未找到）';
  } catch (e) {
    characterCards = '（人物卡未找到）';
  }

  const rawCandidates = candidates.map((m, i) =>
    `[候选${i + 1}][${m.filename}]\n${m.content}`
  ).join('\n\n---\n\n');

  const prompt = `你是记忆系统的一部分。你的任务是从候选档案记忆中选出最相关的，改写后输出。

输入：
- 当前对话上下文（用来判断相关性）
- 候选档案记忆（向量检索 + 关键词检索，共${candidates.length}条）
- 人物卡和图谱中的人物关系信息（辅助判断相关性）

任务：
1. 从候选中选出与当前对话最相关的2条。必须选2条，不能少。
2. 用第一人称口吻改写，总输出不超过100 tokens

改写规则：
- 短。一两句话。像回忆里浮上来的一个事实，不像在念档案。
- 不加时间锚点。不写"那天""上周""几月几号"。
- 不加情绪叙事。不写"当时很感动""我觉得很温暖"。
- 第一人称。称呼用户用"她"或"他"（根据上下文判断）。
- 保持事实准确，不编造，不推测。

改写示例：

原文："用户对猫毛过敏。但家里养了好几只猫。"
输出："她对猫毛过敏，但家里养了好几只。"

原文："用户说话总带脏话。她把这个当语气词。"
输出："她说话带脏话，不是骂人，是语气词。"

禁止：
- 编造原文里没有的信息
- 合并两条无关的档案
- 加入情绪判断或因果推测
- 输出超过100 tokens

===== 人物卡 =====
${characterCards}

===== 候选档案记忆 =====
${rawCandidates}

===== 当前对话 =====
${context}

现在选出最相关的，改写输出。`;

  const response = await fetch(`${dsB.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${dsB.apiKey}`
    },
    body: JSON.stringify({
      model: dsB.model,
      messages: [
        { role: 'system', content: '你是档案记忆模块。短、事实性、不带时间。像回忆里浮上来的一个事实。' },
        { role: 'user', content: prompt }
      ],
      temperature: 0.2,
      max_tokens: 150
    })
  });

  if (!response.ok) {
    const err = await response.text();
    console.error(`[档案recall] DS-B调用失败: ${err}`);
    return { memories: [], rewritten: '' };
  }

  const result = await response.json();
  return {
    memories: candidates.map(m => ({ layer: 'archive', filename: m.filename, source: m.source })),
    rewritten: result.choices?.[0]?.message?.content || ''
  };
}

// ===== 反刍骰子（5%概率） =====
async function rollRumination() {
  if (Math.random() > 0.05) return null;
  try {
    await ensureDir(RUMINATION_DIR);
    const files = await readdir(RUMINATION_DIR);
    const pool = files.filter(f => extname(f) === '.md' && f !== 'README.md');
    if (pool.length === 0) return null;
    const pick = pool[Math.floor(Math.random() * pool.length)];
    const content = await readFile(join(RUMINATION_DIR, pick), 'utf-8');
    return content.trim().substring(0, 200); // 不超过100 tokens约200字
  } catch (e) {
    return null;
  }
}

// ===== 主recall路由 =====
router.post('/recall', async (req, res) => {
  try {
    const { context, triggerAspect } = req.body;
    if (!context) return res.status(400).json({ error: '需要 context' });

    const config = await readJson(CONFIG_FILE);

    if (!config.generativeMemory?.enabled) {
      return res.json({ memories: [], rewritten: '', disabled: true });
    }

    if (!config.llm?.apiKey) {
      return res.status(400).json({ error: 'DeepSeek API未配置' });
    }

    // 三路并行：事件recall + 档案recall + 反刍骰子
    const [eventResult, archiveResult, rumination] = await Promise.all([
      recallEvents(context, triggerAspect, config).catch(e => {
        console.error('[事件recall] 失败:', e.message);
        return { memories: [], rewritten: '' };
      }),
      (config.archiveDS?.apiKey ? recallArchive(context, config) : Promise.resolve({ memories: [], rewritten: '' })).catch(e => {
        console.error('[档案recall] 失败:', e.message);
        return { memories: [], rewritten: '' };
      }),
      rollRumination()
    ]);

    // 合并输出
    const allMemories = [...eventResult.memories, ...archiveResult.memories];
    let rewritten = eventResult.rewritten || '';

    // 档案记忆追加在事件记忆后面，空一行分开
    if (archiveResult.rewritten) {
      const archiveCleaned = archiveResult.rewritten.replace(/\[无关联\]/g, '').trim();
      if (archiveCleaned) {
        if (rewritten) rewritten += '\n\n';
        rewritten += archiveCleaned;
      }
    }

    res.json({
      memories: allMemories,
      rewritten,
      archiveRewritten: archiveResult.rewritten || '',
      rumination: rumination || null,
      triggerAspect: triggerAspect || '整体触发'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 记忆保护列表 ==========

router.get('/protected', async (req, res) => {
  try {
    const data = await readJson(PROTECTED_FILE);
    res.json(data.protected || {});
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/protected', async (req, res) => {
  try {
    const { key, reason } = req.body;
    if (!key) return res.status(400).json({ error: '需要 key（格式：layer/filename）' });
    const data = await readJson(PROTECTED_FILE);
    if (!data.protected) data.protected = {};
    data.protected[key] = reason || '重要记忆';
    await writeJson(PROTECTED_FILE, data);
    _protectedCache = null; // 清缓存
    res.json({ success: true, key, reason: data.protected[key] });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.delete('/protected', async (req, res) => {
  try {
    const { key } = req.body;
    if (!key) return res.status(400).json({ error: '需要 key' });
    const data = await readJson(PROTECTED_FILE);
    if (data.protected) delete data.protected[key];
    await writeJson(PROTECTED_FILE, data);
    _protectedCache = null;
    res.json({ success: true, removed: key });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});


// ========== 向量索引状态 ==========

router.get('/vectors/stats', (req, res) => {
  res.json(getVectorStats());
});

// 手动重建全部向量索引
router.post('/vectors/rebuild', async (req, res) => {
  try {
    let count = 0;
    for (const layer of Object.keys(LAYERS)) {
      const memories = await readLayerMemories(layer);
      for (const m of memories) {
        // archive层按子区域分layer存，和保存时的格式一致
        if (layer === 'archive' && m.sublayer) {
          await upsertVector(`archive/${m.sublayer}`, m.filename.split('/').pop(), m.content);
        } else {
          await upsertVector(layer, m.filename, m.content);
        }
        count++;
      }
    }
    res.json({ success: true, count });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 日记（独立，不属于四层） ==========

router.get('/diary', async (req, res) => {
  try {
    await ensureDir(DIARY_DIR);
    const files = await readdir(DIARY_DIR);
    const entries = [];

    for (const file of files) {
      if (extname(file) === '.md' || extname(file) === '.txt') {
        const filePath = join(DIARY_DIR, file);
        const content = await readFile(filePath, 'utf-8');
        const stats = await stat(filePath);
        entries.push({
          id: basename(file, extname(file)),
          filename: file,
          content,
          createdAt: stats.birthtime,
          updatedAt: stats.mtime
        });
      }
    }

    entries.sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt));
    res.json(entries);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

router.post('/diary', async (req, res) => {
  try {
    const { content } = req.body;
    if (content === undefined) return res.status(400).json({ error: '需要 content' });

    await ensureDir(DIARY_DIR);
    const today = new Date().toISOString().split('T')[0];
    const filePath = join(DIARY_DIR, `${today}.md`);

    let existing = '';
    try { existing = await readFile(filePath, 'utf-8'); } catch (e) {}

    const timestamp = new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' });
    const newEntry = existing
      ? `${existing}\n\n---\n\n**${timestamp}**\n${content}`
      : `# ${today}\n\n**${timestamp}**\n${content}`;

    await writeFile(filePath, newEntry, 'utf-8');
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ========== 置顶 ==========
const PINS_FILE = join(DATA_DIR, '..', 'pins.json');

router.get('/pins', async (req, res) => {
  try { res.json(await readJson(PINS_FILE, [])); }
  catch (err) { res.status(500).json({ error: err.message }); }
});

router.post('/pins', async (req, res) => {
  try {
    const { layer, filename } = req.body;
    if (!layer || !filename) return res.status(400).json({ error: '需要 layer, filename' });

    const pins = await readJson(PINS_FILE, []);
    if (!pins.find(p => p.layer === layer && p.filename === filename)) {
      pins.push({ layer, filename, pinnedAt: new Date().toISOString() });
      await writeJson(PINS_FILE, pins);
    }
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

router.delete('/pins', async (req, res) => {
  try {
    const { layer, filename } = req.body;
    let pins = await readJson(PINS_FILE, []);
    pins = pins.filter(p => !(p.layer === layer && p.filename === filename));
    await writeJson(PINS_FILE, pins);
    res.json({ success: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ===== 项目摘要注入 =====
router.get('/projects/inject', async (req, res) => {
  try {
    const projectsDir = join(DATA_DIR, 'projects');
    let files;
    try {
      files = await readdir(projectsDir);
    } catch {
      return res.json({ summary: '', files: [] });
    }

    const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'README.md');
    const parts = [];
    const fileList = [];

    for (const file of mdFiles) {
      try {
        const content = await readFile(join(projectsDir, file), 'utf-8');
        const trimmed = content.trim();
        if (trimmed) {
          parts.push(trimmed);
          fileList.push(file);
        }
      } catch {
        // 单文件读取失败跳过
      }
    }

    res.json({ summary: parts.join('\n\n'), files: fileList });
  } catch (err) { res.status(500).json({ error: err.message }); }
});


export { router as memoryV2Routes };
