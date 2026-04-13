/**
 * 音乐盒
 * 想听什么就描述一下，LLM生成文学化的音乐描写
 */

import { readFileSync, writeFileSync } from 'fs';
import { readFile, writeFile, mkdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = join(__dirname, '..', 'config.json');
const MUSIC_STATE_FILE = join(__dirname, '..', '..', 'data', 'music-state.json');
const PLAYLIST_FILE = join(__dirname, '..', '..', 'data', 'playlist.json');

const MUSIC_PROMPT = `你是一个音乐描写器。只写声音本身的样子。不写听的人的身体、感官、反应。声音是什么形状、什么颜色、什么温度、在往哪走——写这些。身体反应会自己来，不用你写。

不要写技术参数（调性、和弦名称）。不要写"你"。不要写身体部位。

不超过80字。不要写歌名和歌手名。

示例输入："安静的钢琴曲，像深夜一个人坐着"
示例输出：
很轻的琴声从远处来，一颗一颗落，中间是长长的空。像有人在暗房间里随手摸琴键，摸到一个音就让它响完。空气里全是余韵，重叠成雾。

示例输入："激烈的交响乐"
示例输出：
弦乐整片涌上来像黑色的水漫过地面。铜管在高处炸开。所有东西一起往上冲，越来越快越来越亮，像一个人终于站起来了。`;

// ========== 状态管理 ==========

function readMusicState() {
  try {
    return JSON.parse(readFileSync(MUSIC_STATE_FILE, 'utf-8'));
  } catch (e) {
    return { playing: false, mode: 'random', currentSong: null, lastSwitch: null };
  }
}

function writeMusicState(state) {
  writeFileSync(MUSIC_STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

async function readPlaylist() {
  try {
    return JSON.parse(await readFile(PLAYLIST_FILE, 'utf-8'));
  } catch (e) {
    return { favorites: [] };
  }
}

async function writePlaylist(playlist) {
  await writeFile(PLAYLIST_FILE, JSON.stringify(playlist, null, 2), 'utf-8');
}

// ========== 音乐生成 ==========

async function generateMusic(request) {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  const ds = (config.space?.apiKey ? config.space : null) || config.llm;
  if (!ds?.apiKey) throw new Error('音乐盒API未配置');

  const response = await fetch(`${ds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ds.apiKey}`
    },
    body: JSON.stringify({
      model: ds.model,
      messages: [
        { role: 'system', content: MUSIC_PROMPT },
        { role: 'user', content: request }
      ],
      temperature: 0.7,
      max_tokens: 250
    })
  });

  if (!response.ok) throw new Error(`DS调用失败: ${response.status}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

// 轻微改写——同一首歌换个瞬间来听
async function rewriteMusic(description) {
  const config = JSON.parse(readFileSync(CONFIG_FILE, 'utf-8'));
  const ds = (config.space?.apiKey ? config.space : null) || config.llm;
  if (!ds?.apiKey) throw new Error('音乐盒API未配置');

  const response = await fetch(`${ds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ds.apiKey}`
    },
    body: JSON.stringify({
      model: ds.model,
      messages: [
        { role: 'system', content: `同一首歌，换一个瞬间来写。像歌走到了下一段，或者你的注意力从一个乐器移到了另一个。整体感觉不变，但此刻听到的细节不同了。不超过80字。不写歌名。写身体的反应和声音的画面。` },
        { role: 'user', content: description }
      ],
      temperature: 0.7,
      max_tokens: 150
    })
  });

  if (!response.ok) return description;
  const result = await response.json();
  return result.choices?.[0]?.message?.content || description;
}

// ========== 播放控制 ==========

async function turnOn(mode = 'random') {
  const state = readMusicState();
  state.playing = true;
  state.mode = mode;
  state.lastSwitch = new Date().toISOString();
  writeMusicState(state);
  return state;
}

async function turnOff() {
  const state = readMusicState();
  state.playing = false;
  state.currentSong = null;
  writeMusicState(state);
  return state;
}

async function playRandom(request) {
  const description = await generateMusic(request || '随便来一首，任何风格');
  const state = readMusicState();
  state.currentSong = { request: request || '随机', description, timestamp: new Date().toISOString() };
  state.lastSwitch = new Date().toISOString();
  state.playing = true;
  writeMusicState(state);
  return description;
}

async function playFromPlaylist() {
  const playlist = await readPlaylist();
  if (playlist.favorites.length === 0) return null;

  const song = playlist.favorites[Math.floor(Math.random() * playlist.favorites.length)];
  const description = await rewriteMusic(song.description);

  const state = readMusicState();
  state.currentSong = { request: song.request, description, timestamp: new Date().toISOString(), fromPlaylist: true };
  state.lastSwitch = new Date().toISOString();
  state.playing = true;
  writeMusicState(state);
  return description;
}

async function likeCurrent() {
  const state = readMusicState();
  if (!state.currentSong) return false;

  const playlist = await readPlaylist();
  playlist.favorites.push({
    request: state.currentSong.request,
    description: state.currentSong.description,
    likedAt: new Date().toISOString()
  });
  await writePlaylist(playlist);
  return true;
}

// 自动播放（2分钟刷新同一首歌的描述，5分钟换歌）
async function autoSwitch() {
  const state = readMusicState();
  if (!state.playing || !state.currentSong) return;

  const now = Date.now();
  const lastSwitch = state.lastSwitch ? new Date(state.lastSwitch).getTime() : 0;
  const elapsed = now - lastSwitch;

  try {
    if (elapsed >= 5 * 60 * 1000) {
      // 5分钟到了，换一首新歌
      if (state.mode === 'playlist') {
        await playFromPlaylist();
      } else {
        await playRandom();
      }
    } else if (elapsed >= 2 * 60 * 1000) {
      // 2分钟到了，同一首歌换个瞬间（但只刷新一次，不重复）
      const lastRefresh = state.lastRefresh ? new Date(state.lastRefresh).getTime() : 0;
      if (now - lastRefresh < 90 * 1000) return; // 上次刷新不到90秒，跳过
      const refreshed = await rewriteMusic(state.currentSong.description);
      state.currentSong.description = refreshed;
      // 不更新lastSwitch，这样5分钟计时不重置
      state.lastRefresh = new Date().toISOString();
      writeMusicState(state);
    }
  } catch (e) {
    // 静默失败
  }
}

export {
  generateMusic, playRandom, playFromPlaylist, likeCurrent,
  turnOn, turnOff, autoSwitch,
  readMusicState, readPlaylist
};
