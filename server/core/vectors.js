/**
 * 向量存储 - ChromaDB版
 * 替换原来的JSON内存存储，用ChromaDB做持久化向量检索
 * 嵌入模型继续用Qwen3-Embedding-8B（硅基流动API）
 */

import { readFile } from 'fs/promises';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { ChromaClient } from 'chromadb';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const CONFIG_FILE = join(__dirname, '..', 'config.json');

const COLLECTION_NAME = 'xiaowo_memories';
const CHROMA_URL = 'http://localhost:8000';

// 堵死ChromaDB自带的嵌入模型，强制所有嵌入走Qwen3-Embedding-8B
// 如果任何地方漏传了embeddings，直接报错而不是静默用错模型
const BLOCKED_EMBEDDING_FUNCTION = {
  generate: async () => {
    throw new Error('禁止使用ChromaDB自带嵌入！所有嵌入必须通过config.json中配置的embedding API生成。');
  }
};

let client = null;
let collection = null;

async function readJson(path, fallback) {
  try { return JSON.parse(await readFile(path, 'utf-8')); }
  catch (e) { return fallback; }
}

// 调硅基流动的embedding API
async function getEmbedding(text) {
  const config = await readJson(CONFIG_FILE, {});
  const emb = config.embedding;
  if (!emb?.apiKey || !emb?.model) {
    throw new Error('Embedding未配置');
  }

  const truncated = text.substring(0, 2000);

  const response = await fetch(`${emb.baseUrl}/embeddings`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${emb.apiKey}`
    },
    body: JSON.stringify({
      model: emb.model,
      input: truncated
    })
  });

  if (!response.ok) {
    const err = await response.text();
    throw new Error(`Embedding API失败: ${err}`);
  }

  const result = await response.json();
  return result.data?.[0]?.embedding;
}

// 初始化ChromaDB连接
async function initChroma() {
  if (collection) return;
  client = new ChromaClient({ baseUrl: CHROMA_URL });
  collection = await client.getOrCreateCollection({
    name: COLLECTION_NAME,
    embeddingFunction: BLOCKED_EMBEDDING_FUNCTION
  });
  const count = await collection.count();
  console.log(`ChromaDB连接成功，collection "${COLLECTION_NAME}" 共 ${count} 条记忆`);
}

// 加载（兼容旧接口名，实际是初始化ChromaDB）
async function loadVectors() {
  try {
    await initChroma();
  } catch (e) {
    console.error('ChromaDB连接失败:', e.message);
    console.error('请确保ChromaDB server在运行: chroma run --path ./chromadb-data');
  }
}

// 添加/更新一条记忆的向量
async function upsertVector(layer, filename, text) {
  try {
    await initChroma();
    const id = `${layer}/${filename}`;
    const vector = await getEmbedding(text);

    await collection.upsert({
      ids: [id],
      embeddings: [vector],
      documents: [text.substring(0, 500)],
      metadatas: [{ layer, filename, updatedAt: new Date().toISOString() }]
    });
    return true;
  } catch (e) {
    console.error(`向量化失败 [${layer}/${filename}]:`, e.message);
    return false;
  }
}

// 删除一条记忆的向量
async function removeVector(layer, filename) {
  try {
    await initChroma();
    const id = `${layer}/${filename}`;
    await collection.delete({ ids: [id] });
  } catch (e) {
    console.error(`向量删除失败 [${layer}/${filename}]:`, e.message);
  }
}

// 语义检索：返回最相似的N条记忆
async function searchSimilar(query, topN = 5) {
  try {
    await initChroma();
    const queryVector = await getEmbedding(query);
    if (!queryVector) return [];

    const results = await collection.query({
      queryEmbeddings: [queryVector],
      nResults: topN,
      include: ['metadatas', 'documents', 'distances']
    });

    if (!results.ids?.[0]) return [];

    return results.ids[0].map((id, i) => ({
      key: id,
      layer: results.metadatas[0][i]?.layer,
      filename: results.metadatas[0][i]?.filename,
      score: 1 - ((results.distances[0][i] || 0) / 2), // ChromaDB返回L2距离[0,2]，转成相似度[0,1]
      preview: results.documents[0][i]
    }));
  } catch (e) {
    console.error('语义检索失败:', e.message);
    return [];
  }
}

// 获取向量索引状态
async function getVectorStats() {
  try {
    await initChroma();
    const count = await collection.count();

    // 获取所有记录的metadata来统计各层数量
    let byLayer = {};
    if (count > 0) {
      const all = await collection.get({ include: ['metadatas'] });
      for (const meta of all.metadatas) {
        const layer = meta?.layer || 'unknown';
        byLayer[layer] = (byLayer[layer] || 0) + 1;
      }
    }

    return { total: count, byLayer, backend: 'ChromaDB' };
  } catch (e) {
    return { total: 0, byLayer: {}, backend: 'ChromaDB', error: e.message };
  }
}

export {
  loadVectors,
  upsertVector,
  removeVector,
  searchSimilar,
  getVectorStats
};
