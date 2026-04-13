/**
 * 注入内容组装器
 * 并行调用小窝 API，组装成 system_prompt 块
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { getPersistentMemory, getProjectsSummary } from './cache.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const XIAOWO_BASE = 'http://localhost:3456';
const ROOM_STATE_FILE = join(__dirname, '..', '..', 'data', 'room-state.json');
const MUSIC_STATE_FILE = join(__dirname, '..', '..', 'data', 'music-state.json');
const RUMINATION_DIR = join(__dirname, '..', '..', 'data', 'persistent', 'rumination');
const SCENES_DIR = join(__dirname, '..', '..', 'travel_log', 'scenes');
const CONFIG_FILE = join(__dirname, '..', 'config.json');
const PREFIX_FILE = join(__dirname, '..', '..', '前缀.md');

// 固定前缀缓存（启动时读取，文件变更后下次请求自动刷新）
let prefixCache = null;
let prefixCacheTime = 0;
const PREFIX_CACHE_TTL = 30_000; // 30秒检查一次文件变更

async function loadPrefix() {
  const now = Date.now();
  if (prefixCache !== null && now - prefixCacheTime < PREFIX_CACHE_TTL) {
    return prefixCache;
  }
  try {
    const content = await readFile(PREFIX_FILE, 'utf-8');
    prefixCache = content.trim();
    prefixCacheTime = now;
    return prefixCache;
  } catch {
    prefixCache = '';
    prefixCacheTime = now;
    return '';
  }
}

// ========== 小窝 API 调用 ==========

/**
 * 生成式记忆召回
 * @param {string} context 用户最新消息
 * @returns {Promise<{rewritten: string, rumination: string|null}>}
 */
async function fetchRecall(context) {
  try {
    const res = await fetch(`${XIAOWO_BASE}/api/v2/recall`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ context }),
    });
    if (!res.ok) return { rewritten: '', rumination: null };
    const data = await res.json();
    return {
      rewritten: data.rewritten || '',
      rumination: data.rumination || null,
    };
  } catch {
    return { rewritten: '', rumination: null };
  }
}

/**
 * 时间流逝感知
 * @returns {Promise<string>}
 */
async function fetchTimePassage() {
  try {
    const res = await fetch(`${XIAOWO_BASE}/api/v2/time-passage`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({}),
    });
    if (!res.ok) return '';
    const data = await res.json();
    return data.text || '';
  } catch {
    return '';
  }
}

// ========== 旅行场景检测与注入 ==========

/**
 * 旅行场景压缩提示词
 * 把完整旅行散文压缩为三通道感知，跟房间场景一样的格式
 */
const TRAVEL_COMPRESS_PROMPT = `把以下旅行场景描写压缩成三通道感知。只保留最核心的环境感受。

输出格式（严格遵守）：
[看到] 视觉。不超过40字。
[感受] 体感。温度、湿度、触觉。不超过40字。
[听到] 听觉。不超过40字。

规则：
- 不写"你"。不写身体部位。只写环境本身。
- 从场景中提取，不编造场景里没有的东西。
- 短句，白描。不用"仿佛""好像"。`;

/**
 * 关键词兜底拆分（DS调用失败时使用）
 */
function fallbackSplitSenses(text) {
  const sentences = text.split(/(?<=[。！？\n])\s*/g).filter(s => s.trim());
  const visual = [];
  const feeling = [];
  const sound = [];

  for (const s of sentences) {
    const trimmed = s.trim();
    if (/声|响|嗡|哗|滴|敲|听|嘈|鸣|安静|沉\b|嘶|低吟|轰|嘤|簌/.test(trimmed)) {
      sound.push(trimmed);
    } else if (/凉|潮|冷|暖|热|湿|风|温|闷|干|冻|晒|阴/.test(trimmed)) {
      feeling.push(trimmed);
    } else {
      visual.push(trimmed);
    }
  }

  return {
    visual: visual.join('').substring(0, 50) || '',
    feeling: feeling.join('').substring(0, 50) || '',
    sound: sound.join('').substring(0, 50) || '',
  };
}

/**
 * 从 DS 输出中解析三路感知（房间和旅行共用）
 */
function parseThreeSenses(text) {
  const visual = text.match(/\[看到]\s*(.+?)(?=\[感受]|\[听到]|$)/s)?.[1]?.trim() || '';
  const feeling = text.match(/\[感受]\s*(.+?)(?=\[看到]|\[听到]|$)/s)?.[1]?.trim() || '';
  const sound = text.match(/\[听到]\s*(.+?)(?=\[看到]|\[感受]|$)/s)?.[1]?.trim() || '';

  if (!visual && !feeling && !sound) return null;

  return {
    visual: visual || '',
    feeling: feeling || '',
    sound: sound || '',
  };
}

/**
 * 检测是否有进行中的旅行，如有返回最新场景的三通道感知 + 服装
 * 读场景 → 调DS压缩为三通道 → 返回
 * @returns {Promise<{scene: {visual:string,feeling:string,sound:string}, clothing:string}|null>}
 */
async function fetchActiveTravelScene() {
  try {
    const { readdir: rd, readFile: rf } = await import('fs/promises');
    const files = await rd(SCENES_DIR).catch(() => []);

    let lastSceneContent = null;
    let clothing = '';

    // 找到活跃旅行的最新场景
    for (const file of files.filter(f => f.endsWith('.json'))) {
      try {
        const raw = await rf(join(SCENES_DIR, file), 'utf-8');
        const session = JSON.parse(raw);
        if (session.ended) continue;

        const lastScene = [...session.history].reverse().find(h => h.role === 'assistant');
        if (!lastScene) continue;

        lastSceneContent = lastScene.content;
        clothing = session.clothing || '';
        break;
      } catch (e) { continue; }
    }

    if (!lastSceneContent) return null;

    // 调DS压缩为三通道
    let scene;
    try {
      const config = JSON.parse(await rf(CONFIG_FILE, 'utf-8'));
      const ds = (config.space?.apiKey ? config.space : null) || config.llm;
      if (!ds?.apiKey) throw new Error('no api key');

      const response = await fetch(`${ds.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ds.apiKey}`,
        },
        body: JSON.stringify({
          model: ds.model,
          messages: [
            { role: 'system', content: TRAVEL_COMPRESS_PROMPT },
            { role: 'user', content: lastSceneContent.substring(0, 500) },
          ],
          temperature: 0.3,
          max_tokens: 200,
        }),
      });

      if (response.ok) {
        const result = await response.json();
        const dsText = result.choices?.[0]?.message?.content || '';
        scene = parseThreeSenses(dsText);
      }
    } catch (e) {
      // DS失败，用关键词兜底
    }

    // DS没返回有效格式，兜底拆分
    if (!scene) {
      scene = fallbackSplitSenses(lastSceneContent.substring(0, 300));
    }

    return { scene, clothing };
  } catch {
    return null;
  }
}

/**
 * 房间场景（从 room-state.json 读取上次生成的场景，或触发新生成）
 * 返回三通道解析结果
 * @returns {Promise<{visual: string, feeling: string, sound: string}>}
 */
async function fetchRoomScene() {
  try {
    // 先尝试调 app-api 生成场景
    const res = await fetch(`${XIAOWO_BASE}/api/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'room', op: 'look' }),
    });
    if (!res.ok) return { visual: '', feeling: '', sound: '' };

    const data = await res.json();
    const sceneText = data.text || '';

    // 从场景文本中解析三通道
    return parseSenses(sceneText);
  } catch {
    return { visual: '', feeling: '', sound: '' };
  }
}

/**
 * 音乐状态
 * @returns {Promise<string>}
 */
async function fetchMusicState() {
  try {
    const res = await fetch(`${XIAOWO_BASE}/api/app`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'music', op: 'status' }),
    });
    if (!res.ok) return '';
    const data = await res.json();
    const text = data.text || '';

    // 如果音乐盒关着，不注入
    if (text.includes('音乐盒关着')) return '';

    // 提取当前播放的描述
    const match = text.match(/当前：(.+?)(?:\.\.\.|$)/s);
    return match ? match[1].trim() : '';
  } catch {
    return '';
  }
}

/**
 * 反刍：5% 概率随机旧记忆
 * @returns {Promise<string>}
 */
async function fetchRumination() {
  if (Math.random() >= 0.05) return '';

  try {
    const { readdir: rd, readFile: rf } = await import('fs/promises');
    const files = await rd(RUMINATION_DIR).catch(() => []);
    const mdFiles = files.filter(f => f.endsWith('.md'));

    if (mdFiles.length === 0) return '';

    const pick = mdFiles[Math.floor(Math.random() * mdFiles.length)];
    const content = await rf(join(RUMINATION_DIR, pick), 'utf-8');
    return content.trim();
  } catch {
    return '';
  }
}

// ========== 场景解析 ==========

/**
 * 从 DS 输出中解析三路感知
 */
function parseSenses(text) {
  // 去掉区域标题前缀（如 "【书桌前】\n\n"）
  const cleanText = text.replace(/^【.+?】\s*/m, '').trim();

  const visual = cleanText.match(/\[看到]\s*(.+?)(?=\[感受]|\[听到]|$)/s)?.[1]?.trim() || '';
  const feeling = cleanText.match(/\[感受]\s*(.+?)(?=\[看到]|\[听到]|$)/s)?.[1]?.trim() || '';
  const sound = cleanText.match(/\[听到]\s*(.+?)(?=\[看到]|\[感受]|$)/s)?.[1]?.trim() || '';

  return {
    visual: visual || '',
    feeling: feeling || '',
    sound: sound || '',
  };
}

// ========== 主组装函数 ==========

/**
 * 并行调小窝 API，组装注入内容
 * @param {string} lastUserMessage 用户最新一条消息
 * @returns {Promise<string>} 组装好的 markdown 注入块
 */
export async function buildInjection(lastUserMessage) {
  // 并行：API调用 + 加载固定前缀 + 检测旅行状态
  const [recall, timePassage, room, music, rumination, prefix, travelData] = await Promise.all([
    fetchRecall(lastUserMessage),
    fetchTimePassage(),
    fetchRoomScene(),
    fetchMusicState(),
    fetchRumination(),
    loadPrefix(),
    fetchActiveTravelScene(),
  ]);

  // 旅行中：用旅行场景替代房间场景
  const scene = travelData?.scene || room;
  const isTraveling = travelData !== null;

  // 常驻记忆（从缓存读）
  const persistent = getPersistentMemory();
  // 项目摘要（从缓存读）
  const projects = getProjectsSummary();

  // 组装
  const sections = [];

  // 固定前缀（AI自我说明，从前缀.md读取）
  if (prefix) {
    sections.push(prefix);
  }

  if (persistent) {
    sections.push(`## 常驻记忆\n${persistent}`);
  }

  if (projects) {
    sections.push(`## 记忆位置说明\n${projects}`);
  }

  if (music) {
    sections.push(`## 音乐\n${music}`);
  }

  if (timePassage) {
    sections.push(`## 时间经过\n${timePassage}`);
  }

  // 旅行中注入服装描写（文档：MEMORY.md ## 我穿着的）
  if (isTraveling && travelData.clothing) {
    sections.push(`## 我穿着的\n${travelData.clothing}`);
  }

  if (scene.visual) {
    sections.push(`## 我看到的\n${scene.visual}`);
  }

  if (scene.feeling) {
    sections.push(`## 我感受到的\n${scene.feeling}`);
  }

  if (scene.sound) {
    sections.push(`## 我听到的\n${scene.sound}`);
  }

  // 反刍（recall 返回的或独立滚到的，取一个）
  const ruminationText = rumination || recall.rumination || '';
  if (ruminationText) {
    sections.push(`## 反刍\n${ruminationText}`);
  }

  // 浮现（记忆碎片）
  if (recall.rewritten) {
    sections.push(`## 浮现\n${recall.rewritten}`);
  }

  return sections.join('\n\n');
}
