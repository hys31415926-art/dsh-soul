/**
 * 语体样本库（v2）。
 *
 * 存的是「我真实说过的原话」：被主人夸的记为 positive，被嫌的记为 negative。
 * 只存原句，不存改写、不存总结——总结出来的语气描述又会变成一套规则。
 */

/** 归一化：去空白、去引号差异，用于去重。 */
export function normalizeStyleText(text) {
  return String(text ?? '').replace(/\s+/gu, '').replace(/[「」『』“”"']/gu, '').toLowerCase().slice(0, 400);
}

function clampText(text, max = 160) {
  const t = String(text ?? '').trim();
  return t.length > max ? t.slice(0, max) : t;
}

/**
 * 写入一条语体样本。同一句话重复出现只加权重，不增生。
 * @returns {{id: number, created: boolean, score: number}|null}
 */
export function addStyleExample(store, {
  text,
  kind = 'positive',
  scene = '',
  source = '',
  now = Date.now(),
} = {}) {
  const body = clampText(text);
  if (body.length < 8) return null;
  const norm = normalizeStyleText(body);
  if (norm === '') return null;
  const k = kind === 'negative' || kind === 'borrowed' ? kind : 'positive';
  const db = store?.db;
  if (!db) return null;

  const existing = db.prepare('SELECT id, score FROM style_examples WHERE norm = ?').get(norm);
  if (existing) {
    const score = Math.min(1, Number(existing.score ?? 0.5) + 0.15);
    db.prepare('UPDATE style_examples SET score = ? WHERE id = ?').run(score, Number(existing.id));
    return { id: Number(existing.id), created: false, score };
  }
  const info = db.prepare('INSERT INTO style_examples (kind, text, norm, scene, source, score, used, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(k, body, norm, String(scene ?? ''), String(source ?? ''), 0.5, Number(now) || Date.now());
  return { id: Number(info.lastInsertRowid ?? 0), created: true, score: 0.5 };
}

/**
 * 挑这一轮要贴的样本：同场景优先，其次分数高的、用得少的。
 * @returns {Array<{id:number,text:string,scene:string,score:number,used:number}>}
 */
export function selectStyleAnchors(store, { scene = '', limit = 2 } = {}) {
  const db = store?.db;
  if (!db) return [];
  const n = Math.max(1, Math.min(4, Number(limit) || 2));
  const where = " WHERE kind = 'positive' AND (scene = ? OR scene = '')";
  const order = ' ORDER BY CASE WHEN scene = ? THEN 0 ELSE 1 END, score DESC, used ASC, created_at DESC LIMIT ?';
  const run = (sql, args) => {
    try { return db.prepare(sql).all(...args); } catch { return []; }
  };
  let rows = run('SELECT id, text, scene, score, used FROM style_examples' + where + order, [String(scene ?? ''), String(scene ?? ''), n]);
  if (rows.length === 0) {
    rows = run('SELECT id, text, scene, score, used FROM style_examples WHERE kind = ?' + order, ['positive', String(scene ?? ''), n]);
  }
  return rows.map((row) => ({
    id: Number(row.id),
    text: String(row.text ?? ''),
    scene: String(row.scene ?? ''),
    score: Number(row.score ?? 0),
    used: Number(row.used ?? 0),
  }));
}

/** 标记样本被用过（用于「贴了但没用上」的后续调权）。 */
export function markStyleAnchorsUsed(store, ids = [], now = Date.now()) {
  const db = store?.db;
  if (!db || ids.length === 0) return 0;
  let changed = 0;
  const stmt = db.prepare('UPDATE style_examples SET used = used + 1, last_used_at = ? WHERE id = ?');
  for (const id of ids) {
    try {
      changed += Number(stmt.run(Number(now) || Date.now(), Number(id)).changes ?? 0);
    } catch { /* 单条失败不影响其它 */ }
  }
  return changed;
}

/** 审计用：列出样本。 */
export function listStyleExamples(store, { limit = 20, kind = '' } = {}) {
  const db = store?.db;
  if (!db) return [];
  const sql = 'SELECT id, kind, text, scene, source, score, used, created_at FROM style_examples'
    + (kind ? ' WHERE kind = ?' : '') + ' ORDER BY id DESC LIMIT ?';
  const args = kind ? [kind, Math.max(1, Number(limit) || 20)] : [Math.max(1, Number(limit) || 20)];
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}
