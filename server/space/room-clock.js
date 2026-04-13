/**
 * 房间时钟系统
 * - 8次天色转换
 * - 光线每20分钟渐变
 * - 一天4次随机天气
 * - 天色/光线/天气变化时自动重新生成场景
 */

import { readFileSync, writeFileSync } from 'fs';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const STATE_FILE = join(__dirname, '..', '..', 'data', 'room-state.json');

// ========== 8次天色转换 ==========

const SKY_PHASES = [
  { hour: 5,  name: '黎明',   sky: '天刚亮，东边一线鱼肚白，其余还是深蓝', temp: '凉' },
  { hour: 7,  name: '早晨',   sky: '浅蓝偏白的早晨光，云边发亮', temp: '清爽' },
  { hour: 9,  name: '上午',   sky: '上午的天空明亮，北窗散射光均匀铺开', temp: '舒适' },
  { hour: 12, name: '中午',   sky: '正午天空白得有点刺，光线最亮', temp: '暖' },
  { hour: 14, name: '下午',   sky: '下午的光开始变柔变暖，有了角度', temp: '微暖' },
  { hour: 17, name: '傍晚',   sky: '天色从浅蓝转灰蓝偏紫，对面楼窗户开始亮灯', temp: '凉' },
  { hour: 19, name: '晚上',   sky: '天黑了，城市灯光映在低云上，暗橙色', temp: '凉' },
  { hour: 22, name: '深夜',   sky: '深夜，窗外很暗，偶尔有车灯扫过', temp: '冷' },
];

// ========== 光线渐变（每20分钟一个状态） ==========

const LIGHT_TRANSITIONS = {
  '黎明': [
    '天还没全亮，房间里只有窗外透进来的灰蓝微光，什么都是模糊的轮廓',
    '光线慢慢渗进来，能看清桌面上的东西了但颜色还是灰的',
    '窗帘缝里漏进来一道浅光，打在墙上像一条淡蓝的带子',
  ],
  '早晨': [
    '自然光从北窗均匀散进来，台灯没开，房间是冷白色的',
    '光线越来越明，桌面上的灰尘都看得见了',
    '早晨最清澈的光，所有东西的轮廓都很干净',
  ],
  '上午': [
    '散射光铺满桌面，不刺眼，看书写字最舒服的光线',
    '光线稳定明亮，玻璃瓶折出一小段彩虹落在墙上',
    '上午的光开始偏暖了一点点，窗台上的东西有了浅浅的影子',
  ],
  '中午': [
    '一天最亮的时候，北窗虽然没有直射但足够亮，台灯不需要开',
    '光线白得有些平，东西没什么影子，像被漂过一遍',
    '中午的光开始往下走了，能感觉到角度在变',
  ],
  '下午': [
    '光线变柔了，从白变成微微带金的暖色',
    '下午的光在变暗，可能需要开台灯了',
    '天色明显变沉了，台灯亮起来，暖黄色和窗外灰蓝色混在一起',
  ],
  '傍晚': [
    '台灯亮着，窗外天色从蓝变成灰紫，两种光在房间里交汇',
    '对面楼的窗户亮了几扇，像地上的星星',
    '天几乎全暗了，只剩天边一条深紫色的光带在消退',
  ],
  '晚上': [
    '只有台灯，暖黄色光圈罩着桌面，其他地方都暗',
    '窗外城市的光映在云上，远处偶尔有车灯的光痕扫过',
    '夜深了一些，外面的声音在变少，空气在变凉',
  ],
  '深夜': [
    '台灯是唯一的光源，光圈很小很暖，周围全是暗的',
    '窗外偶尔有车灯扫过天花板，像鱼在深水里游',
    '最安静的时候，能听到加湿器嗡嗡的声音和自己的呼吸',
  ],
};

// ========== 天气系统 ==========

const WEATHER_TYPES = [
  { type: 'clear', desc: '晴，天空干净' },
  { type: 'clear_windy', desc: '晴天大风，天是蓝的但风很大' },
  { type: 'cloudy', desc: '多云，云在窗外慢慢移动，光线一会亮一会暗' },
  { type: 'overcast', desc: '阴天，天色灰沉沉的，光线平淡' },
  { type: 'drizzle', desc: '毛毛雨，窗玻璃上凝着细密的水珠' },
  { type: 'light_rain', desc: '小雨，雨点打在窗玻璃上，一道一道往下流' },
  { type: 'medium_rain', desc: '中雨，雨声均匀持续，窗外的东西都带着水光' },
  { type: 'heavy_rain', desc: '大雨，雨声哗啦啦的，窗玻璃全是水，对面楼看不清了' },
  { type: 'storm', desc: '暴雨，雨砸在窗上像敲鼓，偶尔有雷声从远处滚过来' },
  { type: 'foggy', desc: '起雾了，对面楼模糊成一个影子' },
  { type: 'windy', desc: '起风了，窗帘被吹得鼓起来，能听到风声' },
];

// 天气转换矩阵：当前天气→下一次可能变成什么（0.4概率不变）
const WEATHER_TRANSITIONS = {
  clear: ['clear', 'clear_windy', 'cloudy'],
  clear_windy: ['clear_windy', 'clear', 'cloudy', 'windy'],
  cloudy: ['cloudy', 'overcast', 'clear', 'drizzle'],
  overcast: ['overcast', 'cloudy', 'drizzle', 'light_rain', 'foggy'],
  drizzle: ['drizzle', 'light_rain', 'overcast', 'cloudy'],
  light_rain: ['light_rain', 'medium_rain', 'drizzle', 'overcast'],
  medium_rain: ['medium_rain', 'heavy_rain', 'light_rain'],
  heavy_rain: ['heavy_rain', 'storm', 'medium_rain'],
  storm: ['storm', 'heavy_rain', 'medium_rain'],
  foggy: ['foggy', 'overcast', 'cloudy'],
  windy: ['windy', 'clear_windy', 'cloudy', 'overcast'],
};

// ========== 状态管理 ==========

function readState() {
  try {
    return JSON.parse(readFileSync(STATE_FILE, 'utf-8'));
  } catch (e) {
    return {
      currentZone: 'desk',
      lastSkyPhase: '',
      lastLightIndex: -1,
      weather: 'clear',
      weatherDesc: '晴，天空干净',
      nextWeatherChanges: [],
      lastSceneUpdate: null,
    };
  }
}

function writeState(state) {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// ========== 时间计算 ==========

function getCurrentSkyPhase() {
  const hour = new Date().getHours();
  let phase = SKY_PHASES[SKY_PHASES.length - 1]; // 默认深夜
  for (let i = SKY_PHASES.length - 1; i >= 0; i--) {
    if (hour >= SKY_PHASES[i].hour) {
      phase = SKY_PHASES[i];
      break;
    }
  }
  return phase;
}

function getCurrentLightIndex() {
  // 每20分钟一个light状态，一个phase内有3个状态
  const minutes = new Date().getMinutes();
  return Math.floor(minutes / 20); // 0, 1, 2
}

function getCurrentLight() {
  const phase = getCurrentSkyPhase();
  const index = getCurrentLightIndex();
  const lights = LIGHT_TRANSITIONS[phase.name] || LIGHT_TRANSITIONS['深夜'];
  return lights[Math.min(index, lights.length - 1)];
}

// ========== 天气调度 ==========

function initDailyWeather() {
  // 生成今天的4个随机天气变换时刻
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const changes = [];

  // 在6:00-22:00之间随机选4个时间点
  const slots = [];
  for (let h = 6; h <= 21; h++) {
    slots.push(h);
  }
  // 打乱后取前4个
  for (let i = slots.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [slots[i], slots[j]] = [slots[j], slots[i]];
  }
  const selectedHours = slots.slice(0, 4).sort((a, b) => a - b);

  // 用转换矩阵生成天气序列（每次基于上一次天气转换）
  let currentType = 'clear';
  for (const h of selectedHours) {
    const minute = Math.floor(Math.random() * 60);
    const time = new Date(today);
    time.setHours(h, minute);

    // 0.4概率不变，0.6概率从转换矩阵里随机选
    let nextType;
    if (Math.random() < 0.4) {
      nextType = currentType;
    } else {
      const transitions = WEATHER_TRANSITIONS[currentType] || ['clear', 'cloudy'];
      nextType = transitions[Math.floor(Math.random() * transitions.length)];
    }
    const weather = WEATHER_TYPES.find(w => w.type === nextType) || WEATHER_TYPES[0];
    changes.push({
      time: time.toISOString(),
      type: weather.type,
      desc: weather.desc,
      triggered: false,
    });
    currentType = nextType;
  }

  return changes;
}

function checkWeatherChange(state) {
  const now = new Date();
  const today = now.toISOString().split('T')[0];

  // 如果没有今天的天气计划或者日期变了，初始化
  if (!state.nextWeatherChanges || state.nextWeatherChanges.length === 0 ||
      !state.nextWeatherChanges[0]?.time?.startsWith(today)) {
    state.nextWeatherChanges = initDailyWeather();
    writeState(state);
  }

  // 检查是否有该触发的天气变化
  let changed = false;
  for (const change of state.nextWeatherChanges) {
    if (!change.triggered && new Date(change.time) <= now) {
      state.weather = change.type;
      state.weatherDesc = change.desc;
      change.triggered = true;
      changed = true;
    }
  }

  if (changed) writeState(state);
  return changed;
}

// ========== 场景变化检测 ==========

function checkSceneChange() {
  const state = readState();
  const currentPhase = getCurrentSkyPhase();
  const currentLightIdx = getCurrentLightIndex();

  let needsUpdate = false;
  let reason = '';

  // 天色变了
  if (state.lastSkyPhase !== currentPhase.name) {
    state.lastSkyPhase = currentPhase.name;
    needsUpdate = true;
    reason = `天色变了：${currentPhase.name}`;
  }

  // 光线变了（每20分钟）
  if (state.lastLightIndex !== currentLightIdx) {
    state.lastLightIndex = currentLightIdx;
    needsUpdate = true;
    reason = reason || `光线变了`;
  }

  // 天气变了
  if (checkWeatherChange(state)) {
    needsUpdate = true;
    reason = reason || `天气变了：${state.weatherDesc}`;
  }

  if (needsUpdate) {
    writeState(state);
  }

  return { needsUpdate, reason, state };
}

// ========== 完整的时间/天色/光线/天气信息 ==========

function getFullEnvironment() {
  const state = readState();
  const phase = getCurrentSkyPhase();
  const light = getCurrentLight();

  // 确保天气已初始化
  checkWeatherChange(state);

  return {
    period: phase.name,
    sky: phase.sky,
    light,
    temp: phase.temp,
    weather: state.weatherDesc || '晴，天空干净',
    zone: state.currentZone || 'desk',
  };
}

// 更新当前区域
function setCurrentZone(zone) {
  const state = readState();
  state.currentZone = zone;
  writeState(state);
}

export {
  checkSceneChange, getFullEnvironment, setCurrentZone,
  getCurrentSkyPhase, getCurrentLight, readState, writeState,
  SKY_PHASES, LIGHT_TRANSITIONS, WEATHER_TYPES,
};
