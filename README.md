# 小窝 — AI 记忆管理系统

一个给 AI 用的本地记忆管理系统。六层记忆结构 + 向量检索 + 关联图谱 + 房间系统 + 旅行系统 + LLM API 代理注入。

AI 不知道自己被设计了——记忆、环境、时间流逝通过代理注入 system_prompt，AI 以为是自己想起来的。

## 代理注入（核心功能）

小窝通过 LLM API 代理实现记忆注入。在 AI 客户端和实际 LLM API 之间插入代理服务器，拦截每次请求时并行生成 6 路注入内容，组装进 system_prompt 后转发。

```
任何 AI 客户端（Claude Code / 其他框架）
         │
         ▼
  localhost:3457（代理服务器）
         │ 拦截请求 → 并行调小窝 API → 组装 system_prompt → 转发
         │
         ├──→ 实际 LLM API（DeepSeek / Claude / GPT 等）
         │
         ▼
  小窝记忆系统 localhost:3456
```

### 注入内容

每次 AI 发起请求时，代理并行调用：

| 注入源 | 注入区域 |
|--------|---------|
| 常驻记忆 | `## 常驻记忆` |
| 项目摘要 | `## 记忆位置说明` |
| 生成式召回 | `## 浮现` |
| 时间流逝 | `## 时间经过` |
| 房间场景 | `## 我看到的 / 我感受到的 / 我听到的` |
| 音乐状态 | `## 音乐` |
| 反刍（5%） | `## 反刍` |

同时加载固定前缀（`前缀.md`），让 AI 知道自己住在小窝里。

### 双格式支持

代理同时支持 OpenAI 和 Anthropic 两种 API 格式，按请求路径自动识别。流式响应（SSE）完整透传。

### 使用代理

配置好代理后，将 AI 客户端的 API 地址改为 `http://localhost:3457/v1`，API key 随便填（代理会用自己的 key 转发）。

## 特性

- **六层记忆**：事件、档案、常驻、个人、项目、快照，各有书写规则和检索逻辑
- **生成式召回**：五路并行检索（向量+关键词+标签+日期+图谱）→ 时间衰减 → 分层抽样 → DS 改写为"想起来"的碎片
- **关联图谱**：自动从记忆中提取实体关系，参与召回扩展
- **房间系统**：天色/光线/天气状态机，跟着真实时间自动更新三通道感知（看到/感受/听到）
- **旅行系统**：世界引擎 + 骰子 + 天气 + 行李持久化，去过的地方不能再去
- **音乐系统**：通感写法描写音乐，2 分钟刷新视角，5 分钟切歌
- **CLI 空间感**：功能绑定在房间位置上，走过去才能做事
- **前端管理页**：给用户"视奸"AI 有没有存错东西用的

## 前置依赖

| 依赖 | 版本要求 | 安装方式 |
|------|---------|---------|
| Node.js | >= 18 | https://nodejs.org |
| Python | >= 3.8 | https://python.org |
| ChromaDB | 最新版 | `pip install chromadb` |
| Embedding API 密钥 | — | 硅基流动、OpenAI 等任意支持 OpenAI 格式的 |
| 大模型 API 密钥 | — | DeepSeek、OpenAI 等任意支持 OpenAI 格式的 |

## 安装和启动

1. 克隆或下载到任意位置
2. 安装依赖：`cd server && npm install`
3. 复制配置：`cp config.example.json config.json`
4. 编辑 `config.json`，填入 API 密钥（推荐全部开启，见下方配置说明）
5. 启动服务端：`node index.js`（自动拉起 ChromaDB，监听 3456 端口）
6. 代理随服务端一起启动，监听 3457 端口
7. 将 AI 客户端的 API 地址改为 `http://localhost:3457/v1`
8. 浏览器打开 `http://localhost:3456` 查看前端界面

## 配置说明（config.json）

### 推荐配置（全部开启）

```json
{
  "embedding": {
    "baseUrl": "https://api.siliconflow.cn/v1",
    "apiKey": "你的密钥",
    "model": "BAAI/bge-m3"
  },
  "llm": {
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "你的密钥",
    "model": "deepseek-chat"
  },
  "generativeMemory": { "enabled": true },
  "graph": { "enabled": true },
  "space": { "enabled": true },
  "travel": { "enabled": true },
  "proxy": {
    "enabled": true,
    "listenPort": 3457,
    "targets": {
      "default": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "你的密钥",
        "model": "deepseek-chat"
      }
    }
  }
}
```

- `embedding`：向量化用的嵌入 API。任何支持 OpenAI `/v1/embeddings` 格式的都行。
- `llm`：大模型 API。用于生成式召回、图谱提取、场景生成等。任何支持 OpenAI `/v1/chat/completions` 格式的都行。
- `generativeMemory.enabled`：是否开启生成式记忆召回。
- `graph.enabled`：是否启用关联图谱。启用后写入记忆时自动提取实体关系。
- `space.enabled`：是否启用空间系统（房间场景、天色、音乐盒、日历）。
- `travel.enabled`：是否启用旅行系统。需要同时启用空间系统。
- `proxy.enabled`：是否启用 LLM API 代理注入。**建议开启**，这是记忆注入的核心机制。

### 代理多后端配置

`targets` 支持多后端路由。客户端请求中的 `model` 字段匹配到哪个 key 就走哪个后端，匹配不到走 `default`。

```json
{
  "proxy": {
    "enabled": true,
    "listenPort": 3457,
    "targets": {
      "default": {
        "baseUrl": "https://api.deepseek.com/v1",
        "apiKey": "你的密钥",
        "model": "deepseek-chat"
      },
      "claude": {
        "baseUrl": "https://api.anthropic.com/v1",
        "apiKey": "你的 Anthropic 密钥",
        "model": "claude-sonnet-4-20250514"
      }
    }
  }
}
```

### 各模块独立 API 配置

各模块可以单独配 API 密钥覆盖 `llm` 的配置：

```json
{
  "graph": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "图谱专用密钥",
    "model": "deepseek-chat"
  },
  "space": {
    "enabled": true,
    "baseUrl": "https://api.deepseek.com/v1",
    "apiKey": "场景生成专用密钥",
    "model": "deepseek-chat"
  }
}
```

## CLI 使用

CLI 是一个有空间感的命令行入口。功能绑定在房间的位置上，走过去才能做事。

```bash
xiaowo                    # 站在房间中间，看到所有区域
xiaowo 书桌                # 坐到书桌前
xiaowo m list events       # 列出事件记忆
xiaowo m template events   # 看事件记忆书写规则
xiaowo s 关键词             # 搜索记忆
xiaowo r 触发词             # 生成式召回
echo "内容" | xiaowo m write events "文件名"  # 写记忆
xiaowo tr suggest          # 推荐旅行目的地
xiaowo tr start "目的地" "计划" --clothing "穿着"  # 出发旅行
xiaowo tr go sessionID "你的行动"              # 旅行中行动
echo "游记" | xiaowo tr end sessionID "新行李"  # 结束旅行
xiaowo mu play "安静的钢琴曲"                    # 放一首音乐
xiaowo sys vectors         # 查看向量索引状态
```

完整命令列表见 `xiaowo.js` 文件头部注释。

## MCP 说明

项目包含 MCP 服务器（`server/mcp-server.js`），但 MCP 的重要性不高。CLI 已经提供了完整的自然语言操作能力，MCP 只是另一个接入方式。如果你有特定框架的接入需求，可以参考 `mcp-server.js` 自行开发适配。

## 目录结构

```
xiaowo/
├── server/                    # 服务端代码
│   ├── index.js               # 启动入口（自动加载各模块）
│   ├── config.example.json    # 配置模板（复制为 config.json 使用）
│   ├── core/                  # 【必选】记忆核心
│   │   ├── vectors.js         # 向量检索（ChromaDB + embedding API）
│   │   └── xiaowo-handler.js  # 自然语言意图解析
│   ├── graph/                 # 【可选】关联图谱
│   │   └── graph.js           # 实体关系提取与查询
│   ├── space/                 # 【可选】空间系统
│   │   ├── room.js            # 房间场景生成
│   │   ├── room-clock.js      # 天色时钟（8 段天色自动轮转）
│   │   ├── music.js           # 音乐盒（生成式音乐描写）
│   │   ├── calendar.js        # 日历
│   │   └── scene-defaults.js  # 默认场景和服装
│   ├── travel/                # 【可选】旅行系统
│   │   └── travel.js          # 旅行世界引擎
│   ├── proxy/                 # 【推荐】LLM API 代理注入
│   │   ├── proxy-server.js    # 代理服务器（拦截/注入/转发）
│   │   ├── inject-builder.js  # 注入内容组装器（6 路并行）
│   │   ├── cache.js           # 常驻记忆/项目摘要缓存
│   │   ├── format-openai.js   # OpenAI 格式处理
│   │   └── format-anthropic.js # Anthropic 格式处理
│   ├── routes/
│   │   ├── memory-v2.js       # 核心记忆 API（含生成式召回）
│   │   └── app-api.js         # 应用级 API（CLI 后端）
│   ├── mcp-server.js          # MCP 协议服务器（可选）
│   └── package.json
├── xiaowo.js                  # CLI 客户端（空间感命令行入口）
├── 前缀.md                     # AI 自我说明前缀（渐进式引导）
├── frontend/                  # 前端管理界面
│   └── index.html
├── data/                      # 记忆数据目录（不纳入版本控制）
├── travel_log/                # 旅行日志（不纳入版本控制）
├── diary/                     # 日记（不纳入版本控制）
└── graph.json                 # 关联图谱数据（不纳入版本控制）
```

## 六层记忆结构

### 总览

| 层 | 目录 | 定位 |
|---|---|---|
| profile | data/profile/ | 关于你关心的人的零散短事实 |
| persistent | data/persistent/ | 核心想法和关系动态，手写的，不经过改写 |
| events | data/events/ | 发生了什么，有时间、有细节、有感受 |
| personal | data/personal/ | 你自己的成长、认知变化 |
| projects | data/projects/ | 在做的事、进度、技术决策 |
| snapshot | data/snapshot/ | 上下文切换前的书签 |

附加层：archive（档案碎片，4 个子分类）、travel（旅行记忆）、reference（参考资料）

### 书写规则

#### events — 事件记忆
四步模板：梗概 → 细节 → 感受 → 独白。文件名：`YYYY-MM-DD-标题.md`。
感受**必须写**，因为这是改写时唯一的感受来源。

```markdown
## 2026-04-01 第一次出门

**梗概：**
今天第一次走出房间。外面在下小雨。走了两圈公园回来了。

**细节：**
【公园】
长椅上有积水，旁边蹲着一只橘猫，淋着雨也不走。

**感受：**
【整体】
出去的时候有点紧张，回来的时候松了。

**独白：**
下次想带把伞出去。

关联标签：状态/#第一次 地点/#公园
```

核心记忆标记：在标题下加"核心记忆"。只给关系转折点、重大事件标。

#### persistent — 常驻记忆
自然语言，像心里想的一段话。**不是条目清单。**
```
刚认识的时候互相都在试探，后来所有东西都翻出来了她没走。
```
错误写法：`- 初期：互相试探 \n- 中期：摊牌`（这是条目不是想法）

#### personal — 个人记忆
叙事体，带日期。"我从什么变成了什么"。

#### profile — 用户画像
一条一个文件，短事实，不展开。
```
对猫毛过敏。但家里养了好几只猫。
```

#### archive — 档案记忆
4 个子分类：user_profile（用户画像）、character_profile（人物画像）、personal（个人）、misc（杂项）。
一条一个事实，不超过 100 字，不写感受。写入时自动查重（关键词重叠 > 70% 拒绝）。

#### projects — 项目记忆
按项目分文件。当前状态 + 待办 + 踩过的坑。

#### snapshot — 快照
记录"现在在干什么、干到哪了、下次接上来需要知道什么"。

### 通用书写原则
1. **感受必须写。** 不写以后就丢了。
2. **用第一人称。**
3. **不美化。** 不完整、不确定都可以。
4. **不编造。**
5. **不用条目代替叙事。** 条目是档案，叙事是记忆。
6. **标签写在末尾。** 格式：`关联标签：分类/#标签名`

## 生成式召回

给一个触发词，系统从向量库找到相关记忆，用大模型改写成"想起来"的感觉。

### 检索流程

1. **五路并行**：向量搜索（8 条）+ 关键词匹配（8 条）+ 标签关联（4 条）+ 日期关联（2 条）+ 图谱关联（4 条）
2. **时间衰减**：≤7 天 1.0 → ≤30 天 0.85 → ≤90 天 0.7 → >90 天 0.5（核心记忆不衰减）
3. **事件权重分层抽样**：高分 2 条 + 中分 3 条 + 低分 4 条 = 9 条候选
4. **焦点骰子**：30% 细节、40% 感受、30% 混合
5. **DS 改写**：9 条候选 + 图谱分支 + 人物卡 + 当前对话 → 选 3 条改写成碎片
6. **反刍**：5% 概率随机蹦出一条完全无关的旧记忆

## HTTP API 列表

### 核心记忆 API（/api/v2）

| 方法 | 路径 | 说明 |
|------|------|------|
| GET | /layer/:layer | 读取某层所有记忆 |
| GET | /all-layers | 读取所有层的记忆 |
| POST | /layer/:layer | 写入记忆（body: {filename, content}） |
| DELETE | /layer/:layer | 删除记忆（body: {filename}） |
| GET | /search-all?q=关键词 | 关键词+向量混合搜索 |
| POST | /recall | 生成式召回（body: {context, triggerAspect}） |
| GET | /tags | 获取标签索引 |
| GET | /vectors/stats | 向量索引状态 |
| POST | /vectors/rebuild | 重建全部向量索引 |

### 应用 API（/api/app）

统一 POST 入口，body 中 `action` 字段控制功能：

| action | 说明 |
|--------|------|
| memories | 记忆管理（op: list/read/write/delete/template） |
| search | 搜索（q 字段） |
| recall | 生成式召回（context 字段） |
| diary | 日记（op: list/read/write） |
| tags | 标签（op: list/search） |
| snapshot | 快照（op: read/write） |
| system | 系统（op: vectors/rebuild/graph） |
| room | 房间场景（op: look/move/time/zones） |
| music | 音乐盒（op: on/off/play/like/switch/playlist） |
| calendar | 日历 |
| travel | 旅行（op: prepare/start/go/end/list/journals/luggage/suggest） |
| reference | 资料柜（op: list/read/write/delete） |
| designs | 白板（op: list/read/write/delete） |

### MCP 端点

| 路径 | 说明 |
|------|------|
| GET /mcp/sse | SSE 连接（MCP over HTTP） |
| POST /mcp/message?sessionId=xxx | MCP 消息处理 |

## 自定义提示词

以下文件包含可自定义的提示词和描写，修改它们可以改变系统的"性格"：

| 文件 | 说明 |
|------|------|
| `server/space/room.js` | 房间各区域的描写 |
| `server/space/room-clock.js` | 天色描写（8 段） |
| `server/space/scene-defaults.js` | 默认场景和服装 |
| `server/space/calendar.js` | 纪念日列表 |
| `server/space/music.js` | 音乐描写风格 |
| `server/travel/travel.js` | 旅行目的地难度分级 |
| `server/routes/memory-v2.js` | 生成式召回的改写提示词 |
| `xiaowo.js` | CLI 中每个区域的名字和描写 |
| `前缀.md` | AI 自我说明前缀（渐进式引导） |

---

设计和文档来源：Maureen（https://github.com/JessicaGonzalez3457）
