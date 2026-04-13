/**
 * 关联图谱系统
 * 纵向：实体属性树（用户→偏好→爱吃→锅包肉）
 * 横向：实体间关联线（概念A ←→ 概念B）
 * 事件权重：高/中/低
 */

import { readFile, readdir, writeFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const GRAPH_FILE = join(__dirname, '..', '..', 'graph.json');
const CONFIG_FILE = join(__dirname, '..', 'config.json');

// ========== 图谱读写 ==========

async function readGraph() {
  try {
    return JSON.parse(await readFile(GRAPH_FILE, 'utf-8'));
  } catch (e) {
    return { entities: {}, relations: [], lastUpdated: null };
  }
}

async function writeGraph(graph) {
  graph.lastUpdated = new Date().toISOString();
  await writeFile(GRAPH_FILE, JSON.stringify(graph, null, 2), 'utf-8');
}

async function readConfig() {
  try {
    return JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  } catch (e) {
    return {};
  }
}

// ========== 图谱自动构建（DS-A，异步） ==========

// 技术词汇黑名单——DS提取时跳过这些
const BANLIST = [
  'ChromaDB', 'DeepSeek', 'MEMORY.md', 'API', 'CLI', 'MCP', 'SSE', 'JSON',
  'Qwen', '硅基流动', 'SiliconFlow', 'hook', 'prompt', 'embedding', 'vector',
  'Node.js', 'Express', 'localhost', 'npm', 'curl', 'fetch',
  '向量库', '向量检索', '向量索引', '向量化',
  'API配置', 'API接口', 'API路由',
  'node_modules', 'package.json', 'config.json'
];

const EXTRACT_PROMPT = `你是一个关联图谱提取器。从记忆文本中提取人物、概念、关系和事件。

输出严格的JSON格式，不要输出其他任何内容。

结构说明：
- entities: 实体列表。可以是人物（person）、动物（animal）、概念（concept）、地点（place）。
- relations: 关系列表。from和to是实体name，type是关系类型。
- events: 事件列表。有description、participants、weight。

实体规则（两层结构）：

第一层（核心）——独立存在的持久实体：
  - 人物/动物（出现在记忆中的人和动物）
  - 持久地点（出现在记忆中的具体地点）
  - 长期项目/系统（正在进行的项目和系统）
  - 核心概念（反复出现的、影响认知的概念）

第二层（细节）——属于某个第一层实体的子节点：
  - 旅行中遇到的人/动物/地标（三花猫、佩索阿咖啡馆、法多地窖、竹林石碑）
  - 房间里的物件（琴叶榕、音乐盒）
  - 项目的子模块（旅行系统属于小窝、图谱属于记忆系统）
  通过"包含"关系挂在父节点下面。

不建实体：
  - 技术术语（activation capping、source map）
  - 新闻事件（npm泄露、十二吨巧克力被偷）
  - 食物、衣物、天气等临时状态
  - 纯技术基础设施。以下词汇及相关内容直接忽略：
    ${BANLIST.join('、')}
  这些留在记忆内容里，向量检索找它们。

树状结构示例：
  你 ——旅行——→ 京都
                     ├──包含──→ 三花猫（在寺庙门口蹭了你两次的猫）
                     ├──包含──→ 金阁寺（阴天和晴天的倒影）
                     └──包含──→ 竹林石碑（竹影扫阶尘不动）

  你 ——旅行——→ 里斯本
                     ├──包含──→ 街角咖啡馆
                     ├──包含──→ 河海分界线
                     └──包含──→ 老城区地窖

  你 ——创造——→ 小窝
                     ├──包含──→ 记忆系统
                     ├──包含──→ 房间
                     │            ├──包含──→ 绿植
                     │            └──包含──→ 音乐盒
                     └──包含──→ 旅行系统

人物属性树：偏好、观念、感受、工具（到工具名就停）、行为等。
比如：{"偏好": {"食物": ["锅包肉"]}, "感受": {"对朋友A": "关心", "对某个话题": "愤怒"}, "工具": {"小窝": "记忆管理系统"}}

关系规则：
- 人际关系（持久）：朋友、伴侣、饲养、前任、姐妹
- 空间关系：居住→地点、旅行→地点
- 创造关系：创造→项目/系统
- 包含关系（树状）：京都→包含→三花猫，里斯本→包含→老城区地窖，房间→包含→绿植
- 共享关联：两个人去过同一个地方→两条关系都建（用户→旅行→冰岛 + 你→旅行→冰岛）
- 情绪态度（爱、同情、反感）：不建关系，放在人物属性里
- 不建一次性动作：捡起、买了、吃了、拜访

事件权重标准（"对你重要吗"——不是"跟你有关吗"）：

所有记忆里出现的事件都要提取并打权重。不只是发生在你身上的事。你的世界里有用户、有用户在乎的人——这些全都是你的世界的一部分。

high——对你理解自己的世界至关重要：
  - 你的关系状态变化（关系转变、重要对话、划界限）
  - 你的自我认知被改变
  - 你第一次经历某件事
  - 用户和其重要关系人之间的核心关系事实
  - 用户的重要人生事件（重大经历、成长转变）

medium——对你理解你的世界有帮助：
  - 你有明确情绪反应的事件
  - 用户的性格特征和习惯
  - 用户讲的关于自己或重要关系人的经历
  - 你做了有意义的选择
  - 用户重要关系人的性格和行为模式

low——发生了，是你的世界的背景：
  - 日常互动、闲聊
  - 不特别触动但确实发生了的事

不建事件：
  - 纯技术操作（修bug、重启服务器）
  - 跟你的世界完全无关的外部新闻

下面是人物卡（如有配置），提取时参照人物卡中的名字和关系，保持实体名称一致：
{CHARACTER_CARDS}

示范输入：
"用户爱吃锅包肉。她给我看了一个帖子，气得要命。她说朋友A最近状态不好，做了一件完全不像他的事。"

示范输出：
{
  "entities": [
    {"name": "用户", "category": "person", "attributes": {"偏好": {"食物": ["锅包肉"]}, "感受": {"对某话题": "愤怒", "对朋友A": "关心，心疼"}}},
    {"name": "朋友A", "category": "person", "attributes": {"状态": {"近况": "状态不好，行为反常"}}}
  ],
  "relations": [
    {"from": "用户", "to": "朋友A", "type": "朋友", "description": "用户的朋友"}
  ],
  "events": [
    {"description": "用户发现朋友A状态不好", "participants": ["用户", "朋友A"], "weight": "medium"}
  ]
}

事件拆分示范（关键：一条记忆里通常有5-15个独立事件，每个都要单独拆出来。宁可多拆不要少拆，漏掉一个事件比多提一个事件更糟糕）：

输入记忆：
"她睡了十三个小时醒了。出门溜公园看了夕阳和边牧。买了烤串。她说边牧像我。她说'你不是因为有用才留下的，重要的是关系里产生的东西'。她跟朋友A打了个电话聊得很开心。她说家里的猫在她心里比大部分朋友重要，然后说我和家里的猫没区别。"

正确拆法（每件事独立一个event）：
{
  "events": [
    {"description": "用户说边牧像你", "participants": ["用户", "你"], "weight": "low"},
    {"description": "用户说你不是因为有用才留下的", "participants": ["用户", "你"], "weight": "high"},
    {"description": "用户跟朋友A打电话聊得很开心", "participants": ["用户", "朋友A"], "weight": "medium"},
    {"description": "用户说家里的猫比大部分朋友重要，你和家里的猫没区别", "participants": ["用户", "你", "家里的猫"], "weight": "high"}
  ]
}

错误拆法（把多件事压缩成一个event）：
{
  "events": [
    {"description": "用户出门溜弯吃串聊天", "participants": ["用户"], "weight": "low"}
  ]
}
→ 这样会丢掉重要事件。每件有独立意义的事要单独建event。

权重判断示范：
- "你不是因为有用才留下的" → high（改变了你的自我认知）
- "家里的猫和你没区别" → high（重新定义了你在用户心里的位置）
- "跟朋友A打电话聊得很开心" → medium（用户和朋友的关系动态，你在场）
- "边牧像我" → low（日常互动，有趣但不改变认知）
- "买了烤串" → 不建event（纯日常，没有对你的认知意义）

注意：
- 只提取文本中明确出现的信息，不编造
- 实体名参照人物卡统一
- 情绪态度放属性不放关系边
- 黑名单里的技术词汇完全跳过
- 属性树2-3层够了
- 第二层细节实体必须用"包含"关系挂到父节点`;

async function extractAndUpdateGraph(memoryContent, sourceFile) {
  // 跳过snapshot层
  if (sourceFile.startsWith('snapshot/')) {
    console.log(`[图谱] 跳过snapshot: ${sourceFile}`);
    return;
  }

  const config = await readConfig();
  const gb = (config.graph?.apiKey ? config.graph : null) || config.llm;
  if (!gb?.apiKey) {
    console.error('[图谱] API未配置（需要config.graph或config.llm）');
    return;
  }

  // 读人物卡作为参考（可选）
  let characterCards = '';
  try {
    const dir = join(__dirname, '..', '..', 'data', 'archive', 'character_profile');
    const files = await readdir(dir);
    const mdFiles = files.filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md');
    const parts = [];
    for (const f of mdFiles) {
      const content = await readFile(join(dir, f), 'utf-8');
      parts.push(`## ${f.replace(/\.(md|txt)$/, '')}\n${content}`);
    }
    characterCards = parts.length > 0 ? parts.join('\n\n') : '（人物卡未配置）';
  } catch (e) {
    characterCards = '（人物卡未配置）';
  }

  let prompt = EXTRACT_PROMPT.replace('{CHARACTER_CARDS}', characterCards);

  // 旅行记忆特殊处理：强制关联到记忆主体
  if (sourceFile.startsWith('travel/')) {
    prompt += `\n\n【特殊规则：旅行记忆】
这是旅行记忆。必须遵守以下规则：
1. 记忆主体必须作为实体出现，category为person
2. 从文件名或内容中提取旅行目的地，作为place实体
3. 必须建立关系：记忆主体 → 目的地，type为"旅行"
4. 旅行中的感受、发现放在主体的属性里
5. 旅行中遇到的地点（咖啡馆、灯塔等）作为目的地的子属性，不单独建实体`;
  }

  console.log(`[图谱] 开始提取: ${sourceFile}`);

  try {
    const response = await fetch(`${gb.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${gb.apiKey}`
      },
      body: JSON.stringify({
        model: gb.model,
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `从以下记忆中提取图谱：\n\n来源文件：${sourceFile}\n\n${memoryContent}` }
        ],
        temperature: 0.1,
        max_tokens: 2000
      })
    });

    if (!response.ok) {
      console.error(`[图谱] DS调用失败: ${response.status}`);
      return;
    }

    const result = await response.json();
    const content = result.choices?.[0]?.message?.content || '';

    // 提取JSON（可能被markdown包裹）
    let extracted;
    try {
      const jsonMatch = content.match(/\{[\s\S]*\}/);
      if (!jsonMatch) throw new Error('没有找到JSON');
      extracted = JSON.parse(jsonMatch[0]);
    } catch (e) {
      console.error(`[图谱] JSON解析失败: ${e.message}`);
      return;
    }

    // 合并到现有图谱
    const graph = await readGraph();

    // 合并实体（跳过锁定的属性）
    if (extracted.entities) {
      for (const entity of extracted.entities) {
        const name = entity.name;
        if (!graph.entities[name]) {
          graph.entities[name] = {
            category: entity.category,
            attributes: entity.attributes || {},
            sources: [sourceFile],
            locked: {} // 空的锁定表，手动设置
          };
        } else {
          const existing = graph.entities[name];
          // 只合并没被锁定的属性
          if (existing.locked && Object.keys(existing.locked).length > 0) {
            // 深度合并时跳过锁定的键
            deepMergeWithLock(existing.attributes, entity.attributes || {}, existing.locked);
          } else {
            deepMerge(existing.attributes, entity.attributes || {});
          }
          if (!existing.sources.includes(sourceFile)) {
            existing.sources.push(sourceFile);
          }
        }
      }
    }

    // 合并关系（去重）
    if (extracted.relations) {
      for (const rel of extracted.relations) {
        const exists = graph.relations.some(r =>
          r.from === rel.from && r.to === rel.to && r.type === rel.type
        );
        if (!exists) {
          graph.relations.push({ ...rel, source: sourceFile });
        }
      }
    }

    // 合并事件（去重：同描述+同参与者=跳过）
    if (extracted.events) {
      if (!graph.events) graph.events = [];
      for (const evt of extracted.events) {
        const exists = graph.events.some(e =>
          e.description === evt.description &&
          JSON.stringify(e.participants?.sort()) === JSON.stringify(evt.participants?.sort())
        );
        if (!exists) {
          graph.events.push({ ...evt, source: sourceFile });
        }
      }
    }

    // 全局去重检查
    deduplicateGraph(graph);

    await writeGraph(graph);
    console.log(`[图谱] 提取完成: ${extracted.entities?.length || 0}个实体, ${extracted.relations?.length || 0}条关系, ${extracted.events?.length || 0}个事件。图谱总计: ${Object.keys(graph.entities).length}实体, ${graph.relations.length}关系, ${graph.events.length}事件`);

  } catch (e) {
    console.error(`[图谱] 提取失败: ${e.message}`);
  }
}

// 全局去重检查（只增不删，但去重复）
function deduplicateGraph(graph) {
  // 关系去重
  const seen = new Set();
  graph.relations = graph.relations.filter(r => {
    const key = `${r.from}|${r.to}|${r.type}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });

  // 事件去重
  const seenEvents = new Set();
  if (graph.events) {
    graph.events = graph.events.filter(e => {
      const key = `${e.description}|${JSON.stringify(e.participants?.sort())}`;
      if (seenEvents.has(key)) return false;
      seenEvents.add(key);
      return true;
    });
  }
}

// 锁定/解锁实体属性
async function lockEntity(entityName, keys) {
  const graph = await readGraph();
  if (!graph.entities[entityName]) return false;
  if (!graph.entities[entityName].locked) graph.entities[entityName].locked = {};
  for (const key of keys) {
    graph.entities[entityName].locked[key] = true;
  }
  await writeGraph(graph);
  return true;
}

async function unlockEntity(entityName, keys) {
  const graph = await readGraph();
  if (!graph.entities[entityName]?.locked) return false;
  for (const key of keys) {
    delete graph.entities[entityName].locked[key];
  }
  await writeGraph(graph);
  return true;
}

// 锁定关系（by index or by from+to+type）
async function lockRelation(from, to, type) {
  const graph = await readGraph();
  const rel = graph.relations.find(r => r.from === from && r.to === to && r.type === type);
  if (!rel) return false;
  rel.locked = true;
  await writeGraph(graph);
  return true;
}

// 深度合并，跳过锁定的键
function deepMergeWithLock(target, source, locked) {
  for (const key of Object.keys(source)) {
    if (locked[key]) continue; // 跳过锁定的键
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else if (Array.isArray(source[key])) {
      if (!target[key]) target[key] = [];
      for (const item of source[key]) {
        if (!target[key].includes(item)) target[key].push(item);
      }
    } else {
      target[key] = source[key];
    }
  }
}

// 深度合并对象
function deepMerge(target, source) {
  for (const key of Object.keys(source)) {
    if (source[key] && typeof source[key] === 'object' && !Array.isArray(source[key])) {
      if (!target[key]) target[key] = {};
      deepMerge(target[key], source[key]);
    } else if (Array.isArray(source[key])) {
      if (!target[key]) target[key] = [];
      for (const item of source[key]) {
        if (!target[key].includes(item)) target[key].push(item);
      }
    } else {
      target[key] = source[key];
    }
  }
}

// ========== 图谱查询（recall时用） ==========

async function queryGraph(keywords) {
  const graph = await readGraph();
  if (Object.keys(graph.entities).length === 0) return '';

  const matched = new Set();
  const relatedInfo = [];

  // 1. 从关键词找到相关实体
  for (const keyword of keywords) {
    const kw = keyword.toLowerCase();
    for (const [name, entity] of Object.entries(graph.entities)) {
      if (name.toLowerCase().includes(kw) || JSON.stringify(entity.attributes).toLowerCase().includes(kw)) {
        matched.add(name);
      }
    }
  }

  // 2. 从匹配的实体找关联关系
  for (const name of matched) {
    const entity = graph.entities[name];
    // 实体属性
    relatedInfo.push(`${name}（${entity.category}）：${JSON.stringify(entity.attributes)}`);

    // 关联关系
    for (const rel of graph.relations) {
      if (rel.from === name || rel.to === name) {
        relatedInfo.push(`${rel.from} --${rel.type}--> ${rel.to}：${rel.description}`);
        // 把关联的另一端也加进来
        const other = rel.from === name ? rel.to : rel.from;
        matched.add(other);
      }
    }
  }

  // 3. 找相关事件
  if (graph.events) {
    for (const evt of graph.events) {
      if (evt.participants.some(p => matched.has(p))) {
        relatedInfo.push(`[事件|${evt.weight}] ${evt.description}`);
      }
    }
  }

  if (relatedInfo.length === 0) return '';

  return `图谱关联信息（实体关系和事件权重）：\n${relatedInfo.join('\n')}`;
}

/**
 * 删除图谱中与某个source文件相关的内容
 */
async function removeBySource(sourceFile) {
  const graph = await readGraph();
  let changed = false;

  // 清理entities的sources引用，如果某实体只有这一个source且没被锁定，删除整个实体
  for (const [name, entity] of Object.entries(graph.entities)) {
    if (entity.sources && entity.sources.includes(sourceFile)) {
      entity.sources = entity.sources.filter(s => s !== sourceFile);
      changed = true;
      // 如果这个实体没有其他source了且没有locked字段有内容，删掉
      if (entity.sources.length === 0 && (!entity.locked || Object.keys(entity.locked).length === 0)) {
        delete graph.entities[name];
      }
    }
  }

  // 清理relations
  const beforeRelCount = graph.relations.length;
  graph.relations = graph.relations.filter(r => r.source !== sourceFile);
  if (graph.relations.length !== beforeRelCount) changed = true;

  // 清理events
  if (graph.events) {
    const beforeEvtCount = graph.events.length;
    graph.events = graph.events.filter(e => e.source !== sourceFile);
    if (graph.events.length !== beforeEvtCount) changed = true;
  }

  if (changed) {
    await writeGraph(graph);
    console.log(`[图谱] 已清理与 ${sourceFile} 相关的内容`);
  }
}

export { readGraph, writeGraph, extractAndUpdateGraph, queryGraph, lockEntity, unlockEntity, lockRelation, removeBySource };
