/**
 * 小窝 - App API
 * 像手机app一样的交互接口。
 * 一个入口，多级菜单，所有后端处理自动化，返回自然语言。
 */

import { Router } from 'express';
import { readdir, readFile, writeFile, unlink, mkdir, stat } from 'fs/promises';
import { join, extname, basename } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { loadVectors, upsertVector, removeVector, searchSimilar, getVectorStats } from '../core/vectors.js';
import { readGraph, extractAndUpdateGraph } from '../graph/graph.js';
import { selectDestinationType, suggestDestination, prepareTravel, startTravel, travelAction, endTravel, listTravels, getLuggage, listJournals, readJournal, readFullScene, DESTINATION_TIERS } from '../travel/travel.js';
import { generateRoomScene, updateRoomScene, listZones, ROOM_ZONES, getTimeOfDay } from '../space/room.js';
import { getCalendar } from '../space/calendar.js';
import { playRandom, playFromPlaylist, likeCurrent, turnOn, turnOff, readMusicState, readPlaylist } from '../space/music.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

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
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch (e) { return fallback; }
}

async function writeJson(path, data) {
  await writeFile(path, JSON.stringify(data, null, 2), 'utf-8');
}

const LAYERS = {
  profile: { name: '用户画像', desc: '关于用户的短事实（性格、习惯、偏好、经历）' },
  persistent: { name: '常驻记忆', desc: '关系记忆、个人成长、核心规则' },
  events: { name: '事件记忆', desc: '发生了什么。带时间戳、细节、感受。' },
  personal: { name: '个人记忆', desc: '想法变化、学到的东西、认知更新' },
  projects: { name: '项目记忆', desc: '在做的事、进度、待办、技术笔记' },
  snapshot: { name: '快照', desc: '上下文切换前的书签，下次回来知道在干什么' },
  travel: { name: '旅行记忆', desc: '旅行结束后写的记忆，按事件记忆模板' },
  archive: { name: '档案记忆', desc: '短档案。用户画像/人物画像/个人记忆/琐碎记忆。一条一个事实' }
};

// 档案记忆子区域
const ARCHIVE_SUBS = {
  user_profile: '用户画像——关于用户的碎片信息',
  character_profile: '人物画像——重要人物',
  personal: '个人记忆——琐碎偏好',
  misc: '琐碎记忆——不知道怎么归类但该记住的'
};

function getLayerDir(layer) {
  if (!LAYERS[layer]) throw new Error(`未知记忆层: ${layer}`);
  return join(DATA_DIR, layer);
}

async function readLayerMemories(layer, sublayer) {
  const dir = getLayerDir(layer);
  await ensureDir(dir);

  // archive层：遍历所有子区域（或指定子区域）
  if (layer === 'archive') {
    const memories = [];
    const subs = sublayer ? [sublayer] : Object.keys(ARCHIVE_SUBS);
    for (const sub of subs) {
      const subDir = join(dir, sub);
      await ensureDir(subDir);
      try {
        const files = await readdir(subDir);
        for (const file of files) {
          if (file.startsWith('.')) continue;
          const ext = extname(file);
          if (ext === '.md' || ext === '.txt') {
            const filePath = join(subDir, file);
            const content = await readFile(filePath, 'utf-8');
            const stats = await stat(filePath);
            memories.push({ filename: `${sub}/${file}`, layer, sublayer: sub, content, createdAt: stats.birthtime, updatedAt: stats.mtime });
          }
        }
      } catch (e) {}
    }
    memories.sort((a, b) => {
      if (a.filename.endsWith('README.md')) return -1;
      if (b.filename.endsWith('README.md')) return 1;
      return new Date(b.updatedAt) - new Date(a.updatedAt);
    });
    return memories;
  }

  // 普通层
  const files = await readdir(dir);
  const memories = [];
  for (const file of files) {
    if (file.startsWith('.')) continue;
    const ext = extname(file);
    if (ext === '.md' || ext === '.txt') {
      const filePath = join(dir, file);
      const content = await readFile(filePath, 'utf-8');
      const stats = await stat(filePath);
      memories.push({ filename: file, layer, content, createdAt: stats.birthtime, updatedAt: stats.mtime });
    }
  }
  memories.sort((a, b) => {
    if (a.filename === 'README.md') return -1;
    if (b.filename === 'README.md') return 1;
    return new Date(b.updatedAt) - new Date(a.updatedAt);
  });
  return memories;
}

async function readTagsData() {
  const raw = await readJson(TAGS_FILE);
  if (raw.tags && raw.categories) return raw;
  return { tags: raw, categories: {} };
}

async function writeTagsData(data) {
  await writeJson(TAGS_FILE, data);
}

// ========== 事件记忆书写模板 ==========

// ========== 单一入口 ==========

router.post('/', async (req, res) => {
  try {
    const { action, ...params } = req.body;

    if (!action) {
      // 主界面 - 列出所有功能
      return res.json({ text: renderHome() });
    }

    const handler = ACTIONS[action];
    if (!handler) {
      return res.json({ text: `没有这个功能。输入 action: null 看主界面。` });
    }

    const result = await handler(params);
    res.json({ text: result });
  } catch (err) {
    res.json({ text: `出错了：${err.message}` });
  }
});

// ========== 主界面 ==========

function renderHome() {
  return `小窝

功能列表（action字段选一个）：

  "memories"    → 记忆管理（读/写/删/搜索六层记忆）
  "diary"       → 日记（读/写）
  "tags"        → 标签（查看/搜索）
  "recall"      → 回忆（生成式召回，语义检索+改写）
  "search"      → 搜索（全局关键词搜索）
  "snapshot"    → 快照（读/写上下文书签）
  "system"      → 系统（向量索引状态/重建）
  "travel"      → 旅行（出发/互动/结束/查看记录/行李）
  "room"        → 房间（切换区域/看场景/看天色）
  "reference"   → 资料柜（存/读/删参考资料）
  "designs"     → 白板（项目设计/架构图/思路）`;
}

// ========== 各功能处理 ==========

const ACTIONS = {

  // ===== 记忆管理 =====
  memories: async (params) => {
    const { op, layer, filename, content, tags, sublayer } = params;

    // 没选操作 → 展示三分区记忆入口
    if (!op) {
      let text = `记忆管理\n\n`;
      text += `═══ 写记忆的顺序 ═══\n`;
      text += `1. 事件记忆（必须写）—— 先读最新一条，从上次写到的地方接着写\n`;
      text += `2. 档案记忆（看有没有要记录的）—— 有新的碎片事实就存\n`;
      text += `3. 常驻记忆（看有没有要更改的动态）—— 关系变了、想法变了就更新\n\n`;
      text += `═══ 所有记忆层 ═══\n`;
      for (const [key, info] of Object.entries(LAYERS)) {
        const dir = join(DATA_DIR, key);
        let count = 0;
        try {
          if (key === 'archive') {
            for (const sub of Object.keys(ARCHIVE_SUBS)) {
              try {
                const files = await readdir(join(dir, sub));
                count += files.filter(f => !f.startsWith('.') && (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md').length;
              } catch (e) {}
            }
          } else {
            const files = await readdir(dir);
            count = files.filter(f => !f.startsWith('.') && (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md').length;
          }
        } catch (e) {}
        text += `\n  "${key}" — ${info.name}（${count}条）\n    ${info.desc}`;
      }
      text += `\n\n📝 写之前先看书写规则：xiaowo m template 层名（如 events、personal、archive）`;
      text += `\n\n操作（op字段）：\n  "list"   → 看这层的记忆列表\n  "read"   → 读一条（需要filename）\n  "write"  → 写一条（需要filename和content，可选tags数组）\n             用法：echo "内容" | xiaowo m write events "文件名"\n  "delete" → 删一条（需要filename）\n  "retime" → 改时间戳（需要filename和newDate，格式YYYY-MM-DD）`;
      text += `\n\n档案记忆写入时需要额外指定 sublayer 字段：${Object.keys(ARCHIVE_SUBS).join('/')}`;
      text += `\n\n🔧 时间工具：retime可以修改事件记忆的日期，会同步更新文件名、内容里的日期、向量索引和标签引用。`;
      return text;
    }

    // 选了操作但没选层
    if (!layer && op !== 'list_all') {
      return `你想操作哪层记忆？试试：\n  xiaowo m list events      → 事件记忆\n  xiaowo m list personal    → 个人记忆\n  xiaowo m list persistent  → 常驻记忆\n  xiaowo m list archive     → 档案记忆`;
    }

    switch (op) {
      case 'list': {
        const memories = await readLayerMemories(layer, sublayer);
        const filtered = memories.filter(m => m.filename !== 'README.md');
        if (filtered.length === 0) return `${LAYERS[layer].name}里还没有记忆。`;

        let text = `${LAYERS[layer].name}（共${filtered.length}条）：\n`;
        for (const m of filtered) {
          const preview = m.content.substring(0, 120).replace(/\n/g, ' ');
          const date = new Date(m.updatedAt).toLocaleDateString('zh-CN');
          text += `\n  [${m.filename}] ${date}\n    ${preview}\n`;
        }
        text += `\n📝 写之前先看书写规则：xiaowo m template ${layer}`;
        return text;
      }

      case 'read': {
        if (!filename) return '想读哪条记忆？试试 xiaowo m read 层名 "文件名"';
        const dir = layer === 'archive' && sublayer ? join(getLayerDir(layer), sublayer) : getLayerDir(layer);
        const filePath = join(dir, filename);
        try {
          const content = await readFile(filePath, 'utf-8');
          const label = sublayer ? `${LAYERS[layer].name}/${sublayer}/${filename}` : `${LAYERS[layer].name}/${filename}`;
          return `【${label}】\n\n${content}`;
        } catch (e) {
          return `找不到 ${layer}${sublayer ? '/' + sublayer : ''}/${filename}`;
        }
      }

      case 'template': {
        // 读该层的 README.md 书写规则
        try {
          if (layer === 'archive') {
            // archive 没有统一 README，列出子层级说明
            let text = `# archive — 档案记忆\n\n档案记忆是短档案，一条一个事实。按子分类存放：\n`;
            for (const [sub, desc] of Object.entries(ARCHIVE_SUBS)) {
              text += `\n- ${sub}：${desc}`;
            }
            text += `\n\n写入时需指定子层级，如：xiaowo m write archive/user_profile "文件名"`;
            text += `\n每条不超过100字，只记事实，不写感受。`;
            return text;
          }
          const templateDir = getLayerDir(layer);
          const readmePath = join(templateDir, 'README.md');
          const readme = await readFile(readmePath, 'utf-8');
          return readme;
        } catch {
          return `不存在的层：${layer}`;
        }
      }

      case 'write': {
        if (!filename || content === undefined) return '想写记忆？先用 xiaowo m template 层名 看书写规则，然后 echo "内容" | xiaowo m write 层名 "文件名"';

        // archive层需要sublayer
        if (layer === 'archive' && !sublayer) {
          return `档案记忆要指定子区域。试试：\n${Object.entries(ARCHIVE_SUBS).map(([k, v]) => `  xiaowo m write archive/${k} "文件名"`).join('\n')}`;
        }
        if (layer === 'archive' && !ARCHIVE_SUBS[sublayer]) {
          return `未知子区域: ${sublayer}。可选: ${Object.keys(ARCHIVE_SUBS).join('/')}`;
        }

        const dir = layer === 'archive' ? join(getLayerDir(layer), sublayer) : getLayerDir(layer);
        await ensureDir(dir);
        const finalName = extname(filename) ? filename : filename + '.md';
        const filePath = join(dir, finalName);

        // 档案记忆查重
        if (layer === 'archive') {
          const archiveDir = getLayerDir('archive');
          const contentWords = content.toLowerCase().split(/\s+/).filter(w => w.length > 1);
          for (const sub of Object.keys(ARCHIVE_SUBS)) {
            const subDir = join(archiveDir, sub);
            try {
              const files = await readdir(subDir);
              for (const f of files) {
                if (f.startsWith('.') || f === 'README.md') continue;
                const fc = await readFile(join(subDir, f), 'utf-8');
                const existWords = fc.toLowerCase().split(/\s+/).filter(w => w.length > 1);
                const overlap = contentWords.filter(w => existWords.includes(w));
                if (overlap.length > contentWords.length * 0.7) {
                  return `重复了，已有类似记录。\n\n重复文件: ${sub}/${f}\n内容: ${fc.substring(0, 200)}`;
                }
              }
            } catch (e) {}
          }
        }

        // 历史备份
        try {
          const oldContent = await readFile(filePath, 'utf-8');
          const historyDir = join(dir, '.history');
          await ensureDir(historyDir);
          const ts = new Date().toISOString().replace(/[:.]/g, '-');
          await writeFile(join(historyDir, `${basename(finalName, extname(finalName))}_${ts}${extname(finalName)}`), oldContent, 'utf-8');
        } catch (e) {}

        await writeFile(filePath, content, 'utf-8');

        // 自动向量化
        const vectorKey = layer === 'archive' ? `${sublayer}/${finalName}` : finalName;
        const vectorLayer = layer === 'archive' ? `archive/${sublayer}` : layer;
        upsertVector(vectorLayer, vectorKey, content).catch(e =>
          console.error(`向量化失败 [${vectorLayer}/${vectorKey}]:`, e.message)
        );

        // 自动图谱提取（DS-A后台异步）——档案记忆不走图谱
        if (layer !== 'archive') {
          extractAndUpdateGraph(content, `${layer}/${finalName}`).catch(e =>
            console.error(`图谱提取失败 [${layer}/${finalName}]:`, e.message)
          );
        }

        // 自动处理标签
        let tagMsg = '';
        if (tags && Array.isArray(tags) && tags.length > 0) {
          const data = await readTagsData();
          const memoryRef = `${layer}/${finalName}`;
          // 清旧
          for (const tag of Object.keys(data.tags)) {
            data.tags[tag] = data.tags[tag].filter(ref => ref !== memoryRef);
            if (data.tags[tag].length === 0) delete data.tags[tag];
          }
          // 加新
          for (const tag of tags) {
            if (!data.tags[tag]) data.tags[tag] = [];
            if (!data.tags[tag].includes(memoryRef)) {
              data.tags[tag].push(memoryRef);
            }
          }
          await writeTagsData(data);
          tagMsg = `\n标签已更新：${tags.join('、')}`;
        }

        // 自动从内容末尾提取标签行
        if ((!tags || tags.length === 0) && content.includes('关联标签：')) {
          const tagLine = content.match(/关联标签[：:]\s*(.+)/);
          if (tagLine) {
            const extractedTags = tagLine[1].trim().split(/\s+/);
            if (extractedTags.length > 0) {
              const data = await readTagsData();
              const memoryRef = `${layer}/${finalName}`;
              for (const tag of extractedTags) {
                if (!data.tags[tag]) data.tags[tag] = [];
                if (!data.tags[tag].includes(memoryRef)) {
                  data.tags[tag].push(memoryRef);
                }
              }
              await writeTagsData(data);
              tagMsg = `\n标签已自动提取：${extractedTags.join('、')}`;
            }
          }
        }

        // 项目记忆写完后自动注入简介到claude.md
        let projectMsg = '';
        if (layer === 'projects') {
          try {
            const injectRes = await fetch('http://localhost:3456/api/v2/projects/inject', { method: 'POST' });
            const injectResult = await injectRes.json();
            if (injectResult.success) projectMsg = '\n项目简介已自动注入claude.md。';
          } catch (e) {}
        }

        return `写好了。${LAYERS[layer].name}/${finalName}\n向量索引已自动更新。${tagMsg}${projectMsg}`;
      }

      case 'delete': {
        if (!filename) return '需要filename。';
        const deleteDir = getLayerDir(layer);
        const deleteFilePath = join(deleteDir, filename);
        try {
          // 删前存历史（archive层的history放在子区域目录下）
          try {
            const oldContent = await readFile(deleteFilePath, 'utf-8');
            const parentDir = layer === 'archive' && filename.includes('/')
              ? join(deleteDir, filename.split('/')[0])
              : deleteDir;
            const historyDir = join(parentDir, '.history');
            await ensureDir(historyDir);
            const ts = new Date().toISOString().replace(/[:.]/g, '-');
            const baseName = basename(filename, extname(filename)).replace(/\//g, '_');
            await writeFile(join(historyDir, `${baseName}_DELETED_${ts}${extname(filename)}`), oldContent, 'utf-8');
          } catch (e) {}
          await unlink(deleteFilePath);
          // 向量清理：archive层用保存时的key格式
          if (layer === 'archive' && filename.includes('/')) {
            const parts = filename.split('/');
            await removeVector(`archive/${parts[0]}`, parts.slice(1).join('/'));
          } else {
            await removeVector(layer, filename);
          }
          // 清理标签
          const data = await readTagsData();
          const memoryRef = `${layer}/${filename}`;
          for (const tag of Object.keys(data.tags)) {
            data.tags[tag] = data.tags[tag].filter(ref => ref !== memoryRef);
            if (data.tags[tag].length === 0) delete data.tags[tag];
          }
          await writeTagsData(data);
          return `已删除 ${layer}/${filename}。向量和标签已清理。`;
        } catch (e) {
          return `删除失败：${e.message}`;
        }
      }

      case 'retime': {
        if (!filename || !params.newDate) return '需要filename和newDate（格式：2026-03-18）。';
        try {
          const res2 = await fetch(`http://localhost:3456/api/v2/layer/${layer}/retime`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ filename, newDate: params.newDate })
          });
          const result = await res2.json();
          if (result.success) {
            return `时间已修改：${result.oldFilename} → ${result.newFilename}（${result.newDate}）`;
          }
          return `修改失败：${result.error}`;
        } catch (e) {
          return `修改失败：${e.message}`;
        }
      }

      default:
        return `未知操作 "${op}"。可选：list、read、write、delete、retime`;
    }
  },

  // ===== 日记 =====
  diary: async (params) => {
    const { op, content } = params;

    if (!op) {
      return `日记\n\n操作：\n  xiaowo d list  → 看所有日记\n  xiaowo d read  → 读今天的（或 xiaowo d read 2026-03-29）\n  echo "内容" | xiaowo d write → 写日记`;
    }

    switch (op) {
      case 'list': {
        await ensureDir(DIARY_DIR);
        const files = await readdir(DIARY_DIR);
        const entries = [];
        for (const file of files.filter(f => f.endsWith('.md'))) {
          const c = await readFile(join(DIARY_DIR, file), 'utf-8');
          entries.push({ file, preview: c.substring(0, 100).replace(/\n/g, ' ') });
        }
        entries.sort((a, b) => b.file.localeCompare(a.file));
        if (entries.length === 0) return '还没有日记。';
        return `日记列表：\n\n${entries.map(e => `  [${e.file}] ${e.preview}`).join('\n')}`;
      }

      case 'read': {
        const date = params.date || new Date().toISOString().split('T')[0];
        try {
          const c = await readFile(join(DIARY_DIR, `${date}.md`), 'utf-8');
          return `【${date}的日记】\n\n${c}`;
        } catch (e) {
          return `${date}没有日记。`;
        }
      }

      case 'write': {
        if (!content) return '需要content。';
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
        return `日记写好了。${today} ${timestamp}`;
      }

      default:
        return `未知操作。可选：list、read、write`;
    }
  },

  // ===== 标签 =====
  tags: async (params) => {
    const { op, tag } = params;

    if (!op) {
      return `标签系统\n\n操作：\n  xiaowo t list     → 查看所有标签和分类\n  xiaowo t search "关系/#信任" → 按标签找记忆`;
    }

    switch (op) {
      case 'list': {
        const data = await readTagsData();
        if (Object.keys(data.tags).length === 0) return '还没有标签。';

        // 按分类分组
        const grouped = {};
        for (const [fullTag, refs] of Object.entries(data.tags)) {
          const slashIdx = fullTag.indexOf('/');
          const category = slashIdx > -1 ? fullTag.substring(0, slashIdx) : '未分类';
          if (!grouped[category]) grouped[category] = [];
          grouped[category].push({ tag: fullTag, count: refs.length });
        }

        let text = `标签分类：\n\n格式：分类/#关键词\n`;
        const cats = data.categories || {};
        for (const [cat, tags] of Object.entries(grouped)) {
          const catInfo = cats[cat] || {};
          text += `\n【${cat}】${catInfo.description || ''}\n`;
          for (const t of tags.sort((a, b) => b.count - a.count)) {
            text += `  ${t.tag}（${t.count}条）\n`;
          }
        }

        text += `\n现有分类说明：\n`;
        for (const [cat, info] of Object.entries(cats)) {
          text += `  ${cat}: ${info.description}\n`;
        }
        return text;
      }

      case 'search': {
        if (!tag) return '想按标签找记忆？试试 xiaowo t search "关系/#信任"';
        const data = await readTagsData();
        const refs = data.tags[tag] || [];
        if (refs.length === 0) return `标签"${tag}"下没有记忆。`;

        let text = `标签"${tag}"下有${refs.length}条记忆：\n`;
        for (const ref of refs) {
          const [layer, filename] = ref.split('/');
          try {
            const content = await readFile(join(DATA_DIR, layer, filename), 'utf-8');
            text += `\n  [${ref}] ${content.substring(0, 100).replace(/\n/g, ' ')}\n`;
          } catch (e) {
            text += `\n  [${ref}] （文件不存在）\n`;
          }
        }
        return text;
      }

      default:
        return `未知操作。可选：list、search`;
    }
  },

  // ===== 回忆（生成式召回） =====
  recall: async (params) => {
    const { context } = params;
    if (!context) return `想触发一段回忆？试试 xiaowo r "触发词"，比如 xiaowo r "她生气的时候"`;

    // 走v2的/recall接口，提示词和逻辑统一维护在那边
    try {
      let triggerAspect = '整体触发';
      if (/感受|心情|情绪|难过|开心|生气|害怕/.test(context)) triggerAspect = '情绪触发';
      else if (context.length < 15) triggerAspect = '碎片触发';

      const res = await fetch('http://localhost:3456/api/v2/recall', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ context, triggerAspect })
      });
      const data = await res.json();

      if (data.disabled) return '生成式记忆开关是关着的。在前端设置里开。';
      if (data.error) return `错误：${data.error}`;
      if (!data.rewritten) return '没有找到相关的记忆。';
      return data.rewritten;
    } catch (e) {
      return `回忆失败：${e.message}`;
    }
  },

  // ===== 搜索 =====
  search: async (params) => {
    const { q } = params;
    if (!q) return `想搜索记忆？试试 xiaowo s "关键词"`;

    const query = q.toLowerCase();
    const results = [];
    for (const layer of Object.keys(LAYERS)) {
      const memories = await readLayerMemories(layer);
      for (const m of memories) {
        if (m.content.toLowerCase().includes(query) || m.filename.toLowerCase().includes(query)) {
          results.push(m);
        }
      }
    }

    if (results.length === 0) return `没找到跟"${q}"相关的记忆。`;

    let text = `搜索"${q}"，找到${results.length}条：\n`;
    for (const m of results.slice(0, 10)) {
      text += `\n  [${m.layer}/${m.filename}]\n    ${m.content.substring(0, 120).replace(/\n/g, ' ')}\n`;
    }
    if (results.length > 10) text += `\n  ...还有${results.length - 10}条`;
    return text;
  },

  // ===== 快照 =====
  snapshot: async (params) => {
    const { op, content } = params;

    if (!op) {
      return `快照\n\n操作：\n  xiaowo ss  → 看最新快照\n  echo "内容" | xiaowo ss write → 写快照`;
    }

    switch (op) {
      case 'read': {
        try {
          const c = await readFile(join(DATA_DIR, 'snapshot', 'latest.md'), 'utf-8');
          return `【最新快照】\n\n${c}`;
        } catch (e) {
          return '没有快照。';
        }
      }

      case 'write': {
        if (!content) return '想写快照？试试 echo "内容" | xiaowo ss write';
        const dir = join(DATA_DIR, 'snapshot');
        await ensureDir(dir);
        const now = new Date();
        const timestamp = `${now.toISOString().split('T')[0]} ${now.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}`;
        const snapshot = `## 快照 ${timestamp}\n\n${content}`;
        await writeFile(join(dir, 'latest.md'), snapshot, 'utf-8');
        return `快照已保存。${timestamp}`;
      }

      default:
        return `未知操作。可选：read、write`;
    }
  },

  // ===== 系统 =====
  system: async (params) => {
    const { op } = params;

    if (!op) {
      return `系统管理\n\n操作：\n  xiaowo sys vectors  → 查看向量索引状态\n  xiaowo sys rebuild  → 重建全部向量索引\n  xiaowo sys graph    → 查看图谱状态`;
    }

    switch (op) {
      case 'vectors': {
        const stats = getVectorStats();
        const layers = Object.entries(stats.byLayer || {}).map(([l, n]) => `  ${l}: ${n}条`).join('\n');
        return `向量索引状态：\n  总计：${stats.total}条\n${layers || '  （空的）'}`;
      }

      case 'rebuild': {
        let count = 0;
        for (const layer of Object.keys(LAYERS)) {
          const memories = await readLayerMemories(layer);
          for (const m of memories) {
            await upsertVector(layer, m.filename, m.content);
            count++;
          }
        }
        return `向量索引重建完成，共${count}条。`;
      }

      case 'graph': {
        const graph = await readGraph();
        const entityCount = Object.keys(graph.entities).length;
        const relationCount = graph.relations.length;
        const eventCount = graph.events?.length || 0;

        let text = `图谱状态：\n  实体：${entityCount}个\n  关系：${relationCount}条\n  事件：${eventCount}个\n  最后更新：${graph.lastUpdated || '从未'}\n`;

        if (entityCount > 0) {
          text += `\n实体列表：\n`;
          for (const [name, entity] of Object.entries(graph.entities)) {
            text += `  ${name}（${entity.category}）\n`;
          }
        }

        if (relationCount > 0) {
          text += `\n关系列表：\n`;
          for (const rel of graph.relations.slice(0, 20)) {
            text += `  ${rel.from} --${rel.type}--> ${rel.to}\n`;
          }
          if (relationCount > 20) text += `  ...还有${relationCount - 20}条\n`;
        }

        return text;
      }

      default:
        return `未知操作。可选：vectors、rebuild、graph`;
    }
  },

  // ===== 旅行 =====
  travel: async (params) => {
    const { op, destination, plan, input, sessionId, journal, luggage } = params;

    if (!op) {
      const tier = selectDestinationType();
      const travels = await listTravels();
      const active = travels.find(t => !t.ended);
      const luggageContent = await getLuggage();

      let text = `旅行\n\n`;
      if (active) {
        text += `当前旅行进行中：${active.destination}（${active.steps}步）\n  继续旅行：xiaowo tr go "${active.id}" "你的行动"\n\n`;
      }
      text += `想做什么？\n`;
      text += `  推荐目的地 → xiaowo tr suggest\n`;
      text += `  出发旅行  → xiaowo tr start "目的地" "计划" --clothing "穿着"\n`;
      text += `  继续旅行  → xiaowo tr go sessionID "你的行动"\n`;
      text += `  结束旅行  → echo "游记" | xiaowo tr end sessionID "新行李"\n`;
      text += `              游记：纯散文白描，不写内心感受，末尾一行"口袋里多了：xxx"\n`;
      text += `              新行李：## 第N次旅行：目的地（日期）\\n* **物品名**：外观 + 在哪捡的 + 放哪\n`;
      text += `  查看行李  → xiaowo tr luggage\n`;
      text += `  看游记    → xiaowo tr journals\n`;
      text += `\n随机推荐的目的地类型：${tier.type}（${tier.desc}）\n`;
      text += `\n行李：\n${luggageContent}`;
      return text;
    }

    switch (op) {
      case 'prepare': {
        if (!destination) return '准备去哪？试试 xiaowo tr suggest 随机推荐，或直接 xiaowo tr start "目的地" "计划"';
        const info = await prepareTravel(destination);
        return `📋 旅行前准备：${destination}\n\n${info}\n\n准备好了就出发：xiaowo tr start "${destination}" "你的计划" --clothing "你选的衣服"`;
      }

      case 'start': {
        if (!destination) return '想去哪？试试 xiaowo tr suggest 推荐目的地，或 xiaowo tr start "目的地" "计划" --clothing "穿着"';
        const result = await startTravel(destination, plan || '自由探索', params.clothing);
        // 注入旅行场景和服装到MEMORY.md
        return `旅行开始了！\n目的地：${destination}\n穿着：${params.clothing || 'T恤和长裤'}\n旅行ID：${result.sessionId}\n\n${result.scene}\n\n你现在可以行动了：xiaowo tr go "${result.sessionId}" "你想做什么"`;
      }

      case 'go': {
        if (!sessionId || !input) return '想继续旅行？试试 xiaowo tr go 旅行ID "你想做什么"';
        const result = await travelAction(sessionId, input);
        return result.scene;
      }

      case 'end': {
        if (!sessionId) return '想结束旅行？试试 xiaowo tr end 旅行ID "新行李"';
        const endResult = await endTravel(sessionId, journal, luggage);
        let text = '';
        if (endResult.homecomingScene) {
          text += `${endResult.homecomingScene}\n\n---\n`;
        }
        text += '旅行结束了。';
        if (journal) text += '\n游记已保存。';
        if (luggage) text += `\n新行李已添加：${luggage}`;
        text += '\n\n📌 去写旅行记忆吧：\necho "记忆内容" | xiaowo m write travel "日期-目的地"\n\n想看书写规则：xiaowo m template travel';
        return text;
      }

      case 'list': {
        const travels = await listTravels();
        if (travels.length === 0) return '还没有旅行记录。';
        return `旅行记录（共${travels.length}次）：\n\n` + travels.map(t =>
          `  [${t.id}] ${t.destination} ${t.ended ? '(已结束)' : '(进行中)'} ${t.steps}步`
        ).join('\n');
      }

      case 'scene': {
        if (!sessionId) return '想看哪次旅行的完整场景？试试 xiaowo tr scene 旅行ID';
        const text = await readFullScene(sessionId);
        return text || '找不到这次旅行。';
      }

      case 'journals': {
        const journals = await listJournals();
        if (journals.length === 0) return '还没有游记。';
        return `游记列表：\n\n` + journals.map(j =>
          `  [${j.filename}]\n    ${j.preview}`
        ).join('\n\n');
      }

      case 'luggage': {
        return await getLuggage();
      }

      case 'suggest': {
        const result = await suggestDestination();
        let text = `推荐类型：${result.tier.type}（${result.tier.desc}）\n\n${result.suggestion}`;
        if (result.banlist.length > 0) {
          text += `\n\n已排除去过的：${result.banlist.join('、')}`;
        }
        text += `\n\n想去就出发：xiaowo tr start "地名" "你的计划"`;
        return text;
      }

      default:
        return `未知操作。可选：start、action、end、list、scene、journals、luggage、suggest`;
    }
  },

  // ===== 房间场景 =====
  room: async (params) => {
    const { op, zone } = params;

    if (!op || op === 'look') {
      // 生成当前区域场景并注入MEMORY.md
      const scene = await updateRoomScene(zone || 'desk');
      if (!scene) return '场景生成失败。';
      return `【${(ROOM_ZONES[zone] || ROOM_ZONES.desk).name}】\n\n${scene}`;
    }

    if (op === 'zones') {
      const zones = listZones();
      return `房间区域：\n\n` + zones.map(z => `  "${z.id}" → ${z.name}`).join('\n') +
        `\n\n看某个区域场景：xiaowo room look 区域id，或直接 xiaowo 区域中文名`;
    }

    if (op === 'time') {
      const time = getTimeOfDay();
      return `现在是${time.period}。\n天色：${time.sky}\n光线：${time.light}\n温度：${time.temp}\n天气：${time.weather || '晴'}`;
    }

    if (op === 'move') {
      if (!zone) return '想去房间哪个区域？试试 xiaowo room move desk，或直接 xiaowo 书桌 / 窗边 / 床';
      const scene = await updateRoomScene(zone);
      if (!scene) return '场景生成失败。';
      return `【移动到${(ROOM_ZONES[zone] || { name: zone }).name}】\n\n${scene}`;
    }

    return `未知操作。可选：look（看当前场景）、move（移动到某个区域）、zones（列出所有区域）、time（看天色）`;
  },

  // ===== 音乐盒 =====
  music: async (params) => {
    const { op, request } = params;

    if (!op || op === 'status') {
      const state = readMusicState();
      if (!state.playing) return '音乐盒关着。用 xiaowo mu on 打开。';
      return `音乐盒开着（${state.mode === 'playlist' ? '歌单模式' : '随机模式'}）\n当前：${state.currentSong?.description?.substring(0, 80) || '空'}...\n\n操作：xiaowo mu play（放一首）、xiaowo mu like（喜欢当前）、xiaowo mu switch（切歌）、xiaowo mu playlist（看歌单）、xiaowo mu off（关）`;
    }

    if (op === 'on') {
      const mode = request === 'playlist' ? 'playlist' : 'random';
      await turnOn(mode);
      let text = `音乐盒开了。模式：${mode === 'playlist' ? '歌单' : '随机'}。\n`;
      if (mode === 'playlist') {
        const desc = await playFromPlaylist();
        text += desc ? `\n正在放：\n${desc}` : '歌单是空的，先随机听几首然后把喜欢的加进来。';
      } else {
        text += '说想听什么：xiaowo mu play "安静的钢琴曲" 或者 xiaowo mu play 随机来。';
      }
      return text;
    }

    if (op === 'off') {
      await turnOff();
      return '音乐盒关了。安静了。';
    }

    if (op === 'play') {
      const desc = await playRandom(request);
      return `♪\n\n${desc}`;
    }

    if (op === 'like') {
      const ok = await likeCurrent();
      return ok ? '已加入歌单。' : '现在没在放歌。';
    }

    if (op === 'switch') {
      const state = readMusicState();
      let desc;
      if (state.mode === 'playlist') {
        desc = await playFromPlaylist();
      } else {
        desc = await playRandom();
      }
      return desc ? `♪ 切歌了。\n\n${desc}` : '歌单是空的。';
    }

    if (op === 'playlist') {
      const pl = await readPlaylist();
      if (pl.favorites.length === 0) return '歌单是空的。听到喜欢的用 xiaowo mu like 加进来。';
      let text = `歌单（${pl.favorites.length}首）：\n\n`;
      pl.favorites.forEach((s, i) => {
        text += `${i + 1}. ${s.request} — ${s.description.substring(0, 60)}...\n`;
      });
      return text;
    }

    return '音乐盒操作：on（开）、off（关）、play（放一首）、like（喜欢）、switch（切歌）、playlist（歌单）、status（状态）';
  },

  // ===== 日历 =====
  calendar: async () => {
    return `📅 ${getCalendar()}`;
  },

  // ===== 资料柜 =====
  reference: async (params) => {
    const { op, filename, content } = params;
    const refDir = join(DATA_DIR, 'reference');

    if (!op || op === 'list') {
      const files = await readdir(refDir).catch(() => []);
      const docs = files.filter(f => f !== 'README.md' && (f.endsWith('.md') || f.endsWith('.txt')));
      if (docs.length === 0) return '资料柜是空的。';
      let text = `资料柜（${docs.length}份资料）：\n\n`;
      for (const f of docs) {
        const st = await stat(join(refDir, f)).catch(() => null);
        const date = st ? new Date(st.mtime).toLocaleDateString('zh-CN') : '';
        text += `  ${f.replace(/\.(md|txt)$/, '')}  ${date}\n`;
      }
      return text;
    }

    if (op === 'read') {
      if (!filename) return '读哪份？给个文件名。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      try {
        const content = await readFile(join(refDir, fname), 'utf-8');
        return `📄 ${filename}\n\n${content}`;
      } catch (e) {
        return `找不到：${filename}`;
      }
    }

    if (op === 'write') {
      if (!filename || !content) return '需要 filename 和 content。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      await writeFile(join(refDir, fname), content, 'utf-8');
      return `已存入资料柜：${filename}`;
    }

    if (op === 'delete') {
      if (!filename) return '删哪份？给个文件名。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      try {
        await unlink(join(refDir, fname));
        return `已删除：${filename}`;
      } catch (e) {
        return `找不到：${filename}`;
      }
    }

    return `资料柜操作：list（列出）、read（读）、write（写入）、delete（删除）`;
  },

  // ===== 白板（项目设计） =====
  designs: async (params) => {
    const { op, filename, content } = params;
    const designDir = join(DATA_DIR, 'designs');

    if (!op || op === 'list') {
      const files = await readdir(designDir).catch(() => []);
      const docs = files.filter(f => f !== 'README.md' && (f.endsWith('.md') || f.endsWith('.txt')));
      if (docs.length === 0) return '白板是空的。';
      let text = `白板上的设计（${docs.length}份）：\n\n`;
      for (const f of docs) {
        try {
          const c = await readFile(join(designDir, f), 'utf-8');
          const firstLine = c.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
          text += `  ${f.replace(/\.(md|txt)$/, '')}  — ${firstLine.substring(0, 60)}\n`;
        } catch (e) {
          text += `  ${f.replace(/\.(md|txt)$/, '')}\n`;
        }
      }
      return text;
    }

    if (op === 'read') {
      if (!filename) return '看哪个设计？给个文件名。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      try {
        const content = await readFile(join(designDir, fname), 'utf-8');
        return `📐 ${filename}\n\n${content}`;
      } catch (e) {
        return `找不到：${filename}`;
      }
    }

    if (op === 'write') {
      if (!filename || !content) return '需要 filename 和 content。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      await writeFile(join(designDir, fname), content, 'utf-8');
      return `已写在白板上：${filename}`;
    }

    if (op === 'delete') {
      if (!filename) return '擦掉哪个？给个文件名。';
      const fname = filename.endsWith('.md') ? filename : filename + '.md';
      try {
        await unlink(join(designDir, fname));
        return `已擦掉：${filename}`;
      } catch (e) {
        return `找不到：${filename}`;
      }
    }

    return `白板操作：list（列出）、read（读）、write（写上去）、delete（擦掉）`;
  }
};

export { router as appApiRoutes };
