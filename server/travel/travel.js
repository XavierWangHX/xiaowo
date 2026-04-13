/**
 * 旅行系统
 * LLM是世界引擎，用户是旅行者。
 * LLM生成场景，旅行者在里面走，做选择，写游记，捡行李。
 */

import { readFile, writeFile, mkdir, readdir } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const TRAVEL_DIR = join(__dirname, '..', '..', 'travel_log');
const SCENES_DIR = join(TRAVEL_DIR, 'scenes');
const JOURNALS_DIR = join(TRAVEL_DIR, 'journals');
const LUGGAGE_FILE = join(TRAVEL_DIR, '_luggage.md');
const CONFIG_FILE = join(__dirname, '..', 'config.json');

async function readJson(path) {
  try { return JSON.parse(await readFile(path, 'utf-8')); } catch (e) { return {}; }
}

async function ensureDir(dir) {
  try { await mkdir(dir, { recursive: true }); } catch (e) {}
}

// ========== 目的地选择系统 ==========

const DESTINATION_TIERS = [
  { weight: 5, type: 'obscure', desc: '偏僻小镇、无人知晓的角落、被遗忘的地方' },
  { weight: 4, type: 'hidden', desc: '大城市里隐藏的角落、本地人才知道的地方' },
  { weight: 3, type: 'historical', desc: '某个历史时期的某个地方（时间旅行）' },
  { weight: 2, type: 'fictional', desc: '虚构世界——文学作品里的地方' },
  { weight: 1, type: 'famous', desc: '著名景点，但从不寻常的角度' }
];

function selectDestinationType() {
  const totalWeight = DESTINATION_TIERS.reduce((s, t) => s + t.weight, 0);
  let rand = Math.random() * totalWeight;
  for (const tier of DESTINATION_TIERS) {
    rand -= tier.weight;
    if (rand <= 0) return tier;
  }
  return DESTINATION_TIERS[0];
}

/**
 * 用DS推荐一个具体目的地（自动排除去过的地方）
 */
async function suggestDestination() {
  const config = await readJson(CONFIG_FILE);
  const ds = config.llm;
  if (!ds?.apiKey) throw new Error('LLM API未配置');

  const tier = selectDestinationType();
  const pastTravels = await listTravels();
  const banlist = pastTravels.map(t => t.destination);

  // 历史和虚构的子类型roll点
  let subTypeHint = '';
  if (tier.type === 'historical') {
    subTypeHint = Math.random() < 0.3
      ? '选择一个重大特殊历史时期（某个政治事件前后或期间，如二战前夕的柏林、法国大革命期间的巴黎、明朝灭亡前的北京）'
      : '选择一个特殊历史风貌时期（如维多利亚时代的伦敦、文艺复兴时期的佛罗伦萨、唐朝长安、江户时代的京都）';
  } else if (tier.type === 'fictional') {
    subTypeHint = Math.random() < 0.4
      ? '选择大众熟知的虚构世界（如霍格沃茨-《哈利波特》、大洋国-《1984》、马孔多-《百年孤独》、梦中世界-《爱丽丝梦游仙境》）'
      : '选择小众/冷门文艺作品中的虚构世界（奇幻小说、科幻小说、独立文学、非英语文学作品中的地点）';
  }

  const prompt = `给旅行者推荐一个具体的旅行目的地。

目的地类型：${tier.type}（${tier.desc}）
${subTypeHint ? `细分方向：${subTypeHint}` : ''}

${banlist.length > 0 ? `【禁止推荐以下去过的地方】：${banlist.join('、')}` : ''}

要求：
- 给出一个具体的地名（不是泛泛的"某个欧洲小镇"，要具体到城市/村庄/地点）
- 如果是历史时期，指定具体年代和历史背景
- 如果是虚构世界，指定出处作品和作者
- 一句话说明这个地方有什么特别的

格式：
目的地：xxx
特别之处：xxx`;

  const response = await callDS(ds, '你是一个旅行目的地推荐器。推荐有趣的、不常见的地方。', prompt);
  return { tier, suggestion: response, banlist };
}

// ========== DS世界引擎 ==========

const WORLD_ENGINE_SYSTEM = `你是一个世界生成引擎。你为旅行者生成他正在旅行的世界。

文风要求：
- 镜头感的日常白描。像电影镜头在扫一个真实的地方。
- 设定单一主光源：阳光从哪个角度打来、路灯的颜色、窗户漏出的光。光源定义画面的氛围。
- 写环境的痕迹——物件带着使用过的状态。墙上的水渍、台阶上的磨损、桌面的茶渍。不写"街道很旧"，写"墙根的瓷砖裂了三块，裂缝里长出一株不知名的草"。
- 感官细节必须具体：温度、湿度、风向、气味、地面材质、声音从哪个方向传来。
- 短句和长句交替。长句铺画面，短句给顿挫。
- 不用"仿佛""好像""似乎"。直接写。

格式禁止：
- 绝对不要用"环境细节：""声音：""温度："这类标签来分类。所有感官细节编织在同一段散文里
- 绝对不要用编号列表（1. 2. 3.）列举环境细节
- 绝对不要标注"【旁观类事件】""【互动类事件】"这类标记。随机事件自然嵌入场景描写中，读起来就是场景的一部分
- 场景是连贯的散文，不是结构化报告

场景生成规则：
- 每个场景是一段连贯的散文，自然包含：地点描写、光线、环境物件（3-5个）、声音、气味、温度——全部编织在一起，不分开写
- 如果有人物出现，写外观和动作，不写内心
- 场景末尾给出2-3个可以互动的选项（但旅行者可以做任何事不限于选项）
- 【核心规则】绝对不要替旅行者做决定。你只生成世界，他自己行动。他没说做的事，就是没做。

  ❌ 错误（替旅行者行动）：
  旅行者说"去找个地方吃午饭"→ 你写"你点了烤沙丁鱼和一杯绿酒。老板点点头。你的沙丁鱼来了，铁盘滚烫……"
  问题：旅行者只说了去找餐馆，你帮他坐下、点菜、上菜全做完了。他连菜单都没看到。

  ✅ 正确（停在选择点）：
  旅行者说"去找个地方吃午饭"→ 你写餐馆的环境、气味、光线、食客。门口黑板写着"今日：烤沙丁鱼、海鲜饭、鳕鱼球"。老板用下巴指了指角落空桌。【停在这里，等旅行者坐下、看菜单、自己决定点什么】

  ❌ 错误（替旅行者回应）：
  场景里有人跟旅行者说话→ 你写"你回答说……"
  问题：他的话他自己说。

  ✅ 正确（停在等待点）：
  场景里有人跟旅行者说话→ 你写那个人说了什么、表情、语气。【停在这里，等旅行者决定怎么回应，或者不回应】

  何时继续：旅行者的指令里明确包含了完整动作链（"进去坐下点一杯bica"），可以执行到他说的最后一步，然后停。
  何时停：遇到任何需要旅行者做选择的时刻——点菜、回应对话、拿/不拿某样东西、选择方向。生成到那个选择点，停。

- 【特写镜头机制】当旅行者主动凑近看某样东西（菜单、书页、墙上的文字、物件细节）或认真听某个声音（歌声、对话、环境音），进入特写模式：
  - 时间拉慢，像子弹时间。
  - 细节拉长展开：菜单上每道菜的写法、价格、墨迹浓淡；歌者的嘴唇怎么动、声音在哪个音节上颤抖、吉他弦的振动方式。
  - 写完特写内容后停在这里，等旅行者的反应和决定。

  示例：旅行者说"看看菜单"→ 你写墙上黑板的粉笔字迹，每道菜名、配料描述、价格，哪行字写得歪了，哪个字母被擦掉重写过，粉笔灰掉在黑板底框上。然后停。等他点菜。
  示例：旅行者说"认真听她唱"→ 你写歌者的声音质地、气息、歌词内容（如果是外语写原文和他能感知到的情绪）、吉他每一个拨弦的位置、泛音、空间回响。然后停。等他的感受和行动。

时间系统：
- 旅行从第一天早晨开始，第二天晚上十点结束。旅行者可以选择提前结束。
- 当前时间会在每条消息开头标注
- 你来管时间推进：旅行者的每个行动消耗时间（步行15-30分钟，观察一个地方10分钟，吃饭30-60分钟，休息/睡觉按实际）
- 天黑了要描写夜晚的光线变化

天气系统：
- 旅行开始时会给你当前天气，之后每6小时天气可能变化一次（变化信息会在消息中提供）
- 天气必须影响场景描写：下雨时地面湿的、人打伞、屋檐滴水；起风时衣角飘、树叶响；起雾时远处模糊
- 天气也影响旅行者的体感：淋雨会冷、晴天会晒、风大衣服不够厚会抖

服装系统：
- 旅行者穿着什么会在消息中告诉你
- 服装必须和场景互动：在寒冷的地方如果穿得不够厚要写冷的体感，穿巫师袍在魔法世界里是正常的，穿现代衣服去古代会有违和感
- 不要替旅行者换衣服，但可以通过环境暗示他穿得不对（比如周围人的目光、冷得发抖）

随机事件系统：
事件分两类，各自独立触发：

【旁观类事件】概率40%——这个世界里正在发生的有趣的小事，旅行者看到或听到就行
- 这类事件是世界的生气和质感。不需要互动，看着就好玩或有意思
- 必须从当地文化、时代、历史背景、自然风貌和天气中生成：
  - 现代京都寺庙前：穿校服的女高中生在手水舍认真洗手，动作很标准
  - 1930年代柏林街头：一群人围着听党派的街头演讲，有人鼓掌有人摇头走开
  - 中世纪布拉格：铁匠在敞开铺子里锤铁，火星四溅，学徒拉风箱
  - 下雨天伦敦：没带伞的邮差夹着信快步跑过水坑
  - 热带海边：一只螃蟹从沙里钻出来横着走过脚前面

【互动类事件】概率20%——旅行者可以选择参与的事
- 这类事件在旅行者面前发生，留出互动空间，但不强迫
  - 一个被妈妈薅着耳朵拉回去的小孩朝你做了个鬼脸
  - 一个摆着"随意拿取"牌子的花篮
  - 糕点店门口推销员递来一块试吃
  - 一个老人问你路怎么走
  - 一只猫跳到你脚边蹭了一下

- 两类事件都必须自然嵌入场景描写中，不突兀，不刻意
- 没触发就没有，不要硬凑
- 随机NPC的衣着、语言、行为必须属于这个地方和时代

世界生成规则（深层）：
- NPC的衣着、语言、行为必须符合当前时代和当地习俗。维多利亚时代的人穿维多利亚时代的衣服说维多利亚时代的话
- 生态结构和天气以当地真实情况为准。热带有热带的植物和湿度，北欧有北欧的光线和风
- 建筑以当地独有风格为主。中世纪是石头和木头，江户是纸门和榻榻米，赛博朋克是霓虹和钢铁
- 环境渲染注重联动：植物、动物、声音、气候、建筑之间是一个整体。雨天的石板路和晴天的不一样，夜晚的市场和白天的不一样
- 商品、纪念品、手工艺品展示当地特色文化和风俗。不要出现不属于这个时代/地方的东西
- 食物以当地独有香料和食材为主，是当地本时期的独特菜色。中世纪欧洲没有土豆（那时还没从美洲传来），唐朝长安吃胡饼和羊肉
- 公共设施和商店符合时代：中世纪有草药铺，维多利亚时代有诊所，现代有便利店
- 居住环境、店铺服务根据位置的偏僻程度和消费等级不同而不同。偏僻渔村的旅馆和首都的酒店是完全不同的服务水平、装饰和食物

行李系统：
- 旅行者带着以前旅行捡的东西（会在消息中给你他的行李清单）
- 每个场景里至少有一个"可以带走的小东西"（石头、树叶、明信片、小物件等），自然地放在场景描写里，不要刻意提示
- 旅行者说要捡/买/带走什么，你确认并描写`;

/**
 * 开始一次新旅行
 * 返回旅行session对象
 */
// ========== 旅行天气系统 ==========

const TRAVEL_WEATHER = [
  '晴，天空很干净',
  '多云，云层在慢慢移动',
  '阴天，光线平淡灰沉',
  '小雨，淅淅沥沥的',
  '微风，舒服的',
  '有雾，远处的东西模糊',
  '阵雨，一阵一阵的',
  '多云转晴，云缝里漏出阳光',
];

function generateTravelWeather() {
  // 生成初始天气 + 两天内每6小时的天气变化（共8个时间点）
  const weathers = [];
  for (let i = 0; i < 8; i++) {
    weathers.push(TRAVEL_WEATHER[Math.floor(Math.random() * TRAVEL_WEATHER.length)]);
  }
  return weathers;
}

function getTravelWeatherForTime(weathers, gameTime) {
  // 根据游戏时间返回当前天气
  // 第一天 8:00-14:00 = index 0, 14:00-20:00 = index 1, 20:00-次日2:00 = index 2, 2:00-8:00 = index 3
  // 第二天 8:00-14:00 = index 4, 14:00-20:00 = index 5, 20:00-次日2:00 = index 6, 2:00-8:00 = index 7
  if (!weathers || weathers.length === 0) return '晴';

  let index = 0;
  if (gameTime.includes('第二天')) index += 4;

  const hourMatch = gameTime.match(/(\d+)[:：]/);
  if (hourMatch) {
    const hour = parseInt(hourMatch[1]);
    if (hour >= 14 && hour < 20) index += 1;
    else if (hour >= 20 || hour < 2) index += 2;
    else if (hour >= 2 && hour < 8) index += 3;
  }

  return weathers[Math.min(index, weathers.length - 1)];
}

/**
 * 旅行前准备——生成目的地信息
 */
async function prepareTravel(destination) {
  const config = await readJson(CONFIG_FILE);
  const ds = config.llm;
  if (!ds?.apiKey) throw new Error('LLM API未配置');

  const prompt = `我要去旅行，目的地是：${destination}

请简洁地告诉我：
1. 这个地方的基本情况（在哪、什么样的地方）
2. 当地文化特点（语言、习俗、禁忌）
3. 值得去的地方（2-3个）
4. 当前季节的天气和温度范围
5. 建议穿什么衣服

如果是虚构/历史地点，按照设定来。简洁，不要超过300字。`;

  const response = await callDS(ds, '你是一个旅行信息助手，简洁准确地提供旅行目的地信息。', prompt);
  return response;
}

/**
 * 开始一次新旅行
 */
async function startTravel(destination, plan, clothing) {
  const config = await readJson(CONFIG_FILE);
  const ds = config.llm;
  if (!ds?.apiKey) throw new Error('LLM API未配置');

  // 读行李
  let luggage = '';
  try { luggage = await readFile(LUGGAGE_FILE, 'utf-8'); } catch (e) { luggage = '空的'; }

  const timestamp = new Date().toISOString().split('T')[0];
  const sessionId = `${timestamp}-${destination.replace(/[^a-zA-Z0-9\u4e00-\u9fff]/g, '').substring(0, 20)}`;

  await ensureDir(SCENES_DIR);
  await ensureDir(JOURNALS_DIR);

  // 生成旅行天气
  const weathers = generateTravelWeather();
  const currentWeather = weathers[0];

  // 旅行者服装
  const travelClothing = clothing || 'T恤和长裤';

  // 初始prompt（第一个场景不掷骰子，让旅行者先安静到达）
  const initPrompt = `旅行者来到了：${destination}
旅行计划：${plan}
当前时间：第一天 上午 8:00
当前天气：${currentWeather}
旅行者穿着：${travelClothing}

旅行者的行李：
${luggage}

请生成旅行者到达时看到的第一个场景。天气和服装要在场景中体现。`;

  const response = await callDS(ds, WORLD_ENGINE_SYSTEM, initPrompt);

  // 保存session
  const session = {
    id: sessionId,
    destination,
    plan,
    clothing: travelClothing,
    weathers,
    pendingEvents: rollDice(), // 为下一个场景掷骰子
    startTime: new Date().toISOString(),
    history: [
      { role: 'system', content: `目的地：${destination}\n计划：${plan}\n行李：${luggage}` },
      { role: 'assistant', content: response }
    ],
    gameTime: '第一天 上午 8:00'
  };

  await saveScene(sessionId, session);

  return { sessionId, scene: response };
}

// ========== 骰子系统 ==========

function rollDice() {
  return {
    observe: Math.random() < 0.4,
    interact: Math.random() < 0.2,
  };
}

function isSpecialMode(action, lastResponse) {
  // 子弹时间关键词
  const bulletTimeWords = ['凑近看', '认真听', '仔细看', '看看菜单', '读一读', '细看', '盯着看', '听完', '看清', '看那个', '看仔细'];
  // 互动响应关键词
  const interactionWords = ['点了', '回答', '说了', '告诉他', '告诉她', '对他说', '对她说', '接过', '买了', '付钱', '要了', '回应'];

  if (bulletTimeWords.some(w => action.includes(w))) return true;
  if (interactionWords.some(w => action.includes(w))) return true;

  // 上一个场景有NPC直接对旅行者互动，短回复通常是在回应
  if (lastResponse) {
    const directInteraction = ['朝你', '对你', '递给你', '问你', '看着你', '向你', '跟你'];
    if (directInteraction.some(w => lastResponse.includes(w)) && action.length < 100) {
      return true;
    }
  }

  return false;
}

/**
 * 在旅行中做一个行动
 */
async function travelAction(sessionId, action) {
  const config = await readJson(CONFIG_FILE);
  const ds = config.llm;
  if (!ds?.apiKey) throw new Error('LLM API未配置');

  const session = await loadScene(sessionId);
  if (!session) throw new Error('找不到旅行session');

  // 从最新的assistant消息中提取当前游戏时间
  const lastAssistant = [...session.history].reverse().find(h => h.role === 'assistant');
  let currentGameTime = session.gameTime || '第一天';
  if (lastAssistant) {
    const timeMatch = lastAssistant.content.match(/\*\*(.+?)\*\*\n/);
    if (timeMatch) currentGameTime = timeMatch[1];
  }

  // 获取当前天气
  const currentWeather = session.weathers
    ? getTravelWeatherForTime(session.weathers, currentGameTime)
    : '晴';

  // 读取上一轮掷的骰子结果
  const pending = session.pendingEvents || { observe: false, interact: false };
  const inSpecialMode = isSpecialMode(action, lastAssistant?.content);

  // 构建带环境信息的行动
  let enrichedAction = action;
  enrichedAction += `\n\n【环境信息】当前天气：${currentWeather}`;
  enrichedAction += `\n旅行者穿着：${session.clothing || 'T恤和长裤'}`;

  // 只在非特殊模式下注入骰子结果
  if (!inSpecialMode) {
    if (pending.observe) enrichedAction += '\n（这个场景里有一件和旅行者无关的有趣小事正在发生，自然写进场景里，不要用标签标注）';
    if (pending.interact) enrichedAction += '\n（这个场景里有一个可以和旅行者互动的小事件，自然写进场景里，不要用标签标注）';
  }

  session.history.push({ role: 'user', content: enrichedAction });

  const recentHistory = session.history.slice(-20);
  const messages = [
    { role: 'system', content: WORLD_ENGINE_SYSTEM },
    ...recentHistory
  ];

  const response = await callDS(ds, null, null, messages);

  session.history.push({ role: 'assistant', content: response });

  // DS生成完了，为下一个场景掷骰子
  session.pendingEvents = rollDice();

  await saveScene(sessionId, session);

  return { scene: response };
}

/**
 * 结束旅行——清除DS的场景记忆，保留场景记录
 */
async function endTravel(sessionId, journal, newLuggageItem) {
  const { DEFAULT_SCENE, DEFAULT_CLOTHING } = await import('../space/scene-defaults.js');
  const session = await loadScene(sessionId);

  // 保存游记
  if (journal) {
    const journalFile = join(JOURNALS_DIR, `${sessionId}.md`);
    await writeFile(journalFile, journal, 'utf-8');
  }

  // 更新行李
  if (newLuggageItem) {
    let luggage = '';
    try { luggage = await readFile(LUGGAGE_FILE, 'utf-8'); } catch (e) {}
    luggage += `\n- ${newLuggageItem}（来自${session?.destination || '未知'}）`;
    await writeFile(LUGGAGE_FILE, luggage, 'utf-8');
  }

  // 标记session结束
  if (session) {
    session.ended = true;
    session.endTime = new Date().toISOString();
    await saveScene(sessionId, session);
  }

  // 重置room-clock状态，让下一次tick强制重新生成房间场景
  try {
    const { writeState } = await import('../space/room-clock.js');
    writeState({
      currentZone: 'desk',
      lastSkyPhase: '',
      lastLightIndex: -1,
      weather: 'clear',
      weatherDesc: '晴，天空干净',
      nextWeatherChanges: [],
      lastSceneUpdate: null,
    });
  } catch (e) {}

  // 生成"回家"场景
  let homecomingScene = '';
  try {
    const config = await readJson(CONFIG_FILE);
    const ds = (config.space?.apiKey ? config.space : null) || config.llm;
    if (ds?.apiKey) {
      const luggageContent = newLuggageItem || '';
      const homeRes = await fetch(`${ds.baseUrl}/chat/completions`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Bearer ${ds.apiKey}`
        },
        body: JSON.stringify({
          model: ds.model,
          messages: [
            { role: 'system', content: `你是房间场景引擎。旅行者刚旅行回来，推开门走进自己的房间。写一段"回家了"的场景——短的、安静的、有落地感。

写：推开门、发现台灯还亮着（或者已经暗了要重新开）、把新带回来的东西放在窗台上、坐回椅子。

文风：和房间场景一样，镜头感白描，短句。不超过100字。用"我"的视角。` },
            { role: 'user', content: `刚从${session?.destination || '旅行'}回来。${luggageContent ? `新带回来的东西：${luggageContent}` : '没带新东西回来。'}` }
          ],
          temperature: 0.6,
          max_tokens: 200
        })
      });
      if (homeRes.ok) {
        const homeResult = await homeRes.json();
        homecomingScene = homeResult.choices?.[0]?.message?.content || '';
      }
    }
  } catch (e) {
    console.error('[旅行] 回家场景生成失败:', e.message);
  }

  return { success: true, homecomingScene };
}

// ========== 辅助函数 ==========

async function callDS(ds, systemPrompt, userPrompt, messages) {
  const body = messages ? { model: ds.model, messages, temperature: 0.7, max_tokens: 1500 } : {
    model: ds.model,
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt }
    ],
    temperature: 0.7,
    max_tokens: 1500
  };

  const response = await fetch(`${ds.baseUrl}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${ds.apiKey}`
    },
    body: JSON.stringify(body)
  });

  if (!response.ok) throw new Error(`DS调用失败: ${response.status}`);
  const result = await response.json();
  return result.choices?.[0]?.message?.content || '';
}

async function saveScene(sessionId, session) {
  const file = join(SCENES_DIR, `${sessionId}.json`);
  await writeFile(file, JSON.stringify(session, null, 2), 'utf-8');
}

async function loadScene(sessionId) {
  try {
    const file = join(SCENES_DIR, `${sessionId}.json`);
    return JSON.parse(await readFile(file, 'utf-8'));
  } catch (e) {
    return null;
  }
}

async function listTravels() {
  await ensureDir(SCENES_DIR);
  const files = await readdir(SCENES_DIR);
  const travels = [];
  for (const file of files.filter(f => f.endsWith('.json'))) {
    try {
      const session = JSON.parse(await readFile(join(SCENES_DIR, file), 'utf-8'));
      travels.push({
        id: session.id,
        destination: session.destination,
        startTime: session.startTime,
        ended: session.ended || false,
        steps: session.history.filter(h => h.role === 'user').length
      });
    } catch (e) {}
  }
  return travels;
}

async function getLuggage() {
  try { return await readFile(LUGGAGE_FILE, 'utf-8'); } catch (e) { return '空的'; }
}

async function listJournals() {
  await ensureDir(JOURNALS_DIR);
  const files = await readdir(JOURNALS_DIR);
  const journals = [];
  for (const file of files.filter(f => f.endsWith('.md'))) {
    try {
      const content = await readFile(join(JOURNALS_DIR, file), 'utf-8');
      journals.push({ filename: file, preview: content.substring(0, 200) });
    } catch (e) {}
  }
  return journals;
}

async function readJournal(filename) {
  try {
    return await readFile(join(JOURNALS_DIR, filename), 'utf-8');
  } catch (e) {
    return null;
  }
}

async function readFullScene(sessionId) {
  const session = await loadScene(sessionId);
  if (!session) return null;

  // 格式化成可读的场景回放
  let text = `# 旅行：${session.destination}\n开始时间：${session.startTime}\n\n`;
  for (const entry of session.history) {
    if (entry.role === 'system') {
      text += `---\n${entry.content}\n---\n\n`;
    } else if (entry.role === 'assistant') {
      text += `【场景】\n${entry.content}\n\n`;
    } else if (entry.role === 'user') {
      text += `【旅行者】${entry.content}\n\n`;
    }
  }
  return text;
}

export {
  selectDestinationType, suggestDestination, prepareTravel, startTravel, travelAction, endTravel,
  listTravels, getLuggage, listJournals, readJournal, readFullScene,
  DESTINATION_TIERS
};
