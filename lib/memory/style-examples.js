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

  const existing = db.prepare('SELECT id, score, kind FROM style_examples WHERE norm = ?').get(norm);
  if (existing) {
    // 用户原话已经是 positive 时，助手后来的「自采纳」不能把它降成 borrowed。
    if (k === 'borrowed' && existing.kind === 'positive') {
      return { id: Number(existing.id), created: false, score: Number(existing.score ?? 0.5) };
    }
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
 * 负评归责：只扣「确实该为这句话负责」的正向样本。
 *
 * 归责顺序：
 *   1. 被嫌回复与样本文字高度重合（bigram >= 0.30）；
 *   2. 该样本在上一回合确实被注入过（last_used_at 落在上一回合时间窗内）。
 * 两条都不成立就不扣分。不再退而扣「最近/分数最高」的样本——那会把负评
 * 记到无关句子上，属于自我评分污染。
 */
export function penalizeStyleExamples(store, {
  text = '',
  scene = '',
  turnId = 0,
  injectedSince = 0,
  penalty = 0.35,
  now = Date.now(),
  logger = null,
} = {}) {
  const db = store?.db;
  if (!db) return [];
  let rows = [];
  try {
    rows = db.prepare(`SELECT id, text, scene, score, used, last_used_at, last_penalty_turn_id
      FROM style_examples WHERE kind = 'positive' AND score > 0.1
      ORDER BY used DESC, score DESC, created_at DESC LIMIT 60`).all();
  } catch {
    return [];
  }
  if (rows.length === 0) return [];
  const target = normalizeStyleText(text);
  let best = null;
  let bestScore = -1;
  let attribution = 'text';
  for (const row of rows) {
    const norm = normalizeStyleText(row.text);
    const similarity = target && norm === target ? 1 : bigramSimilarity(target, norm);
    // 同场景略微加分，避免跨场景误伤。
    const weighted = similarity + (String(row.scene ?? '') === String(scene ?? '') ? 0.05 : 0);
    if (similarity >= 0.30 && weighted > bestScore) {
      bestScore = weighted;
      best = row;
    }
  }
  if (!best && Number(injectedSince) > 0) {
    const injected = rows
      .filter((row) => Number(row.last_used_at ?? 0) >= Number(injectedSince))
      .filter((row) => String(row.scene ?? '') === '' || String(row.scene ?? '') === String(scene ?? ''))
      .sort((a, b) => (Number(b.last_used_at ?? 0) - Number(a.last_used_at ?? 0))
        || (Number(b.used ?? 0) - Number(a.used ?? 0))
        || (Number(b.score ?? 0) - Number(a.score ?? 0)));
    if (injected.length > 0) {
      best = injected[0];
      bestScore = 0;
      attribution = 'injected';
    }
  }
  if (!best) {
    logger?.debug?.('负评未命中可归责样本，不扣分');
    return [];
  }
  // 同一回合已经扣过这条样本：user/message 与 assistant/message 只能算一次。
  if (Number(turnId) > 0 && Number(best.last_penalty_turn_id ?? 0) === Number(turnId)) {
    logger?.debug?.('同一回合已扣过该样本，跳过重复扣分');
    return [];
  }
  const step = Math.max(0.05, Number(penalty) || 0.35);
  // 先四舍五入到百分位，避免 0.8-0.35-0.35 = 0.10000000000000009 逃过 <=0.1 的停用线。
  const rawScore = Math.max(-1, Number(best.score ?? 0.5) - step);
  const nextScore = Math.max(-1, Math.round(rawScore * 100) / 100);
  const disabled = nextScore <= 0.1;
  const turn = Number(turnId) || 0;
  try {
    if (disabled) {
      db.prepare("UPDATE style_examples SET kind = 'disabled', score = -1, last_penalty_turn_id = ? WHERE id = ?").run(turn, Number(best.id));
    } else {
      db.prepare('UPDATE style_examples SET score = ?, last_penalty_turn_id = ? WHERE id = ?').run(nextScore, turn, Number(best.id));
    }
  } catch {
    return [];
  }
  return [{
    id: Number(best.id),
    score: disabled ? -1 : nextScore,
    disabled,
    similarity: bestScore,
    attribution,
    at: Number(now) || Date.now(),
  }];
}

/**
 * 挑这一轮要贴的样本：同场景优先，其次分数高的、用得少的。
 * @returns {Array<{id:number,text:string,scene:string,score:number,used:number}>}
 */
export function selectStyleAnchors(store, { scene = '', limit = 2, rules, fallbackScenes = [] } = {}) {
  const db = store?.db;
  if (!db) return [];
  const activeRules = Array.isArray(rules) ? rules : buildForbiddenRules();
  const n = Math.max(1, Math.min(4, Number(limit) || 2));
  // 当前格 + 兜底格 + 全局格（scene=''）。细分场景里没样本时还能拿到 chat 学过的原句，
  // 而不是掉到「全场景」里把 work 的严肃句子贴到闲聊上。
  const allowed = [...new Set([String(scene ?? ''), '', ...fallbackScenes.map((s) => String(s ?? ''))])];
  const where = ` WHERE kind = 'positive' AND score > 0.1 AND scene IN (${allowed.map(() => '?').join(', ')})`;
  const order = ' ORDER BY CASE WHEN scene = ? THEN 0 WHEN scene = \'\' THEN 2 ELSE 1 END, score DESC, used ASC, created_at DESC LIMIT ?';
  const run = (sql, args) => {
    try { return db.prepare(sql).all(...args); } catch { return []; }
  };
  // 多取一些再过滤：negative 与命中禁用表达的样本永远不注入。
  const fresh = (rows) => rows.filter((row) => findForbidden(row.text, activeRules).length === 0);
  let rows = fresh(run('SELECT id, text, scene, score, used FROM style_examples' + where + order, [...allowed, String(scene ?? ''), n * 4]));
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
  const sql = 'SELECT id, kind, text, scene, source, score, used, created_at, last_used_at, last_penalty_turn_id FROM style_examples'
    + (kind ? ' WHERE kind = ?' : '') + ' ORDER BY id DESC LIMIT ?';
  const args = kind ? [kind, Math.max(1, Number(limit) || 20)] : [Math.max(1, Number(limit) || 20)];
  try {
    return db.prepare(sql).all(...args);
  } catch {
    return [];
  }
}
