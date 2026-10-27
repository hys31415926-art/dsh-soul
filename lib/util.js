/**
 * dsh-soul util — 纯函数工具层。
 *
 * 设计原则：这一层不碰 DSH 上下文、不碰数据库、不产生副作用，方便单元测试。
 * 所有「压缩/裁剪」操作都保证不会把一段话截成乱码：优先在标点处断开。
 */
import { homedir } from 'node:os';
import { join } from 'node:path';

/** `$DSH_HOME` 或 `~/.dsh`，与宿主一致。 */
export function dshHome() {
  const home = process.env.DSH_HOME;
  if (typeof home === 'string' && home !== '') return home;
  return join(homedir() || '/tmp', '.dsh');
}

/** 默认记忆库路径：跨 profile 共用一份（同一台机器上「同一个我」）。 */
export function defaultDbPath() {
  return join(dshHome(), 'dsh-soul', 'soul.db');
}

/** 单行化 + 硬截断（保留可读的省略号）。 */
export function clip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const n = Math.max(1, Number(max) || 1);
  return s.length <= n ? s : `${s.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * 尽量在标点处截断，避免把一句话腰斩。
 * @param {string} text
 * @param {number} max 最大字符数
 */
export function smartClip(text, max) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  const n = Math.max(1, Number(max) || 1);
  if (s.length <= n) return s;
  const window = s.slice(0, n);
  const cut = Math.max(
    window.lastIndexOf('。'), window.lastIndexOf('！'), window.lastIndexOf('？'),
    window.lastIndexOf('；'), window.lastIndexOf('，'), window.lastIndexOf('\n'),
    window.lastIndexOf('. '), window.lastIndexOf('! '), window.lastIndexOf('? '),
  );
  if (cut >= Math.floor(n * 0.55)) return `${window.slice(0, cut + 1)}…`;
  return `${window.slice(0, Math.max(0, n - 1))}…`;
}

/**
 * 去重用的规范化文本：忽略大小写、空白、标点与符号。
 * 中文保留全部汉字；长度截到 160，避免长句把 UNIQUE 约束撑爆。
 */
export function normText(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160);
}

/** 粗估 token（中文约 1.6 字/token）；仅用于状态展示与预算提示。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[\u3400-\u9fff]/gu) ?? []).length;
  const rest = text.length - cjk;
  return Math.ceil(cjk / 1.6 + rest / 4);
}

/** 把 long integer 毫秒格式化为「2026-10-24 21:03」。 */
export function formatTime(ts) {
  if (!ts) return '—';
  const d = new Date(Number(ts));
  if (Number.isNaN(d.getTime())) return '—';
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** 人类可读的相对时间。 */
export function formatAge(ts, now = Date.now()) {
  const t = Number(ts) || 0;
  if (t <= 0) return '—';
  const mins = Math.floor((now - t) / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟前`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时前`;
  return `${Math.floor(hours / 24)} 天前`;
}

/** 把一段毫秒区间写成「X 分钟 / X 小时 / X 天」（不带「前」，用于 gap）。 */
export function formatSpan(ms) {
  const n = Math.max(0, Number(ms) || 0);
  const mins = Math.floor(n / 60_000);
  if (mins < 1) return '刚刚';
  if (mins < 60) return `${mins} 分钟`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours} 小时`;
  return `${Math.floor(hours / 24)} 天`;
}

/** 安全 JSON.parse。 */
export function safeJsonParse(text, fallback = null) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/** 问句判断（只用于记忆抽取时避免把提问当事实）。 */
export function isQuestion(text) {
  return /[？?]\s*$/.test(String(text ?? '').trim());
}

/** 常见密钥/口令形态；命中即拒绝写入记忆并拒绝写日志。 */
const SECRET_PATTERNS = [
  { name: 'private-key', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { name: 'openai-sk', re: /\bsk-[A-Za-z0-9_-]{16,}/ },
  { name: 'github-token', re: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{20,}/ },
  { name: 'github-pat', re: /\bgithub_pat_[A-Za-z0-9_]{20,}/ },
  { name: 'slack-token', re: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { name: 'aws-key', re: /\bAKIA[0-9A-Z]{16}\b/ },
  { name: 'bearer', re: /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/i },
  { name: 'mdcg', re: /\bmdcg1[0-9a-z]{8,}/i },
  { name: 'password', re: /(?:password|passwd|pwd|密码|口令)\s*[:=：]\s*\S{3,}/i },
  { name: 'token', re: /\b(?:api[_-]?key|access[_-]?key|secret|token)\s*[:=：]\s*[A-Za-z0-9._~+/=-]{12,}/i },
];

/** @returns {boolean} 文本里是否含有疑似密钥。 */
export function looksSecret(text) {
  const s = String(text ?? '');
  if (s === '') return false;
  return SECRET_PATTERNS.some((p) => p.re.test(s));
}

/** 把日志文本里的疑似密钥打码（日志永不落明文密钥）。 */
export function scrubSecrets(text) {
  let s = String(text ?? '');
  for (const p of SECRET_PATTERNS) s = s.replace(p.re, `[redacted:${p.name}]`);
  return s;
}

/** 第一个非空字符串，否则 fallback。 */
export function firstNonEmpty(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v;
  }
  return '';
}

/** 转数字，NaN 时回退。 */
export function toNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** 限制到 [min, max]。 */
export function clamp(value, min, max) {
  return Math.min(max, Math.max(min, Number(value) || 0));
}

/** 截到指定数量的数组。 */
export function take(list, n) {
  return Array.isArray(list) ? list.slice(0, Math.max(0, Number(n) || 0)) : [];
}
