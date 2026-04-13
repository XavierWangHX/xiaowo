import express from 'express';
import cors from 'cors';
import crypto from 'crypto';
import { readFile, readdir } from 'fs/promises';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { spawn } from 'child_process';
import { memoryV2Routes } from './routes/memory-v2.js';
import { appApiRoutes } from './routes/app-api.js';
import { handleXiaowo, TOOL_DEFINITION } from './core/xiaowo-handler.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

// ========== 读取配置 ==========
const CONFIG_FILE = join(__dirname, 'config.json');
let config = {};
try {
  config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
} catch (e) {
  console.error('读取 config.json 失败，请确认配置文件存在。');
  console.error('提示：复制 config.example.json 为 config.json 并填入 API 密钥。');
  process.exit(1);
}

// ========== 自动启动 ChromaDB ==========
const CHROMA_DATA_PATH = join(__dirname, '..', 'chromadb-data');

async function startChroma() {
  try {
    const res = await fetch('http://localhost:8000/api/v2/heartbeat');
    if (res.ok) {
      console.log('ChromaDB已在运行，跳过启动');
      return;
    }
  } catch (e) {}

  console.log('正在启动ChromaDB...');
  const chromaProc = spawn('chroma', ['run', '--path', CHROMA_DATA_PATH], {
    detached: false,
    stdio: ['ignore', 'pipe', 'pipe']
  });

  chromaProc.stdout.on('data', d => process.stdout.write(`[ChromaDB] ${d}`));
  chromaProc.stderr.on('data', d => process.stderr.write(`[ChromaDB] ${d}`));
  chromaProc.on('exit', code => console.log(`[ChromaDB] 进程退出，code=${code}`));

  for (let i = 0; i < 20; i++) {
    await new Promise(r => setTimeout(r, 500));
    try {
      const res = await fetch('http://localhost:8000/api/v2/heartbeat');
      if (res.ok) {
        console.log('ChromaDB启动成功');
        return;
      }
    } catch (e) {}
  }
  console.warn('ChromaDB启动超时，向量检索可能不可用');
}

await startChroma();

const app = express();
const PORT = 3456;

app.use(cors());
app.use(express.json());

// 静态文件 - 前端页面
app.use(express.static(join(__dirname, '..', 'frontend')));

// ========== 核心API路由（必选） ==========
app.use('/api/v2', memoryV2Routes);
app.use('/api/app', appApiRoutes);

// ========== 图谱数据接口（给前端可视化用） ==========
app.get('/api/graph', async (req, res) => {
  try {
    const data = await readFile(join(__dirname, '..', 'graph.json'), 'utf-8');
    res.json(JSON.parse(data));
  } catch (e) {
    res.json({ entities: {}, relations: [], events: [] });
  }
});

// ========== 人物卡接口（给前端用） ==========
app.get('/api/character-cards', async (req, res) => {
  try {
    const dir = join(__dirname, '..', 'data', 'archive', 'character_profile');
    const files = await readdir(dir).catch(() => []);
    const mdFiles = files.filter(f => (f.endsWith('.md') || f.endsWith('.txt')) && f !== 'README.md');
    const parts = [];
    for (const f of mdFiles) {
      const content = await readFile(join(dir, f), 'utf-8');
      parts.push(`## ${f.replace(/\.(md|txt)$/, '')}\n${content}`);
    }
    res.json({ content: parts.join('\n\n') });
  } catch (e) {
    res.json({ content: '' });
  }
});

// ========== 旅行数据接口（给前端用） ==========
if (config.travel?.enabled) {
  const fs = await import('fs/promises');

  app.get('/api/travel/list', async (req, res) => {
    try {
      const scenesDir = join(__dirname, '..', 'travel_log', 'scenes');
      const journalsDir = join(__dirname, '..', 'travel_log', 'journals');
      const files = await fs.readdir(scenesDir).catch(() => []);
      const travels = [];
      for (const file of files.filter(f => f.endsWith('.json'))) {
        try {
          const session = JSON.parse(await fs.readFile(join(scenesDir, file), 'utf-8'));
          const journalFile = file.replace('.json', '.md');
          let hasJournal = false;
          try { await fs.access(join(journalsDir, journalFile)); hasJournal = true; } catch (e) {}
          travels.push({
            id: session.id, destination: session.destination,
            startTime: session.startTime, ended: session.ended || false,
            steps: session.history.filter(h => h.role === 'user').length,
            hasJournal
          });
        } catch (e) {}
      }
      res.json(travels);
    } catch (e) { res.json([]); }
  });

  app.get('/api/travel/scene/:id', async (req, res) => {
    try {
      const file = join(__dirname, '..', 'travel_log', 'scenes', `${req.params.id}.json`);
      const session = JSON.parse(await fs.readFile(file, 'utf-8'));
      const formatted = session.history
        .filter(h => h.role !== 'system')
        .map(h => ({ role: h.role === 'assistant' ? '场景' : '你', content: h.content }));
      res.json({ destination: session.destination, startTime: session.startTime, ended: session.ended, entries: formatted });
    } catch (e) { res.status(404).json({ error: '找不到' }); }
  });

  app.get('/api/travel/journal/:id', async (req, res) => {
    try {
      const file = join(__dirname, '..', 'travel_log', 'journals', `${req.params.id}.md`);
      const content = await fs.readFile(file, 'utf-8');
      res.json({ content });
    } catch (e) { res.status(404).json({ error: '找不到' }); }
  });

  app.get('/api/travel/luggage', async (req, res) => {
    try {
      const content = await fs.readFile(join(__dirname, '..', 'travel_log', '_luggage.md'), 'utf-8');
      res.json({ content });
    } catch (e) { res.json({ content: '空的' }); }
  });

  console.log('[模块] 旅行系统已启用');
}

// ========== 自然语言入口 ==========
app.post('/api/v2/xiaowo', async (req, res) => {
  try {
    const input = req.body.input || req.body.message || '';
    const result = await handleXiaowo(input);
    res.json({ success: true, result });
  } catch (e) {
    res.status(500).json({ success: false, error: e.message });
  }
});

// ========== MCP over SSE ==========

const sseClients = new Map();

app.get('/mcp/sse', (req, res) => {
  const sessionId = crypto.randomUUID();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });
  sseClients.set(sessionId, res);
  res.write(`event: endpoint\ndata: /mcp/message?sessionId=${sessionId}\n\n`);
  req.on('close', () => { sseClients.delete(sessionId); });
});

app.post('/mcp/message', async (req, res) => {
  const sessionId = req.query.sessionId;
  const sseRes = sseClients.get(sessionId);
  const msg = req.body;

  if (!sseRes) return res.status(400).json({ error: 'Session not found' });

  let response;

  if (msg.method === 'initialize') {
    response = {
      jsonrpc: '2.0', id: msg.id,
      result: {
        protocolVersion: '2024-11-05',
        capabilities: { tools: {} },
        serverInfo: { name: 'xiaowo-memory', version: '1.0.0' }
      }
    };
  } else if (msg.method === 'notifications/initialized') {
    res.status(202).end();
    return;
  } else if (msg.method === 'tools/list') {
    response = { jsonrpc: '2.0', id: msg.id, result: { tools: [TOOL_DEFINITION] } };
  } else if (msg.method === 'tools/call') {
    try {
      const result = await handleXiaowo(msg.params.arguments?.input || '');
      response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: result }] } };
    } catch (e) {
      response = { jsonrpc: '2.0', id: msg.id, result: { content: [{ type: 'text', text: `出错了：${e.message}` }], isError: true } };
    }
  } else if (msg.method === 'ping') {
    response = { jsonrpc: '2.0', id: msg.id, result: {} };
  } else {
    response = { jsonrpc: '2.0', id: msg.id, error: { code: -32601, message: `Method not found: ${msg.method}` } };
  }

  sseRes.write(`event: message\ndata: ${JSON.stringify(response)}\n\n`);
  res.status(202).end();
});

// ========== 空间系统定时器（可选） ==========
if (config.space?.enabled) {
  try {
    const { checkSceneChange } = await import('./space/room-clock.js');
    const { updateRoomScene } = await import('./space/room.js');
    const { autoSwitch } = await import('./space/music.js');

    async function roomClockTick() {
      try {
        const { needsUpdate, reason, state } = checkSceneChange();
        if (needsUpdate) {
          console.log(`[房间时钟] ${reason}`);
          // 旅行中跳过场景更新
          if (config.travel?.enabled) {
            try {
              const { listTravels } = await import('./travel/travel.js');
              const travels = await listTravels();
              if (travels.find(t => !t.ended)) return;
            } catch (e) {}
          }
          const zone = state.currentZone || 'desk';
          await updateRoomScene(zone);
        }
      } catch (e) {}
    }

    setInterval(roomClockTick, 5 * 60 * 1000);
    setInterval(autoSwitch, 60 * 1000);
    setTimeout(roomClockTick, 3000);
    console.log('[模块] 空间系统已启用（房间时钟 + 音乐盒）');
  } catch (e) {
    console.warn('[模块] 空间系统加载失败:', e.message);
  }
}

// ========== LLM API 代理（可选） ==========
if (config.proxy?.enabled) {
  try {
    const { startProxy } = await import('./proxy/proxy-server.js');
    await startProxy();
  } catch (e) {
    console.warn('[模块] LLM API 代理启动失败:', e.message);
  }
}

// ========== 启动 ==========
app.listen(PORT, () => {
  console.log(`小窝启动了 → http://localhost:${PORT}`);
  console.log(`核心API: /api/v2/`);
  console.log(`App API: /api/app (POST)`);
  console.log(`MCP SSE: /mcp/sse`);
  console.log(`前端: http://localhost:${PORT}`);
});
