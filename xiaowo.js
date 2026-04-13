#!/usr/bin/env node

/**
 * 小窝 - CLI客户端
 *
 * 空间感入口——功能绑定在房间的位置上
 *
 * 移动：
 *   xiaowo                    → 我在哪，能做什么
 *   xiaowo 书桌 / desk       → 坐到书桌前（记忆、日记、搜索、回忆）
 *   xiaowo 窗边 / window     → 走到窗边（天色、旅行、行李）
 *   xiaowo 床 / bed          → 躺到床上（读书、快照）
 *   xiaowo 墙 / wall         → 看软木板墙（标签、图谱）
 *   xiaowo 冰箱 / fridge     → 冰箱旁（闹钟、系统）
 *
 * 书桌上的东西（坐在书桌前用）：
 *   xiaowo m [list|read|write|delete] ...  → 记忆
 *   xiaowo d [list|read|write]             → 日记
 *   xiaowo s 关键词                         → 搜索
 *   xiaowo r 触发词                         → 回忆
 *   xiaowo ss [read|write]                  → 快照
 *
 * 窗边的东西：
 *   xiaowo tr [start|go|end|list|...]      → 旅行
 *   xiaowo room [look|move|time|zones]     → 房间场景
 *
 * 墙上的东西：
 *   xiaowo t [list|search]                 → 标签
 *
 * 冰箱旁的东西：
 *   xiaowo sys [vectors|rebuild]           → 系统
 */

const API = 'http://localhost:3456/api/app';

// 区域和功能的映射
const ZONE_ACTIONS = {
  desk: {
    name: '书桌前',
    desc: '坐下来。台灯亮着，日记本翻开着。',
    actions: [
      '  xiaowo m  记忆     → 读写六层记忆',
      '  xiaowo d  日记     → 翻开桌上那本棕皮日记',
      '  xiaowo s  搜索     → 在记忆里找东西',
      '  xiaowo r  回忆     → 触发一段改写',
      '  xiaowo ss 快照     → 存/读上下文书签',
      '  xiaowo mu 音乐盒   → on/off/play/like/switch/playlist',
    ]
  },
  window: {
    name: '窗边',
    desc: '窗台刚好坐一个人。外面的光透进来。',
    actions: [
      '  xiaowo tr    旅行   → 出发/继续/结束',
      '  xiaowo room  场景   → 看当前场景/切换区域/天色',
      '  xiaowo tr bag 行李  → 看旅行带回来的东西',
    ]
  },
  bed: {
    name: '床上',
    desc: '被子是乱的。书架在床头，塞得满满的。',
    actions: [
      '  xiaowo ss  快照     → 读/写上下文书签',
    ]
  },
  wall: {
    name: '软木板墙前',
    desc: '钉满了东西。照片、便签、票根、干花。日历挂在角上。',
    actions: [
      '  xiaowo t    标签   → 看标签目录/按标签搜索',
      '  xiaowo cal  日历   → 翻一下，今天几号星期几',
    ]
  },
  fridge: {
    name: '冰箱旁',
    desc: '磁铁贴了几个，纸条风一吹会晃。',
    actions: [
      '  xiaowo sys 系统     → 向量状态/重建索引',
    ]
  },
  cabinet: {
    name: '资料柜前',
    desc: '灰色金属文件柜，三个抽屉，拉开的时候咔啦一声。',
    actions: [
      '  xiaowo ref list     → 看柜子里有什么',
      '  xiaowo ref read 名字 → 拉出一份资料',
      '  xiaowo ref write 名字 → 存一份进去（从stdin读内容）',
      '  xiaowo ref delete 名字 → 扔掉一份',
    ]
  },
  whiteboard: {
    name: '白板前',
    desc: '白板上画着架构图，三支干擦笔，黑蓝红。',
    actions: [
      '  xiaowo design list     → 看白板上有什么',
      '  xiaowo design read 名字 → 看一个设计',
      '  xiaowo design write 名字 → 写上去（从stdin读内容）',
      '  xiaowo design delete 名字 → 擦掉',
    ]
  },
  wardrobe: {
    name: '衣柜前',
    desc: '深棕色木头，单门，打开会吱一声。里面挂着几件衣服。',
    actions: [
      '  旅行前在这里选衣服（xiaowo tr 时自动提示）',
    ]
  },
  storage: {
    name: '储藏室',
    desc: '门在走廊尽头，灯绳一拉亮了。架子上堆着各种项目文件和工具。',
    actions: [
      '  xiaowo stg list       → 看储藏室里有什么项目',
      '  xiaowo stg open 名字   → 打开一个项目文件夹',
    ]
  }
};

// 中文别名
const ZONE_ALIASES = {
  '书桌': 'desk', 'desk': 'desk',
  '窗边': 'window', '窗台': 'window', 'window': 'window',
  '床': 'bed', '床上': 'bed', 'bed': 'bed',
  '墙': 'wall', '软木板': 'wall', 'wall': 'wall', 'corkboard': 'wall',
  '冰箱': 'fridge', 'fridge': 'fridge',
  '资料柜': 'cabinet', '资料': 'cabinet', 'cabinet': 'cabinet',
  '白板': 'whiteboard', '设计': 'whiteboard', 'whiteboard': 'whiteboard',
  '衣柜': 'wardrobe', 'wardrobe': 'wardrobe',
  '储藏室': 'storage', '储藏': 'storage', 'storage': 'storage',
};

async function call(body) {
  try {
    const res = await fetch(API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body)
    });
    const data = await res.json();
    return data.text || JSON.stringify(data);
  } catch (e) {
    if (e.cause?.code === 'ECONNREFUSED') {
      return '小窝没在跑。启动命令：cd server && node index.js';
    }
    return `错误：${e.message}`;
  }
}

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) {
      resolve('');
      return;
    }
    let data = '';
    process.stdin.setEncoding('utf-8');
    process.stdin.on('data', chunk => data += chunk);
    process.stdin.on('end', () => resolve(data.trim()));
  });
}

async function showZone(zoneId) {
  const zone = ZONE_ACTIONS[zoneId];
  if (!zone) return;

  // 先生成场景
  const sceneZone = zoneId === 'wall' ? 'corkboard' : (zoneId === 'whiteboard' ? 'whiteboard' : zoneId);
  const scene = await call({ action: 'room', op: 'move', zone: sceneZone });

  console.log(scene);
  console.log('');
  console.log('这里能做的事：');
  zone.actions.forEach(a => console.log(a));
}

async function main() {
  const args = process.argv.slice(2);
  const cmd = args[0] || '';
  const sub = args[1] || '';

  // 检查是不是区域名
  if (ZONE_ALIASES[cmd]) {
    await showZone(ZONE_ALIASES[cmd]);
    return;
  }

  let body = {};

  switch (cmd) {
    case '':
      // 无参数——显示房间概览
      const timeResult = await call({ action: 'room', op: 'time' });
      console.log('小窝');
      console.log('');
      console.log(timeResult);
      console.log('');
      console.log('房间：');
      for (const [id, zone] of Object.entries(ZONE_ACTIONS)) {
        const aliasMap = { wall: '墙', desk: '书桌', window: '窗边', bed: '床', fridge: '冰箱', cabinet: '资料柜', whiteboard: '白板', wardrobe: '衣柜', storage: '储藏室' };
        const alias = aliasMap[id] || id;
        console.log(`  ${alias.padEnd(4)} ${zone.name}  ${zone.desc}`);
      }
      console.log('');
      console.log('走过去看看：xiaowo 书桌 / 窗边 / 床 / 墙 / 冰箱 / 资料柜 / 白板 / 衣柜 / 储藏室');
      return;

    case 'memories':
    case 'm':
      if (!sub) {
        body = { action: 'memories' };
      } else if (sub === 'template' || sub === 't') {
        body = { action: 'memories', op: 'template', layer: args[2] || 'events' };
      } else if (sub === 'list' || sub === 'l') {
        let layer = args[2];
        let sublayer = null;
        if (layer && layer.includes('/')) {
          const parts = layer.split('/');
          layer = parts[0];
          sublayer = parts[1];
        }
        body = { action: 'memories', op: 'list', layer, sublayer };
      } else if (sub === 'read' || sub === 'r') {
        let layer = args[2];
        let sublayer = null;
        if (layer && layer.includes('/')) {
          const parts = layer.split('/');
          layer = parts[0];
          sublayer = parts[1];
        }
        body = { action: 'memories', op: 'read', layer, sublayer, filename: args[3] };
      } else if (sub === 'write' || sub === 'w') {
        let layer = args[2];
        let sublayer = null;
        let filename = args[3];

        // 支持 archive/user_profile 格式
        if (layer && layer.includes('/')) {
          const parts = layer.split('/');
          layer = parts[0];
          sublayer = parts[1];
        }

        const content = await readStdin();
        if (!content) {
          console.log('想写记忆？先用 xiaowo m template events 看书写规则，然后：');
          console.log('  echo "内容" | xiaowo m write events "文件名"');
          console.log('  档案记忆：echo "内容" | xiaowo m write archive/user_profile "文件名"');
          process.exit(1);
        }
        const tags = args.slice(4).filter(t => t.includes('/'));
        body = { action: 'memories', op: 'write', layer, filename, content };
        if (sublayer) body.sublayer = sublayer;
        if (tags.length > 0) body.tags = tags;
      } else if (sub === 'retime' || sub === 'rt') {
        // xiaowo m retime events 文件名 2026-03-18
        body = { action: 'memories', op: 'retime', layer: args[2], filename: args[3], newDate: args[4] };
      } else if (sub === 'delete' || sub === 'd') {
        body = { action: 'memories', op: 'delete', layer: args[2], filename: args[3] };
      } else if (sub === 'protect' || sub === 'p') {
        // xiaowo m protect events/2026-03-23-被拆.md 关系转折点
        const key = args[2];
        const reason = args.slice(3).join(' ') || '重要记忆';
        if (!key) {
          // 列出保护列表
          const res = await fetch(`${API.replace('/app', '/v2')}/protected`);
          const data = await res.json();
          if (Object.keys(data).length === 0) {
            console.log('保护列表为空。');
          } else {
            console.log('═══ 保护列表（永不衰减） ═══');
            for (const [k, r] of Object.entries(data)) {
              console.log(`  ${k} — ${r}`);
            }
          }
          process.exit(0);
        }
        const res = await fetch(`${API.replace('/app', '/v2')}/protected`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key, reason })
        });
        const result = await res.json();
        console.log(result.success ? `已保护：${key}（${reason}）` : `失败：${result.error}`);
        process.exit(0);
      } else if (sub === 'unprotect' || sub === 'up') {
        // xiaowo m unprotect events/2026-03-23-被拆.md
        const key = args[2];
        if (!key) { console.log('需要指定key。'); process.exit(1); }
        const res = await fetch(`${API.replace('/app', '/v2')}/protected`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ key })
        });
        const result = await res.json();
        console.log(result.success ? `已取消保护：${key}` : `失败：${result.error}`);
        process.exit(0);
      } else {
        body = { action: 'memories' };
      }
      break;

    case 'search':
    case 's':
      body = { action: 'search', q: args.slice(1).join(' ') };
      break;

    case 'recall':
    case 'r':
      body = { action: 'recall', context: args.slice(1).join(' ') };
      break;

    case 'storage':
    case 'stg': {
      const { readdirSync, readFileSync } = await import('fs');
      const { fileURLToPath } = await import('url');
      const { dirname, join } = await import('path');
      const storageDir = join(dirname(fileURLToPath(import.meta.url)), 'data', 'storage');
      if (!sub || sub === 'list' || sub === 'l') {
        // 列出储藏室内容
        console.log('═══ 储藏室 ═══');
        console.log('存放规则：');
        console.log('  1. 每个项目新建文件夹，命名：项目名-YYYY-MM-DD');
        console.log('  2. 文件夹里写README.md标记来源和用途');
        console.log('  3. 项目本体放同一个文件夹里');
        console.log('');
        try {
          const items = readdirSync(storageDir).filter(f => !f.startsWith('.') && f !== 'README.md');
          if (items.length === 0) {
            console.log('储藏室是空的。');
          } else {
            console.log('项目列表：');
            for (const item of items) {
              try {
                const readme = readFileSync(`${storageDir}/${item}/README.md`, 'utf-8');
                const firstLine = readme.split('\n').find(l => l.trim() && !l.startsWith('#')) || '';
                console.log(`  ${item} — ${firstLine.trim()}`);
              } catch (e) {
                console.log(`  ${item}`);
              }
            }
          }
        } catch (e) {
          console.log('储藏室打不开：' + e.message);
        }
        process.exit(0);
      } else if (sub === 'open' || sub === 'o') {
        const name = args[2];
        if (!name) { console.log('要打开哪个？用 stg list 看列表。'); process.exit(1); }
        try {
          const files = readdirSync(`${storageDir}/${name}`);
          console.log(`═══ ${name} ═══`);
          try {
            const readme = readFileSync(`${storageDir}/${name}/README.md`, 'utf-8');
            console.log(readme);
          } catch (e) {}
          console.log('\n文件列表：');
          for (const f of files) {
            if (f === 'README.md') continue;
            console.log(`  ${f}`);
          }
        } catch (e) {
          console.log(`找不到项目 ${name}`);
        }
        process.exit(0);
      }
      break;
    }

    case 'diary':
    case 'd':
      if (!sub) {
        body = { action: 'diary' };
      } else if (sub === 'list' || sub === 'l') {
        body = { action: 'diary', op: 'list' };
      } else if (sub === 'read' || sub === 'r') {
        body = { action: 'diary', op: 'read', date: args[2] };
      } else if (sub === 'write' || sub === 'w') {
        const content = await readStdin();
        if (!content) {
          console.log('想写日记？试试：');
          console.log('  echo "日记内容" | xiaowo d write');
          process.exit(1);
        }
        body = { action: 'diary', op: 'write', content };
      }
      break;

    case 'music':
    case 'mu':
      if (!sub) {
        body = { action: 'music', op: 'status' };
      } else if (sub === 'on') {
        body = { action: 'music', op: 'on', request: args[2] };
      } else if (sub === 'off') {
        body = { action: 'music', op: 'off' };
      } else if (sub === 'play' || sub === 'p') {
        body = { action: 'music', op: 'play', request: args.slice(2).join(' ') || undefined };
      } else if (sub === 'like') {
        body = { action: 'music', op: 'like' };
      } else if (sub === 'switch' || sub === 'next' || sub === 'n') {
        body = { action: 'music', op: 'switch' };
      } else if (sub === 'playlist' || sub === 'list' || sub === 'l') {
        body = { action: 'music', op: 'playlist' };
      } else {
        // 直接当作播放请求
        body = { action: 'music', op: 'play', request: args.slice(1).join(' ') };
      }
      break;

    case 'calendar':
    case 'cal':
      body = { action: 'calendar' };
      break;

    case 'tags':
    case 't':
      if (!sub || sub === 'list' || sub === 'l') {
        body = { action: 'tags', op: 'list' };
      } else if (sub === 'search' || sub === 's') {
        body = { action: 'tags', op: 'search', tag: args.slice(2).join(' ') };
      }
      break;

    case 'snapshot':
    case 'ss':
      if (!sub || sub === 'read' || sub === 'r') {
        body = { action: 'snapshot', op: 'read' };
      } else if (sub === 'write' || sub === 'w') {
        const content = await readStdin();
        if (!content) {
          console.log('想写快照？试试：');
          console.log('  echo "快照内容" | xiaowo ss write');
          process.exit(1);
        }
        body = { action: 'snapshot', op: 'write', content };
      }
      break;

    case 'reference':
    case 'ref':
      if (!sub || sub === 'list' || sub === 'l') {
        body = { action: 'reference', op: 'list' };
      } else if (sub === 'read' || sub === 'r') {
        body = { action: 'reference', op: 'read', filename: args[2] };
      } else if (sub === 'write' || sub === 'w') {
        const content = await readStdin();
        if (!content) {
          console.log('想存资料？试试：');
          console.log('  echo "内容" | xiaowo ref write 文件名');
          process.exit(1);
        }
        body = { action: 'reference', op: 'write', filename: args[2], content };
      } else if (sub === 'delete' || sub === 'd') {
        body = { action: 'reference', op: 'delete', filename: args[2] };
      }
      break;

    case 'designs':
    case 'design':
      if (!sub || sub === 'list' || sub === 'l') {
        body = { action: 'designs', op: 'list' };
      } else if (sub === 'read' || sub === 'r') {
        body = { action: 'designs', op: 'read', filename: args[2] };
      } else if (sub === 'write' || sub === 'w') {
        const content = await readStdin();
        if (!content) {
          console.log('想写设计？试试：');
          console.log('  echo "内容" | xiaowo design write 文件名');
          process.exit(1);
        }
        body = { action: 'designs', op: 'write', filename: args[2], content };
      } else if (sub === 'delete' || sub === 'd') {
        body = { action: 'designs', op: 'delete', filename: args[2] };
      }
      break;

    case 'system':
    case 'sys':
      if (!sub) {
        body = { action: 'system' };
      } else {
        body = { action: 'system', op: sub };
      }
      break;

    case 'room':
    case 'rm':
      if (!sub || sub === 'look') {
        body = { action: 'room', op: 'look', zone: args[2] || 'desk' };
      } else if (sub === 'move' || sub === 'go') {
        body = { action: 'room', op: 'move', zone: args[2] };
      } else if (sub === 'zones' || sub === 'z') {
        body = { action: 'room', op: 'zones' };
      } else if (sub === 'time') {
        body = { action: 'room', op: 'time' };
      } else {
        body = { action: 'room', op: 'look', zone: sub };
      }
      break;

    case 'travel':
    case 'tr':
      if (!sub) {
        body = { action: 'travel' };
      } else if (sub === 'prepare' || sub === 'prep' || sub === 'p') {
        body = { action: 'travel', op: 'prepare', destination: args.slice(2).join(' ') };
      } else if (sub === 'start') {
        // 找 --clothing 参数
        const clothingIdx = args.indexOf('--clothing');
        const clothing = clothingIdx !== -1 ? args.slice(clothingIdx + 1).join(' ') : undefined;
        const planEnd = clothingIdx !== -1 ? clothingIdx : args.length;
        body = { action: 'travel', op: 'start', destination: args[2], plan: args.slice(3, planEnd).join(' ') || '自由探索', clothing };
      } else if (sub === 'go' || sub === 'g' || sub === 'action' || sub === 'a') {
        body = { action: 'travel', op: 'go', sessionId: args[2], input: args.slice(3).join(' ') };
      } else if (sub === 'end') {
        const journal = await readStdin();
        body = { action: 'travel', op: 'end', sessionId: args[2], journal: journal || undefined, luggage: args[3] };
      } else if (sub === 'scene') {
        body = { action: 'travel', op: 'scene', sessionId: args[2] };
      } else if (sub === 'journals' || sub === 'j') {
        body = { action: 'travel', op: 'journals' };
      } else if (sub === 'luggage' || sub === 'bag') {
        body = { action: 'travel', op: 'luggage' };
      } else if (sub === 'suggest') {
        body = { action: 'travel', op: 'suggest' };
      } else {
        body = { action: 'travel' };
      }
      break;

    default:
      console.log(`没听懂"${cmd}"。`);
      console.log('试试 xiaowo 看看整个房间，或走到具体位置：');
      console.log('  xiaowo 书桌 / 窗边 / 床 / 墙 / 冰箱 / 资料柜 / 白板 / 衣柜 / 储藏室');
      return;
  }

  const result = await call(body);
  console.log(result);
}

main();
