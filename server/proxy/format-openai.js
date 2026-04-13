/**
 * OpenAI 格式处理
 * 端点：/v1/chat/completions
 * System prompt 在 messages[] 中 role: "system"
 */

/**
 * 从 messages 中提取 system 消息索引
 * @param {Array<{role: string, content: string}>} messages
 * @returns {number} 索引，-1 表示没有
 */
export function findSystemIndex(messages) {
  return messages.findIndex(m => m.role === 'system');
}

/**
 * 将注入内容注入到 messages 中
 * 有 system 消息 → 追加到末尾
 * 没有 → 在最前面创建一条
 * @param {Array} messages
 * @param {string} injection
 * @returns {Array} 新 messages
 */
export function injectOpenAI(messages, injection) {
  if (!injection) return messages;

  const newMessages = messages.map(m => ({ ...m }));
  const idx = findSystemIndex(newMessages);

  if (idx >= 0) {
    newMessages[idx] = {
      ...newMessages[idx],
      content: newMessages[idx].content + '\n\n' + injection,
    };
  } else {
    newMessages.unshift({ role: 'system', content: injection });
  }

  return newMessages;
}

/**
 * 转发请求到目标 LLM（OpenAI 格式），支持 streaming
 * @param {object} target { baseUrl, apiKey, model }
 * @param {object} body 请求体（已注入 messages）
 * @param {import('http').ServerResponse} res
 */
export async function forwardOpenAI(target, body, res) {
  const isStream = body.stream === true;

  // 用 target 配置覆盖 baseUrl 和 apiKey，保留客户端指定的 model
  const forwardBody = {
    ...body,
    model: target.model || body.model,
  };

  const headers = {
    'Content-Type': 'application/json',
    'Authorization': `Bearer ${target.apiKey}`,
  };

  const upstream = await fetch(`${target.baseUrl}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(forwardBody),
  });

  if (!upstream.ok) {
    const errText = await upstream.text().catch(() => '');
    res.status(upstream.status);
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify({ error: { message: `上游返回 ${upstream.status}`, detail: errText } }));
    return;
  }

  if (isStream) {
    // SSE 透传
    res.writeHead(200, {
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    });

    const reader = upstream.body.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        res.write(value);
      }
    } catch {
      // 客户端断开
    }
    res.end();
  } else {
    // 非流式：直接转发 JSON
    const data = await upstream.json();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  }
}
