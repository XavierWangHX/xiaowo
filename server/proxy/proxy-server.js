/**
 * LLM API 中转代理服务器
 * 拦截请求 → 调小窝 API 生成注入内容 → 注入 system_prompt → 转发到目标 LLM
 *
 * 支持 OpenAI 和 Anthropic 两种格式，按请求路径自动识别
 */

import express from 'express';
import { readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';
import { buildInjection } from './inject-builder.js';
import { startAutoRefresh, stopAutoRefresh } from './cache.js';
import { injectOpenAI, forwardOpenAI } from './format-openai.js';
import { injectAnthropic, forwardAnthropic } from './format-anthropic.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const CONFIG_FILE = join(__dirname, '..', 'config.json');

// ========== 目标后端解析 ==========

/**
 * 根据客户端请求的 model 字段匹配 targets 配置
 * @param {object} targets
 * @param {string} model
 * @returns {{ baseUrl: string, apiKey: string, model: string }}
 */
function resolveTarget(targets, model) {
  if (!targets || !targets.default) {
    throw new Error('proxy.targets.default 未配置');
  }

  if (model && targets[model]) {
    return targets[model];
  }

  return targets.default;
}

// ========== 提取用户最新消息 ==========

/**
 * 从请求 messages 中提取最后一条 user 消息
 * @param {Array} messages
 * @returns {string}
 */
function extractLastUserMessage(messages) {
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      // OpenAI 多模态格式：content 是数组
      if (Array.isArray(content)) {
        return content
          .filter(p => p.type === 'text')
          .map(p => p.text)
          .join(' ');
      }
    }
  }
  return '';
}

/**
 * 从 Anthropic 请求体中提取最后一条 user 消息
 * @param {object} body
 * @returns {string}
 */
function extractLastUserMessageAnthropic(body) {
  const messages = body.messages;
  if (!Array.isArray(messages)) return '';

  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') {
      const content = messages[i].content;
      if (typeof content === 'string') return content;
      if (Array.isArray(content)) {
        return content
          .filter(b => b.type === 'text')
          .map(b => b.text)
          .join(' ');
      }
    }
  }
  return '';
}

// ========== 创建代理应用 ==========

/**
 * 创建并返回配置好的 Express 应用
 */
export async function createProxyApp() {
  // 读配置
  let config;
  try {
    config = JSON.parse(await readFile(CONFIG_FILE, 'utf-8'));
  } catch {
    throw new Error('无法读取 config.json');
  }

  const proxyConfig = config.proxy;
  if (!proxyConfig?.enabled) {
    throw new Error('proxy.enabled 未设为 true');
  }

  const targets = proxyConfig.targets;
  if (!targets?.default) {
    throw new Error('proxy.targets.default 未配置');
  }

  // 启动常驻记忆缓存
  startAutoRefresh();

  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // ========== OpenAI 格式：/v1/chat/completions ==========

  app.post('/v1/chat/completions', async (req, res) => {
    try {
      const { messages, model, ...rest } = req.body;
      const target = resolveTarget(targets, model);
      const userMsg = extractLastUserMessage(messages);

      // 生成注入内容
      const injection = await buildInjection(userMsg);

      // 注入到 messages
      const newMessages = injectOpenAI(messages || [], injection);

      // 转发
      await forwardOpenAI(target, { ...rest, model, messages: newMessages }, res);
    } catch (err) {
      console.error('[Proxy/OpenAI] 错误:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message } });
      }
    }
  });

  // ========== Anthropic 格式：/v1/messages ==========

  app.post('/v1/messages', async (req, res) => {
    try {
      const body = req.body;
      const target = resolveTarget(targets, body.model);
      const userMsg = extractLastUserMessageAnthropic(body);

      // 生成注入内容
      const injection = await buildInjection(userMsg);

      // 注入到 body.system
      const newBody = injectAnthropic(body, injection);

      // 转发
      await forwardAnthropic(target, newBody, res);
    } catch (err) {
      console.error('[Proxy/Anthropic] 错误:', err.message);
      if (!res.headersSent) {
        res.status(500).json({ error: { message: err.message } });
      }
    }
  });

  // ========== 其他路径：透传到 default 后端 ==========

  app.use(async (req, res) => {
    try {
      const target = targets.default;
      const url = `${target.baseUrl}${req.originalUrl}`;

      const headers = { ...req.headers };
      headers['host'] = new URL(target.baseUrl).host;
      headers['authorization'] = `Bearer ${target.apiKey}`;
      // 去掉 content-length 让 fetch 重新算
      delete headers['content-length'];

      const upstream = await fetch(url, {
        method: req.method,
        headers: {
          'Content-Type': req.headers['content-type'] || 'application/json',
          'Authorization': `Bearer ${target.apiKey}`,
        },
        body: req.method !== 'GET' && req.method !== 'HEAD' ? JSON.stringify(req.body) : undefined,
      });

      const data = await upstream.text();
      res.status(upstream.status);
      res.setHeader('Content-Type', upstream.headers.get('content-type') || 'application/json');
      res.end(data);
    } catch (err) {
      if (!res.headersSent) {
        res.status(502).json({ error: { message: `透传失败: ${err.message}` } });
      }
    }
  });

  return { app, config: proxyConfig };
}

// ========== 独立启动入口 ==========

/**
 * 启动代理服务器
 * 可被 index.js 调用，也可以独立运行
 */
export async function startProxy() {
  const { app, config } = await createProxyApp();
  const port = config.listenPort || 3457;

  app.listen(port, () => {
    console.log(`[Proxy] LLM API 代理启动 → http://localhost:${port}`);
    console.log(`[Proxy] OpenAI 格式: POST /v1/chat/completions`);
    console.log(`[Proxy] Anthropic 格式: POST /v1/messages`);

    const targetKeys = Object.keys(config.targets || {});
    for (const key of targetKeys) {
      const t = config.targets[key];
      console.log(`[Proxy] 后端 [${key}]: ${t.baseUrl} (${t.model})`);
    }
  });
}

// 独立运行：node proxy-server.js
const isMainModule = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMainModule) {
  startProxy().catch(err => {
    console.error('[Proxy] 启动失败:', err.message);
    process.exit(1);
  });
}
