/**
 * Anthropic 格式处理
 * 端点：/v1/messages
 * System prompt 在顶层 system 字段
 */

/**
 * 从 Anthropic 请求体中提取 system 字段
 * @param {object} body
 * @returns {string}
 */
export function extractSystem(body) {
  // Anthropic 的 system 字段可以是 string 或 array
  const sys = body.system;
  if (!sys) return '';
  if (typeof sys === 'string') return sys;
  if (Array.isArray(sys)) {
    return sys
      .filter(b => b.type === 'text')
      .map(b => b.text)
      .join('\n');
  }
  return '';
}

/**
 * 将注入内容写入 Anthropic 请求体的 system 字段
 * @param {object} body
 * @param {string} injection
 * @returns {object} 新 body
 */
export function injectAnthropic(body, injection) {
  if (!injection) return body;

  const newBody = { ...body };
  const existingSystem = extractSystem(body);
  const newSystem = existingSystem ? existingSystem + '\n\n' + injection : injection;

  // 统一写成 string 格式
  newBody.system = newSystem;

  return newBody;
}

/**
 * 转发请求到目标 LLM（Anthropic 格式），支持 streaming
 * @param {object} target { baseUrl, apiKey, model }
 * @param {object} body 请求体（已注入 system）
 * @param {import('http').ServerResponse} res
 */
export async function forwardAnthropic(target, body, res) {
  const isStream = body.stream === true;

  const forwardBody = {
    ...body,
    model: target.model || body.model,
  };

  const headers = {
    'Content-Type': 'application/json',
    'x-api-key': target.apiKey,
    'anthropic-version': '2023-06-01',
  };

  const upstream = await fetch(`${target.baseUrl}/v1/messages`, {
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
    // 非流式
    const data = await upstream.json();
    res.setHeader('Content-Type', 'application/json');
    res.end(JSON.stringify(data));
  }
}
