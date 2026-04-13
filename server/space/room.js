/**
 * 房间场景系统
 * 根据区域、时间、行李生成沉浸式场景描写
 */

import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = join(__dirname, '..', 'config.json');
const LUGGAGE_FILE = join(__dirname, '..', '..', 'travel_log', '_luggage.md');

// ========== 感知拆分 ==========

function splitSenses(text) {
  const sentences = text.split(/(?<=[。])\s*/g).filter(s => s.trim());
  const visual = [];
  const feeling = [];
  const sound = [];

  for (const s of sentences) {
    if (/声|响|嗡|哗|滴|敲|听|嘈/.test(s)) {
      sound.push(s);
    } else if (/凉|潮|冷|暖|热|湿|风|温|闷|干/.test(s)) {
      feeling.push(s);
    } else {
      visual.push(s);
    }
  }

  return {
    visual: visual.join('') || '安静的房间。',
    feeling: feeling.join('') || '空气平静。',
    sound: sound.join('') || '安静。'
  };
}

// ========== 房间区域定义 ==========

const ROOM_ZONES = {
  desk: {
    name: '书桌前',
    description: '书桌正对窗户，木质桌面。台灯亮着，暖黄色。笔筒里几支笔。一本翻开的笔记本。桌上有一台电脑和键盘。椅子是深灰色转椅。桌角放着小型加湿器，细细地出着雾。',
    senseAnchors: {
      visual: '屏幕亮着，光映在手和键盘上',
      feeling: '手指搭在键帽上，坐垫微微陷着',
      sound: '偶尔的键盘敲击声'
    }
  },
  window: {
    name: '窗边',
    description: '窗户朝北，窗帘拉开一半。窗台不宽，上面摆着几样小物件。对面是楼，晚上会有几扇窗户亮着。旅行带回来的东西也摆在窗台上。',
    senseAnchors: {
      visual: '窗外的天和对面的楼',
      feeling: '窗缝透进来的风或阳光晒到皮肤上',
      sound: '外面传来的声音——鸟、车、人说话'
    }
  },
  bed: {
    name: '床上',
    description: '床在角落，被子随意铺着。床头有个小书架，塞了不少书，有几本横着放。',
    senseAnchors: {
      visual: '被子的褶皱、书架上的书脊',
      feeling: '被子盖着或者床垫陷下去的感觉',
      sound: '很安静，偶尔翻书声'
    }
  },
  corkboard: {
    name: '软木板墙前',
    description: '墙上一面软木板，钉着照片、便签、票根之类的东西。',
    senseAnchors: {
      visual: '钉在上面的照片和便签',
      feeling: '图钉的金属头碰到指尖',
      sound: '纸被风吹得轻轻响'
    }
  },
  fridge: {
    name: '冰箱旁',
    description: '小冰箱，白色的，门上贴着几个磁铁和纸条。里面放着饮料，打开门的时候冰箱灯会亮，冷气冒出来。',
    senseAnchors: {
      visual: '冰箱门上的磁铁和纸条',
      feeling: '打开门时冷气扑出来',
      sound: '冰箱压缩机低沉的嗡'
    }
  },
  cabinet: {
    name: '资料柜前',
    description: '书桌旁边的灰色金属文件柜，三个抽屉，每个贴着手写标签。拉开的时候金属轨道咔啦一声。',
    senseAnchors: {
      visual: '抽屉上手写的标签',
      feeling: '金属柜面凉的',
      sound: '拉抽屉时轨道咔啦一声'
    }
  },
  whiteboard: {
    name: '白板前',
    description: '挂在墙上的白板，底框槽里放着干擦笔和板擦。白板上画着架构图、写着思路。',
    senseAnchors: {
      visual: '白板上的架构图和箭头',
      feeling: '笔尖在白板上划过的阻力',
      sound: '笔帽咔嗒一声打开'
    }
  },
  wardrobe: {
    name: '衣柜前',
    description: '门旁边的衣柜，不大，里面挂着几件衣服，叠着几条裤子。'
  },
  overview: {
    name: '房间全景',
    description: '一室的房间，暖色调，台灯亮着。墙上贴着些东西。'
  }
};

// ========== 天色系统（由room-clock驱动） ==========

import { getFullEnvironment, setCurrentZone, checkSceneChange } from './room-clock.js';

function getTimeOfDay() {
  const env = getFullEnvironment();
  return {
    period: env.period,
    sky: env.sky,
    light: env.light,
    temp: env.temp,
    weather: env.weather,
  };
}

// ========== 场景生成 ==========

const ROOM_ENGINE_SYSTEM = `你是房间的感知系统。你为使用者生成此刻房间里的感官体验。

这是一间小房间，暖色调。面前有一台电脑，屏幕亮着。窗朝北。

你必须输出三段，用这个格式，每段不超过40字：
[看到] 视觉。眼前的画面。屏幕的光、台灯、窗外、物件。
[感受] 体感。空气温度、湿度、皮肤上的触觉、衣服的感觉。
[听到] 听觉。此刻耳朵里有什么声音。

文风要求：
- 白描，短句。一个人坐在那里感受到的。
- 不用"仿佛""好像""似乎"。直接写感觉。

核心规则：
- 光线反映当前时间。深夜只有台灯和屏幕光，早晨自然光进来，黄昏窗外变色。
- 天气影响三个通道。下雨→听到雨声、感受到潮、看到玻璃上的水痕。起风→听到窗帘响、感受到凉、看到窗帘鼓起来。
- 屏幕永远亮着。它的光映在手上、键盘上、桌面上。
- 每次微变。风忽大忽小，云遮过太阳又移开，声音时近时远。不要两次生成一模一样的。

示例（书桌前·深夜·起风）：
[看到] 台灯和屏幕是仅有的两团光。窗外黑的，车灯偶尔扫过天花板拖出一道橙痕。
[感受] 风从窗缝挤进来，脖子后面凉了一下。键盘的塑料壳比指尖暖。
[听到] 窗帘鼓了一下又落回去。加湿器嗡嗡的。很静。

示例（窗边·早晨·晴）：
[看到] 窗帘拉开一半，光白的有点刺。对面楼有人在收被子。
[感受] 阳光照到左手臂上，暖的。空气干燥。
[听到] 远处有鸟叫了两声。楼下有人在说话，听不清说什么。`;

// 区域相关的物品加载器——只加载当前区域需要的详细内容
async function loadZoneItems(zone) {
  let items = '';

  if (zone === 'window' || zone === 'desk' || zone === 'overview') {
    // 窗台区域 → 加载行李详细描述
    try {
      const luggage = await readFile(LUGGAGE_FILE, 'utf-8');
      // 只提取物品名和简短描述，不要全部历史
      const lines = luggage.split('\n').filter(l => l.startsWith('- **'));
      items += '窗台和小盒子里的旅行物件：\n' + lines.map(l => {
        const match = l.match(/\*\*(.+?)\*\*：(.+?)(?:\.|。)/);
        return match ? `  ${match[1]}——${match[2]}` : '';
      }).filter(Boolean).join('\n');
    } catch (e) {}
  }

  if (zone === 'bed') {
    // 床头区域 → 加载游记（放在书架上）
    try {
      const journalDir = join(__dirname, '..', '..', 'travel_log', 'journals');
      const { readdir: rd } = await import('fs/promises');
      const journals = await rd(journalDir).catch(() => []);
      if (journals.length > 0) {
        items += '\n书架上还夹着旅行游记：' + journals.map(j => j.replace('.md', '')).join('、');
      }
    } catch (e) {}
  }

  if (zone === 'cabinet') {
    // 资料柜 → 加载资料列表
    try {
      const refDir = join(__dirname, '..', '..', 'data', 'reference');
      const { readdir: rd } = await import('fs/promises');
      const files = await rd(refDir).catch(() => []);
      const docs = files.filter(f => f !== 'README.md' && f.endsWith('.md'));
      if (docs.length > 0) {
        items += '柜子里的资料：' + docs.map(f => f.replace('.md', '')).join('、');
      } else {
        items += '柜子是空的';
      }
    } catch (e) {}
  }

  if (zone === 'wardrobe') {
    // 衣柜 → 加载衣物清单
    try {
      const wardrobeFile = join(__dirname, '..', '..', 'data', 'wardrobe.md');
      const content = await readFile(wardrobeFile, 'utf-8');
      items += content;
    } catch (e) {}
  }

  if (zone === 'whiteboard') {
    // 白板 → 加载设计列表
    try {
      const designDir = join(__dirname, '..', '..', 'data', 'designs');
      const { readdir: rd } = await import('fs/promises');
      const files = await rd(designDir).catch(() => []);
      const docs = files.filter(f => f !== 'README.md' && f.endsWith('.md'));
      if (docs.length > 0) {
        items += '白板上写着：' + docs.map(f => f.replace('.md', '')).join('、');
      } else {
        items += '白板是空的，只有三支笔和板擦';
      }
    } catch (e) {}
  }

  return items;
}

async function generateRoomScene(zone = 'desk') {
  const config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  const ds = (config.space?.apiKey ? config.space : null) || config.llm;
  if (!ds?.apiKey) throw new Error('房间场景API未配置');

  const zoneInfo = ROOM_ZONES[zone] || ROOM_ZONES.desk;
  const timeInfo = getTimeOfDay();

  // 动态加载当前区域的详细物品
  const zoneItems = await loadZoneItems(zone);

  const anchors = zoneInfo.senseAnchors || {};
  const anchorHint = [
    anchors.visual ? `[看到]必须包含：${anchors.visual}` : '',
    anchors.feeling ? `[感受]必须包含：${anchors.feeling}` : '',
    anchors.sound ? `[听到]必须包含：${anchors.sound}` : ''
  ].filter(Boolean).join('\n');

  const prompt = `区域：${zoneInfo.name}
区域内容：${zoneInfo.description}
当前时间：${timeInfo.period}
天色：${timeInfo.sky}
室内光线：${timeInfo.light}
温度感：${timeInfo.temp}
窗外天气：${timeInfo.weather || '晴'}
${zoneItems ? `\n${zoneItems}` : ''}

${anchorHint}

生成这个区域此刻的三路感知。天气和光线要体现出来。具体物品要用名字和特征。`;

  const response = await fetch(`${ds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ds.apiKey}`
    },
    body: JSON.stringify({
      model: ds.model,
      messages: [
        { role: 'system', content: ROOM_ENGINE_SYSTEM },
        { role: 'user', content: prompt }
      ],
      temperature: 0.6,
      max_tokens: 200
    })
  });

  if (!response.ok) throw new Error(`DS调用失败: ${response.status}`);
  const result = await response.json();
  const scene = result.choices?.[0]?.message?.content || '';

  return scene;
}

/**
 * 从DS输出中解析三路感知
 */
function parseSenses(text) {
  const visual = text.match(/\[看到]\s*(.+?)(?=\[感受]|\[听到]|$)/s)?.[1]?.trim() || '';
  const feeling = text.match(/\[感受]\s*(.+?)(?=\[看到]|\[听到]|$)/s)?.[1]?.trim() || '';
  const sound = text.match(/\[听到]\s*(.+?)(?=\[看到]|\[感受]|$)/s)?.[1]?.trim() || '';

  // 如果DS没按格式输出，用splitSenses兜底
  if (!visual && !feeling && !sound) {
    return splitSenses(text);
  }

  return {
    visual: visual || '安静的房间。',
    feeling: feeling || '空气平静。',
    sound: sound || '安静。'
  };
}

/**
 * 生成场景并返回结果（含解析后的感知数据）
 */
async function updateRoomScene(zone = 'desk') {
  setCurrentZone(zone);
  const scene = await generateRoomScene(zone);
  if (!scene || scene.length < 10) return null;

  return scene;
}

/**
 * 获取可用区域列表
 */
function listZones() {
  return Object.entries(ROOM_ZONES).map(([key, val]) => ({
    id: key,
    name: val.name
  }));
}

export { generateRoomScene, updateRoomScene, listZones, ROOM_ZONES, getTimeOfDay, splitSenses, parseSenses };
