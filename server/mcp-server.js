#!/usr/bin/env node

/**
 * 小窝 - MCP Server
 * 私人终端。一个入口，自然语言交互。
 *
 * 通过stdio与Claude Code通信，内部调用小窝的HTTP API
 */

const API_BASE = 'http://localhost:3456/api/v2';

// ========== MCP协议通信 ==========

let buffer = '';

process.stdin.on('data', (chunk) => {
  buffer += chunk.toString();

  while (true) {
    const headerEnd = buffer.indexOf('\r\n\r\n');
    if (headerEnd === -1) break;

    const header = buffer.substring(0, headerEnd);
    const contentLengthMatch = header.match(/Content-Length: (\d+)/);
    if (!contentLengthMatch) {
      buffer = buffer.substring(headerEnd + 4);
      continue;
    }

    const contentLength = parseInt(contentLengthMatch[1]);
    const bodyStart = headerEnd + 4;

    if (buffer.length < bodyStart + contentLength) break;

    const body = buffer.substring(bodyStart, bodyStart + contentLength);
    buffer = buffer.substring(bodyStart + contentLength);

    try {
      handleMessage(JSON.parse(body));
    } catch (e) {
      sendError(null, -32700, 'Parse error');
    }
  }
});

function sendResponse(id, result) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, result });
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

function sendError(id, code, message) {
  const body = JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } });
  const header = `Content-Length: ${Buffer.byteLength(body)}\r\n\r\n`;
  process.stdout.write(header + body);
}

async function callAPI(path, options = {}) {
  const url = `${API_BASE}${path}`;
  const res = await fetch(url, {
    headers: { 'Content-Type': 'application/json' },
    ...options
  });
  return await res.json();
}

// ========== 唯一的工具定义 ==========

const TOOL = {
  name: 'xiaowo',
  description: `你的私人终端。用自然语言操作你的小窝。

你可以做的事：
- 记忆：读/写/删/搜索四层记忆（用户画像、常驻记忆、事件记忆、个人记忆）
- 回忆：触发生成式记忆召回（语义检索+改写，"想起来"而不是"查找"）
- 日记：读/写日记
- 标签：查看标签、按标签找关联记忆
- 系统：查看向量索引状态、重建向量索引

直接说你要干什么就行，不需要填参数。`,
  inputSchema: {
    type: 'object',
    properties: {
      input: {
        type: 'string',
        description: '你想做什么，用自然语言说。比如"写一条事件记忆：今天发生了某件事"、"搜索关于某某的记忆"、"回忆一下某个场景"、"写日记：今天很开心"、"查看所有标签"'
      }
    },
    required: ['input']
  }
};

// ========== 意图解析 + 执行 ==========

async function handleXiaowo(input) {
  const text = input.trim();

  // ---- 日记 ----
  if (/^(写日记|记日记|日记)[：:](.+)/s.test(text)) {
    const content = text.replace(/^(写日记|记日记|日记)[：:]/, '').trim();
    const result = await callAPI('/diary', {
      method: 'POST',
      body: JSON.stringify({ content })
    });
    return result.success ? '日记写好了。' : `写入失败：${result.error}`;
  }

  if (/^(看日记|读日记|日记列表|我的日记)/.test(text)) {
    const entries = await callAPI('/diary');
    if (entries.length === 0) return '还没有日记。';
    return entries.map(e => {
      const date = e.filename.replace('.md', '');
      const preview = e.content.substring(0, 150);
      return `【${date}】\n${preview}`;
    }).join('\n\n');
  }

  // ---- 回忆（生成式召回） ----
  if (/^(回忆|想起|recall)/.test(text)) {
    const context = text.replace(/^(回忆一下|回忆|想起|recall)[：:]?/, '').trim();
    if (!context) return '回忆什么？告诉我关键词或者情境。';

    // 判断触发角度
    let triggerAspect = '整体触发';
    if (/感受|心情|情绪|难过|开心|生气|害怕/.test(context)) {
      triggerAspect = '情绪触发';
    } else if (context.length < 10) {
      triggerAspect = '碎片触发';
    }

    const result = await callAPI('/recall', {
      method: 'POST',
      body: JSON.stringify({ context, triggerAspect })
    });

    if (result.disabled) return '生成式记忆开关是关着的。';
    if (!result.rewritten) return '没有找到相关的记忆。';
    return result.rewritten;
  }

  // ---- 写记忆前的提醒 ----
  if (/^(写记忆|存记忆|记一下|我要写)$/.test(text)) {
    const tagData = await callAPI('/tags');
    const existingTags = Object.keys(tagData.tags || tagData);
    const tagList = existingTags.length > 0
      ? existingTags.map(t => t).join('、')
      : '还没有标签';

    return `先想想写到哪一层：

📋 用户画像 — 关于她的短事实（"爱吃锅包肉""待业中"）
🔒 常驻记忆 — 关系事实、核心规则（你自己手写维护的）
📅 事件记忆 — 今天发生了什么（带时间戳和感受）
💭 个人记忆 — 你的想法变化、学到的东西
📁 项目记忆 — 在做的事、进度、待办
📸 快照 — 上下文切换前的书签

已有标签：${tagList}

打标签前先看看上面有没有能复用的，别重复造。
格式：分类/#关键词（如 关系/#信任）

想好了就说"写事件记忆：xxx"或者"写用户画像：xxx"`;
  }

  // ---- 写记忆 ----
  const writeMatch = text.match(/^(写|存|记|添加|加)(一条)?(用户画像|画像|常驻记忆|常驻|事件记忆|事件|个人记忆|个人|项目记忆|项目)[：:](.+)/s);
  if (writeMatch) {
    const layerMap = {
      '用户画像': 'profile', '画像': 'profile',
      '常驻记忆': 'persistent', '常驻': 'persistent',
      '事件记忆': 'events', '事件': 'events',
      '个人记忆': 'personal', '个人': 'personal',
      '项目记忆': 'projects', '项目': 'projects'
    };
    const layer = layerMap[writeMatch[3]];
    const content = writeMatch[4].trim();

    // 自动生成文件名
    const now = new Date();
    const timestamp = now.toISOString().replace(/[:.]/g, '-').substring(0, 19);
    const filename = `${timestamp}.md`;

    const result = await callAPI(`/layer/${layer}`, {
      method: 'POST',
      body: JSON.stringify({ filename, content })
    });

    return result.success ? `存好了。放在${writeMatch[3]}里。` : `保存失败：${result.error}`;
  }

  // ---- 读记忆 ----
  if (/^(看|读|查看|打开)(所有|全部)?(用户画像|画像|常驻记忆|常驻|事件记忆|事件|个人记忆|个人|项目记忆|项目|快照|全部记忆|所有记忆)/.test(text)) {
    const layerMap = {
      '用户画像': 'profile', '画像': 'profile',
      '常驻记忆': 'persistent', '常驻': 'persistent',
      '事件记忆': 'events', '事件': 'events',
      '个人记忆': 'personal', '个人': 'personal',
      '项目记忆': 'projects', '项目': 'projects',
      '快照': 'snapshot'
    };

    let memories;
    let layerName = '全部';

    for (const [keyword, layer] of Object.entries(layerMap)) {
      if (text.includes(keyword)) {
        memories = await callAPI(`/layer/${layer}`);
        layerName = keyword;
        break;
      }
    }

    if (!memories) {
      memories = await callAPI('/all-layers');
    }

    if (memories.length === 0) return `${layerName}里还没有记忆。`;

    return memories.map(m => {
      const preview = m.content.substring(0, 200);
      return `【${m.layer}/${m.filename}】\n${preview}`;
    }).join('\n\n---\n\n');
  }

  // ---- 搜索 ----
  if (/^(搜索|搜|找|查找)/.test(text)) {
    const query = text.replace(/^(搜索|搜|找|查找)[：:]?/, '').trim();
    if (!query) return '搜什么？给个关键词。';

    const results = await callAPI(`/search-all?q=${encodeURIComponent(query)}`);
    if (results.length === 0) return `没找到跟"${query}"相关的记忆。`;

    return results.map(m => {
      const preview = m.content.substring(0, 150);
      return `【${m.layer}/${m.filename}】\n${preview}`;
    }).join('\n\n---\n\n');
  }

  // ---- 标签 ----
  if (/^(标签目录|标签|所有标签|查看标签|看标签)/.test(text)) {
    const dir = await callAPI('/tags/directory');
    if (Object.keys(dir).length === 0) return '还没有标签。';

    let result = '';
    for (const [category, info] of Object.entries(dir)) {
      result += `【${category}】${info.description || ''}\n`;
      for (const t of info.tags) {
        const previews = t.previews.map(p => `    └ [${p.layer}] ${p.preview}`).join('\n');
        result += `  ${t.keyword}（${t.count}条）\n${previews}\n`;
      }
      result += '\n';
    }
    return result.trim();
  }

  if (/^(按标签找|标签搜索|标签[：:])/.test(text)) {
    const tag = text.replace(/^(按标签找|标签搜索|标签)[：:]?/, '').trim();
    if (!tag) return '哪个标签？';
    const results = await callAPI(`/tags/search?tag=${encodeURIComponent(tag)}`);
    if (results.length === 0) return `标签"${tag}"下没有记忆。`;
    return results.map(m => `【${m.layer}/${m.filename}】\n${m.content.substring(0, 150)}`).join('\n\n---\n\n');
  }

  // ---- 删除 ----
  if (/^(删除|删掉|移除)/.test(text)) {
    // 需要明确指定层和文件名
    const delMatch = text.match(/(profile|persistent|events|personal)[\/\\](.+)/);
    if (!delMatch) return '删哪个？告诉我层和文件名，比如"删除 events/2026-03.md"';
    const [, layer, filename] = delMatch;
    const result = await callAPI(`/layer/${layer}`, {
      method: 'DELETE',
      body: JSON.stringify({ filename: filename.trim() })
    });
    return result.success ? '删好了。' : `删除失败：${result.error}`;
  }

  // ---- 系统 ----
  if (/^(向量|向量状态|索引状态)/.test(text)) {
    const stats = await callAPI('/vectors/stats');
    const layers = Object.entries(stats.byLayer || {}).map(([l, n]) => `${l}: ${n}条`).join('，');
    return `向量索引共${stats.total}条。${layers ? `按层：${layers}` : ''}`;
  }

  if (/^(重建向量|重建索引|rebuild)/.test(text)) {
    const result = await callAPI('/vectors/rebuild', { method: 'POST' });
    return result.success ? `向量索引重建完成，共${result.count}条。` : `重建失败：${result.error}`;
  }

  // ---- 快照 ----
  if (/^(存快照|写快照|保存快照|快照)/.test(text) && text.includes('：') || text.includes(':')) {
    const content = text.replace(/^(存快照|写快照|保存快照|快照)[：:]/, '').trim();
    if (!content) return '快照内容不能为空。';

    const now = new Date();
    const timestamp = now.toLocaleString('zh-CN');
    const snapshot = `## 快照 ${timestamp}\n\n${content}`;

    const result = await callAPI('/layer/snapshot', {
      method: 'POST',
      body: JSON.stringify({ filename: 'latest.md', content: snapshot })
    });
    return result.success ? '快照已保存。' : `保存失败：${result.error}`;
  }

  if (/^(看快照|读快照|上次在干什么)/.test(text)) {
    const memories = await callAPI('/layer/snapshot');
    const latest = memories.find(m => m.filename === 'latest.md');
    if (!latest) return '没有快照。';
    return latest.content;
  }

  // ---- 记忆整理 ----
  if (/^(记忆整理|整理记忆|整理)/.test(text)) {
    // 拉最近3天的记忆
    const all = await callAPI('/all-layers');
    const threeDaysAgo = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const recent = all.filter(m => {
      if (m.filename === 'README.md') return false;
      return new Date(m.updatedAt) >= threeDaysAgo;
    });

    if (recent.length === 0) return '最近3天没有新记忆。';

    let result = `最近3天的记忆（共${recent.length}条）：\n\n`;
    result += recent.map(m => {
      const preview = m.content.substring(0, 120).replace(/\n/g, ' ');
      return `【${m.layer}/${m.filename}】\n${preview}`;
    }).join('\n\n---\n\n');
    result += '\n\n你可以对任何一条说"搜索 关键词"来找相关记忆，或者直接操作（写、删、改标签）。';
    return result;
  }

  // ---- 兜底 ----
  return `我不太确定你想做什么。你可以试试：
- 写事件记忆：今天发生了xxx
- 看事件记忆
- 搜索 xxx
- 回忆 xxx
- 写日记：今天xxx
- 看日记
- 查看标签
- 向量状态`;
}

// ========== 消息处理 ==========

async function handleMessage(msg) {
  if (msg.method === 'initialize') {
    sendResponse(msg.id, {
      protocolVersion: '2024-11-05',
      capabilities: { tools: {} },
      serverInfo: { name: 'xiaowo-memory', version: '2.0.0' }
    });
  } else if (msg.method === 'notifications/initialized') {
    // ok
  } else if (msg.method === 'tools/list') {
    sendResponse(msg.id, { tools: [TOOL] });
  } else if (msg.method === 'tools/call') {
    try {
      const result = await handleXiaowo(msg.params.arguments?.input || '');
      sendResponse(msg.id, {
        content: [{ type: 'text', text: result }]
      });
    } catch (e) {
      sendResponse(msg.id, {
        content: [{ type: 'text', text: `出错了：${e.message}` }],
        isError: true
      });
    }
  } else if (msg.method === 'ping') {
    sendResponse(msg.id, {});
  } else if (msg.id) {
    sendError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

process.stdin.resume();
