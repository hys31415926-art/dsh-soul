/**
 * dsh-soul retrieval — 每轮只取「与当前请求相关」的一小撮记忆。
 *
 * 策略（第一版，无向量库）：
 *   1. 检索词 = 当前用户消息（截断）+ 本会话上次未解决的问题；
 *   2. SQL 层 LIKE 召回 + FTS5 trigram（可用时）召回，按置信度/命中/新旧打分；
 *   3. 再按类型做多样性限制（同一类型最多 2 条），避免注入块被偏好类记忆刷满；
 *   4. 最后用字符预算硬裁剪 —— 宁可少一条，也不让注入块膨胀。
 *
 * 检索结果会顺手更新 last_accessed_at/hits：真被用到的记忆比没被用到的更可信。
 */
import { clamp, clip } from '../util.js';
import { blobToVector, cosine } from './embed.js';

/** 组装检索词。 */
export function buildQuery(lastUserText, state) {
  const parts = [];
  const text = String(lastUserText ?? '').trim();
  if (text !== '') parts.push(clip(text, 240));
  if (state?.openQuestion) parts.push(clip(state.openQuestion, 80));
  return parts.join(' ');
}

/**
 * 注入用途分级（v1.4）：决定这条记忆「能怎么用」，而不是一律当事实摆出来。
 *   mention   —— 可以自然提起；
 *   tone      —— 只用来调语气（偏好／互动方式／关系），不要复述内容；
 *   uncertain —— 置信度低或太久没更新，只带不确定感，别当事实说。
 */
export function usageOf(memory, { now = Date.now(), staleDays = 120, lowConfidence = 0.55 } = {}) {
  const confidence = Number(memory?.confidence ?? 0.6);
  const updatedAt = Number(memory?.updatedAt ?? 0);
  const ageDays = updatedAt > 0 ? (now - updatedAt) / 86_400_000 : 0;
  if (confidence < lowConfidence) return 'uncertain';
  if (ageDays > staleDays) return 'uncertain';
  const type = String(memory?.type ?? '');
  if (type === 'preference' || type === 'interaction' || type === 'relationship') return 'tone';
  return 'mention';
}

/**
 * 取本轮要注入的记忆。
 * @param {import('../memory/store.js').Store} store
 * @param {{query?: string, limit?: number, budgetChars?: number, projectId?: number,
 *          queryVector?: Float32Array|null, semanticMin?: number}} options
 *        queryVector：本地向量（有才做语义召回）；semanticMin：低于这个余弦就丢掉，默认 0.5
 * @returns {{memories: object[], chars: number}}
 */
export function selectMemories(store, options = {}) {
  const limit = clamp(options.limit ?? 6, 1, 20);
  const budgetChars = clamp(options.budgetChars ?? 420, 80, 4000);
  const query = String(options.query ?? '');
  const projectId = Number(options.projectId ?? 0);
  const queryVector = options.queryVector && options.queryVector.length > 0 ? options.queryVector : null;
  const semanticMin = clamp(options.semanticMin ?? 0.5, 0.2, 0.95);

  const pool = new Map();
  const addAll = (rows, semantic = 0) => {
    for (const row of rows) {
      if (!pool.has(row.id)) pool.set(row.id, { memory: row, semantic });
    }
  };

  if (query !== '') addAll(store.searchMemories(query, Math.max(limit * 4, 24)));
  else addAll(store.topMemories(Math.max(limit * 3, 12)));
  if (projectId > 0) addAll(store.listMemories({ projectId, limit: 8 }));

  // 语义召回：换种说法也能找到（字面 LIKE 搜不到的近义表达）。
  // 向量只做候选入口，进不进注入块仍由下面的排序/预算决定。
  if (queryVector) {
    try {
      for (const row of store.listEmbeddings('memory')) {
        const vector = blobToVector(row.vector);
        if (!vector || vector.length !== queryVector.length) continue;
        const score = cosine(queryVector, vector);
        if (score < semanticMin) continue;
        const memory = store.getMemory(row.refId);
        if (!memory || memory.status !== 'active') continue;
        addAll([memory], score);
      }
    } catch { /* 向量表坏了也不影响字面检索 */ }
  }

  // 排序：置信度 + 重要性 + 命中次数 + 新鲜度。重要性让「用户明确要求/决定」
  // 优先于随口一句偏好；只注入 active，候选记忆不参与。
  const ordered = [...pool.values()]
    .filter((entry) => entry.memory.status === 'active')
    .sort((a, b) => (rankScore(b.memory) + b.semantic * 0.35) - (rankScore(a.memory) + a.semantic * 0.35))
    .map((entry) => entry.memory);

  // 多样性：同一类型最多 2 条；再按内容相似度去重（换句话说的同一件事只留一条）。
  const perType = new Map();
  const picked = [];
  for (const memory of ordered) {
    if (picked.some((other) => similarity(other.content, memory.content) >= 0.72)) continue;
    const count = perType.get(memory.type) ?? 0;
    if (count >= 2) continue;
    perType.set(memory.type, count + 1);
    picked.push(memory);
    if (picked.length >= limit) break;
  }

  const out = [];
  let used = 0;
  for (const memory of picked) {
    const cost = Math.min(memory.content.length, 120) + 16;
    if (out.length > 0 && used + cost > budgetChars) break;
    out.push(memory);
    used += cost;
  }
  return { memories: out, chars: used };
}

/** 单条记忆的排序分：置信度 45% + 重要性 30% + 新鲜度/命中 25%。 */
function rankScore(memory) {
  const confidence = Number(memory.confidence ?? 0.6);
  const importance = Number(memory.importance ?? 0.5);
  const hits = Math.min(Number(memory.hits ?? 1), 10);
  const ageDays = Math.max(0, (Date.now() - Number(memory.updatedAt ?? 0)) / 86_400_000);
  const freshness = Math.max(0, 1 - ageDays / 14);
  return confidence * 0.45 + importance * 0.3 + hits * 0.02 + freshness * 0.23;
}

/** 字符 bigram 相似度（与 hooks.js 同口径，用于注入前近邻去重）。 */
function similarity(a, b) {
  const bigrams = (text) => {
    const normalized = String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
    const set = new Set();
    for (let i = 0; i < normalized.length - 1; i += 1) set.add(normalized.slice(i, i + 2));
    return set;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / (left.size + right.size - intersection);
}

/** 关系连续性素材：关系事实 + 交互偏好。 */
export function selectRelationshipMaterial(store, limit = 4) {
  const rows = [
    ...store.listMemories({ type: 'relationship', limit }),
    ...store.listMemories({ type: 'interaction', limit }),
  ];
  const seen = new Set();
  const out = [];
  for (const row of rows) {
    if (seen.has(row.id)) continue;
    seen.add(row.id);
    out.push(row);
    if (out.length >= limit) break;
  }
  return out;
}
