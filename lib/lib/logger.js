/**
 * dsh-soul logger — 写宿主日志，同时落一份轮转文本日志。
 *
 * 约束：
 *   · 日志永不抛错（记不下来最多丢一行，不能让插件/回合挂掉）；
 *   · 日志永不落明文密钥（scrubSecrets）；
 *   · 文件超过 1MB 自动轮转为 soul.log.1。
 */
import { appendFileSync, mkdirSync, renameSync, statSync } from 'node:fs';
import { dirname } from 'node:path';
import { scrubSecrets } from './util.js';

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40 };

/**
 * @param {{ctx?: any, file?: string, level?: string, toFile?: boolean}} options
 */
export function createLogger(options = {}) {
  const { ctx, file } = options;
  const threshold = LEVELS[options.level] ?? LEVELS.info;
  const toFile = options.toFile !== false && typeof file === 'string' && file !== '';
  const maxBytes = 1_000_000;
  let dirReady = false;

  const write = (level, message) => {
    if ((LEVELS[level] ?? LEVELS.info) < threshold) return;
    const text = scrubSecrets(String(message ?? ''));
    // 1) 宿主日志
    try {
      const fn = ctx?.logger?.[level];
      if (typeof fn === 'function') fn.call(ctx.logger, `dsh-soul: ${text}`);
    } catch { /* host logger 不可用就跳过 */ }
    // 2) 本地文件
    if (!toFile) return;
    try {
      if (!dirReady) {
        mkdirSync(dirname(file), { recursive: true });
        dirReady = true;
      }
      try {
        if (statSync(file).size > maxBytes) renameSync(file, `${file}.1`);
      } catch { /* 文件还不存在 */ }
      const line = `[${new Date().toISOString()}] [${level}] ${text}\n`;
      appendFileSync(file, line, 'utf8');
    } catch { /* 磁盘问题不影响功能 */ }
  };

  return {
    file,
    debug: (m) => write('debug', m),
    info: (m) => write('info', m),
    warn: (m) => write('warn', m),
    error: (m) => write('error', m),
  };
}
