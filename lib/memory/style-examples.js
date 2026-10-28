/**
 * 语体样本库（v2）。
 *
 * 存的是「我真实说过的原话」：被前辈夸的记为 positive，被嫌的记为 negative。
 * 只存原句，不存改写、不存总结——总结出来的语气描述又会变成一套规则。
 */

import { buildForbiddenRules, findForbidden } from '../output-guard.js';

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
  rules,
  score = 0.5,
} = {}) {
  const body = clampText(text);
  if (body.length < 8) return null;
  const activeRules = Array.isArray(rules) ? rules : buildForbiddenRules();
  if (findForbidden(body, activeRules).length > 0) return null; // 禁用表达绝不进样本库
  const norm = normalizeStyleText(body);
  if (norm === '') return null;
  const k = kind === 'negative' || kind === 'borrowed' || kind === 'disabled' ? kind : 'positive';
  const initial = Math.max(0.05, Math.min(1, Number(score) || 0.5));
  const db = store?.db;
  if (!db) return null;

  const existing = db.prepare('SELECT id, score FROM style_examples WHERE norm = ?').get(norm);
  if (existing) {
    if (k === 'positive') {
      const nextScore = Math.min(1, Number(existing.score ?? 0.5) + 0.15);
      db.prepare('UPDATE style_examples SET score = ? WHERE id = ?').run(nextScore, Number(existing.id));
      return { id: Number(existing.id), created: false, score: nextScore };
    }
    // 同一句后来被嫌：翻成负面并压分，绝不再作为正向锚点。
    const nextScore = Math.min(Number(existing.score ?? 0.5), initial);
    db.prepare('UPDATE style_examples SET kind = ?, score = ? WHERE id = ?').run(k, nextScore, Number(existing.id));
    return { id: Number(existing.id), created: false, score: nextScore };
  }
  const info = db.prepare('INSERT INTO style_examples (kind, text, norm, scene, source, score, used, created_at) VALUES (?, ?, ?, ?, ?, ?, 0, ?)')
    .run(k, body, norm, String(scene ?? ''), String(source ?? ''), initial, Number(now) || Date.now());
  return { id: Number(info.lastInsertRowid ?? 0), created: true, score: initial };
}

/** 字符 bigram 相似度，只用于挑「最像的那句正向样本」扣分。 */
function bigramSimilarity(a, b) {
  const sa = String(a ?? '');
  const sb = String(b ?? '');
  if (!sa || !sb) return 0;
  if (sa === sb) return 1;
  const grams = (s) => {
    const out = new Set();
    for (let i = 0; i < s.length - 1; i += 1) out.add(s.slice(i, i + 2));
    return out;
  };
  const ga = grams(sa);
  const gb = grams(sb);
  if (ga.size === 0 || gb.size === 0) return 0;
  let hit = 0;
  for (const g of ga) if (gb.has(g)) hit += 1;
  return hit / Math.max(ga.size, gb.size);
}

/**
 * 负评落账：给最相似或最近被用过的正向样本扣分。
 * 分数降到 0.1 以下直接停用（kind='disabled', score=-1），锚点选择永不取用。
 */
export function penalizeStyleExamples(store, {
  text = '',
  scene = '',
  penalty = 0.35,
  now = Date.now(),
} = {}) {
  const db = store?.db;
  if (!db) return [];
  let rows = [];
  try {
    rows = db.prepare("SELECT id, text, scene, score, used FROM style_examples WHERE kind = 'positive' ORDER BY used DESC, score DESC, created_at DESC LIMIT 40").all();
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const target = normalizeStyleText(text);
  let best = null;
  let bestScore = -1;
  for (const row of rows) {
    const norm = normalizeStyleText(row.text);
    const similarity = target && norm === target ? 1 : bigramSimilarity(target, norm);
    // 同场景略微加分，避免跨场景误伤。
    const weighted = similarity + (String(row.scene ?? '') === String(scene ?? '') ? 0.05 : 0);
    if (weighted > bestScore) {
      bestScore = weighted;
      best = row;
    }
  }
  // 找不到足够像的句子时，退而扣「最近被用过/分数最高」的正向样本：
  // 负评总得落到某句具体的话上，否则学习闭环又断了。
  if (!best || bestScore < 0.12) {
    best = rows.find((row) => Number(row.used ?? 0) > 0) ?? rows[0];
    bestScore = 0;
  }
  if (!best) return [];
  const step = Math.max(0.05, Number(penalty) || 0.35);
  // 先四舍五入到百分位，避免 0.8-0.35-0.35 = 0.10000000000000009 逃过 <=0.1 的停用线。
  const rawScore = Math.max(-1, Number(best.score ?? 0.5) - step);
  const nextScore = Math.max(-1, Math.round(rawScore * 100) / 100);
  const disabled = nextScore <= 0.1;
  try {
    if (disabled) {
      db.prepare("UPDATE style_examples SET kind = 'disabled', score = -1 WHERE id = ?").run(Number(best.id));
    } else {
      db.prepare('UPDATE style_examples SET score = ? WHERE id = ?').run(nextScore, Number(best.id));
    }
  } catch {
    return [];
  }
  return [{
    id: Number(best.id),
    score: disabled ? -1 : nextScore,
    disabled,
    similarity: bestScore,
    at: Number(now) || Date.now(),
  }];
}

/**
 * 挑这一轮要贴的样本：同场景优先，其次分数高的、用得少的。
 * @returns {Array<{id:number,text:string,scene:string,score:number,used:number}>}
 */
export function selectStyleAnchors(store, { scene = '', limit = 2, rules } = {}) {
  const db = store?.db;
  if (!db) return [];
  const activeRules = Array.isArray(rules) ? rules : buildForbiddenRules();
  const n = Math.max(1, Math.min(4, Number(limit) || 2));
  const where = " WHERE kind = 'positive' AND score > 0.1 AND (scene = ? OR scene = '')";
  const order = ' ORDER BY CASE WHEN scene = ? THEN 0 ELSE 1 END, score DESC, used ASC, created_at DESC LIMIT ?';
  const run = (sql, args) => {
    try { return db.prepare(sql).all(...args); } catch { return []; }
  };
  // 多取一些再过滤：negative 与命中禁用表达的样本永远不注入。
  const fresh = (rows) => rows.filter((row) => findForbidden(row.text, activeRules).length === 0);
  let rows = fresh(run('SELECT id, text, scene, score, used FROM style_examples' + where + order, [String(scene ?? ''), String(scene ?? ''), n * 4]));
  if (rows.length === 0) {
    rows = fresh(run("SELECT id, text, scene, score, used FROM style_examples WHERE kind = 'positive' AND score > 0.1" + order, [String(scene ?? ''), n * 4]));
  }
  return rows.slice(0, n).map((row) => ({
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
