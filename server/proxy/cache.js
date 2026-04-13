/**
 * 常驻记忆 / 项目摘要缓存
 * 启动时读取 data/persistent/ 和 data/projects/，定时刷新
 */

import { readdir, readFile } from 'fs/promises';
import { join } from 'path';
import { fileURLToPath } from 'url';
import { dirname } from 'path';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const PERSISTENT_DIR = join(__dirname, '..', '..', 'data', 'persistent');
const PROJECTS_DIR = join(__dirname, '..', '..', 'data', 'projects');

/** @type {string} 常驻记忆拼接文本 */
let persistentText = '';

/** @type {string} 项目摘要拼接文本 */
let projectsText = '';

/** @type {NodeJS.Timeout} */
let refreshTimer = null;

/**
 * 读取一个目录下所有 .md 文件内容并拼接
 */
async function readAllMd(dir) {
  let files;
  try {
    files = await readdir(dir);
  } catch {
    return '';
  }

  const mdFiles = files.filter(f => f.endsWith('.md') && f !== 'README.md');
  const parts = [];

  for (const file of mdFiles) {
    try {
      const content = await readFile(join(dir, file), 'utf-8');
      const trimmed = content.trim();
      if (trimmed) {
        parts.push(trimmed);
      }
    } catch {
      // 单文件读取失败跳过
    }
  }

  return parts.join('\n\n');
}

/**
 * 刷新所有缓存
 */
export async function refresh() {
  const [persistent, projects] = await Promise.all([
    readAllMd(PERSISTENT_DIR),
    readAllMd(PROJECTS_DIR),
  ]);

  persistentText = persistent;
  projectsText = projects;
}

/**
 * 获取常驻记忆文本
 */
export function getPersistentMemory() {
  return persistentText;
}

/**
 * 获取项目摘要文本
 */
export function getProjectsSummary() {
  return projectsText;
}

/**
 * 启动定时刷新（每 60 秒）
 */
export function startAutoRefresh(intervalMs = 60_000) {
  stopAutoRefresh();
  refresh(); // 立即刷新一次
  refreshTimer = setInterval(refresh, intervalMs);
}

/**
 * 停止定时刷新
 */
export function stopAutoRefresh() {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
}
