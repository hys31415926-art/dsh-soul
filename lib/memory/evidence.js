/**
 * evidence — 记忆证据链。
 *
 * 为什么单独一张表：
 *   · 用户要求「每条长期记忆都要能追溯它是从哪一轮、哪句原话来的」；
 *   · 规则抽取时代只有 source 字段一个模糊字符串，无法回答「你说的是哪句」；
 *   · 语义抽取后，写入必须由程序附上真实会话事件引用（session/event seq），
 *     而不是让模型自己编造 quote —— 模型可以写错内容，但不能伪造证据。
 *
 * 证据由程序在写入时生成（见 hooks.js / semantic.js 的 refs），
 * 表结构只做一件事：把 memory_id 和真实事件坐标绑定起来，可查、可删。
 */

/** 一条证据最大引用原文长度（防止把整段粘贴塞进来）。 */
const MAX_QUOTE_CHARS = 240;

/**
 * 给一条记忆追加证据记录。
 * @param {import('./store.js').Store} store
 * @param {number} memoryId
 * @param {{sessionId?: string, turn?: number|null, eventSeq?: number|null, role?: string, quote?: string}[]} refs
 * @returns {number} 实际写入条数
 */
export function addEvidence(store, memoryId, refs = []) {
  const id = Number(memoryId);
  if (!Number.isFinite(id) || id <= 0) return 0;
  const db = store?.db;
  if (!db) return 0;
  const insert = db.prepare(`INSERT INTO memory_evidence
    (memory_id, session_id, turn, event_seq, role, quote, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`);
  const now = Date.now();
  let count = 0;
  for (const ref of refs) {
    if (!ref || typeof ref !== 'object') continue;
    const quote = String(ref.quote ?? '').replace(/\s+/g, ' ').trim();
    if (quote === '') continue;
    const sessionId = String(ref.sessionId ?? '');
    const turn = ref.turn === null || ref.turn === undefined || Number.isNaN(Number(ref.turn)) ? null : Number(ref.turn);
    const eventSeq = ref.eventSeq === null || ref.eventSeq === undefined || Number.isNaN(Number(ref.eventSeq)) ? null : Number(ref.eventSeq);
    const role = String(ref.role ?? '');
    try {
      insert.run(id, sessionId, turn, eventSeq, role, quote.slice(0, MAX_QUOTE_CHARS), now);
      count += 1;
    } catch {
      // 证据写失败不阻塞记忆写入；调用方会记录日志。
    }
  }
  return count;
}

/**
 * 查一条记忆的证据。
 * @returns {{id:number, sessionId:string, turn:number|null, eventSeq:number|null, role:string, quote:string, createdAt:number}[]}
 */
export function listEvidence(store, memoryId, limit = 10) {
  const rows = store?.db?.prepare(`SELECT * FROM memory_evidence WHERE memory_id = ? ORDER BY id DESC LIMIT ?`)
    .all(Number(memoryId), Math.max(1, Number(limit) || 10)) ?? [];
  return rows.map((row) => ({
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    turn: row.turn == null ? null : Number(row.turn),
    eventSeq: row.event_seq == null ? null : Number(row.event_seq),
    role: String(row.role ?? ''),
    quote: String(row.quote ?? ''),
    createdAt: Number(row.created_at ?? 0),
  }));
}

/** 批量取证据数量（list 渲染时显示「依据 N 条」用）。 */
export function evidenceCounts(store, memoryIds = []) {
  const out = new Map();
  const ids = [...new Set(memoryIds.map(Number).filter((n) => Number.isFinite(n) && n > 0))];
  if (ids.length === 0) return out;
  const placeholders = ids.map(() => '?').join(',');
  const rows = store?.db?.prepare(`SELECT memory_id, COUNT(*) AS n FROM memory_evidence
    WHERE memory_id IN (${placeholders}) GROUP BY memory_id`).all(...ids) ?? [];
  for (const row of rows) out.set(Number(row.memory_id), Number(row.n));
  return out;
}

/** 取一条记忆最近一条证据（命令展示/审计用）。 */
export function latestEvidence(store, memoryId) {
  const rows = listEvidence(store, memoryId, 1);
  return rows.length > 0 ? rows[0] : null;
}

/** 整理：证据随记忆保留，但按时间清理超长历史（记忆本身由 memories 管）。 */
export function pruneEvidence(store, { retentionDays = 180 } = {}) {
  const cutoff = Date.now() - Math.max(7, Number(retentionDays) || 180) * 86_400_000;
  try {
    const info = store.db.prepare('DELETE FROM memory_evidence WHERE created_at < ?').run(cutoff);
    return Number(info.changes ?? 0);
  } catch {
    return 0;
  }
}

/** 一条记忆在展示时用的「依据」短描述。 */
export function formatEvidence(entry) {
  if (!entry) return '';
  const where = entry.turn == null ? '会话' : `第${entry.turn}轮`;
  const role = entry.role === 'assistant' ? '助手' : entry.role === 'user' ? '用户' : '事件';
  return `${where}·${role}「${entry.quote}」`;
}
