/**
 * dsh-soul retrieval — 每轮只取「与当前请求相关」的一小撮记忆。
 *
 * 策略：
 *   1. 检索词默认只取「当前用户消息」——把旧话题拼进来最容易答非所问；
 *   2. SQL 层 LIKE 召回 + FTS5 trigram（可用时），按置信度/命中/新旧打分；
 *   3. 再按类型做多样性限制（同一类型最多 2 条）；
 *   4. 最后用字符预算硬裁剪 —— 宁可少一条，也不让注入块膨胀。
 *
 * v1.5 加了四件事：
 *   - planRetrieval()：这一轮「怎么检索」（模式 / 时间窗口 / 类型白名单）；
 *   - 单值属性改口：问「以前」时把被取代的旧值也算进来（past 用法）；
 *   - 检索缓存：同一句话短时间内重复问不必重算，命中也要重读并重判可见性；
 *   - 可观测：返回 path / cache / filtered，「为什么这条没被注入」有据可查。
 */
import { clamp, clip } from '../util.js';
import { hasSubstantiveQuery } from '../core/conversation-policy.js';
import { blobToVector, cosine } from './embed.js';

/** 检索模式：只按当前消息 / 受控陪伴 / 陪伴优先（旧式拼接）。 */
export const QUERY_MODES = Object.freeze(['current_message', 'guarded_companion', 'companion_augmented']);

/** 问「眼下状态」的句子：只翻最近几天的记忆。 */
const STATUS_ASK_RE = /^(你|今天|现在|最近|这会儿)?\s*(在干嘛|在忙吗|忙吗|吃了?吗|吃没|睡了?吗|睡没|醒了?吗|干嘛呢|在做什么|状态怎么样|还好吗|在哪儿)/u;
/** 问「过去」的句子：被取代的旧值也算素材。 */
const PAST_ASK_RE = /(以前|之前|原来|过去|当时|那时候|曾经|小时候|旧地址|换之前)/u;
/** 陪伴线索：受控模式只在「有线索 + 有话题」时才扩展检索。 */
const COMPANION_CUE_RE = /(陪我|抱抱|想你|晚安|早安|撒娇|贴贴|累|烦|难受|开心|心情)/u;
/** 状态类问题只允许这几类记忆进来。 */
const STATUS_TYPES = ['profile', 'fact', 'episodic'];

const CACHE_TTL_MS = 60_000;
const CACHE_MAX = 120;
const cache = new Map();

/** 清空检索缓存（测试用）。 */
export function clearRetrievalCache() {
  cache.clear();
}

function cacheGet(key, now) {
  const hit = cache.get(key);
  if (!hit) return null;
  if (now - hit.at > CACHE_TTL_MS) {
    cache.delete(key);
    return null;
  }
  return hit;
}

function cacheSet(key, value, now) {
  cache.set(key, { ...value, at: now });
  if (cache.size > CACHE_MAX) {
    const drop = [...cache.entries()].sort((a, b) => a[1].at - b[1].at).slice(0, cache.size - CACHE_MAX);
    for (const [stale] of drop) cache.delete(stale);
  }
}

/** 组装检索词（老接口，保留给测试与外部调用）。 */
export function buildQuery(lastUserText, state) {
  const parts = [];
  const text = String(lastUserText ?? '').trim();
  if (text !== '') parts.push(clip(text, 240));
  if (state?.openQuestion) parts.push(clip(state.openQuestion, 80));
  return parts.join(' ');
}

/**
 * 决定这一轮「怎么检索」。
 * 把旧话题、未决问题、陪伴线索一股脑拼进检索词，最容易答非所问；
 * 所以默认只按当前消息检索，只在有明确线索时才扩展。
 * @param {{text?: string, intent?: object, state?: object, config?: object}} input
 * @returns {{mode: string, query: string, windowDays: number, types: string[]|null,
 *            includeSuperseded: boolean, reasons: string[]}}
 */
export function planRetrieval({ text = '', intent = {}, state = {}, config = {} } = {}) {
  const topic = String(text ?? '');
  const configured = QUERY_MODES.includes(String(config.queryMode ?? '')) ? String(config.queryMode) : 'current_message';
  const reasons = [];
  let mode = configured;

  if (configured === 'guarded_companion') {
    const cue = COMPANION_CUE_RE.test(topic) || intent?.emotional === true || intent?.flirt === true;
    const onTopic = hasSubstantiveQuery(topic) || intent?.memoryAsk === true || intent?.work === true || intent?.discussion === true;
    mode = cue && onTopic ? 'companion_augmented' : 'current_message';
    reasons.push(
      cue
        ? (onTopic ? '陪伴线索与当前话题重叠，扩展检索' : '只有陪伴线索、没有实质话题，按当前消息检索')
        : '没有陪伴线索，按当前消息检索',
    );
  }

  const pastAsk = PAST_ASK_RE.test(topic);
  const statusAsk = STATUS_ASK_RE.test(topic) && !pastAsk;
  const windowDays = statusAsk ? clamp(Number(config.statusWindowDays ?? 7), 0, 365) : 0;
  const types = statusAsk ? [...STATUS_TYPES] : null;
  if (statusAsk) reasons.push(`问的是眼下状态，只看最近 ${windowDays} 天的画像/事实/情景`);
  if (pastAsk) reasons.push('问的是过去，被取代的旧值也算素材');
  if (intent?.kind === 'memory-ask' || intent?.memoryAsk === true) reasons.push('这一轮在让回忆，放宽到全部历史');

  const parts = [];
  if (topic !== '') parts.push(clip(topic, 240));
  if (mode === 'companion_augmented' && String(state?.openQuestion ?? '') !== '') {
    parts.push(clip(state.openQuestion, 80));
    reasons.push('陪伴模式：把还没解决的事一并带进检索词');
  }

  return { mode, query: parts.join(' '), windowDays, types, includeSuperseded: pastAsk, reasons };
}

/**
 * 注入用途分级（v1.4）：决定这条记忆「能怎么用」，而不是一律当事实摆出来。
 *   mention   —— 可以自然提起；
 *   tone      —— 只用来调语气（偏好／互动方式／关系），不要复述内容；
 *   uncertain —— 置信度低或太久没更新，只带不确定感，别当事实说；
 *   past      —— 已被取代的旧值，只能当「以前」说（v1.5）。
 */
export function usageOf(memory, { now = Date.now(), staleDays = 120, lowConfidence = 0.55 } = {}) {
  if (String(memory?.status ?? 'active') === 'superseded') return 'past';
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
 *          queryVector?: Float32Array|null, semanticMin?: number, sessionId?: string,
 *          mode?: string, sinceDays?: number, types?: string[]|null,
 *          includeSuperseded?: boolean, now?: number}} options
 *        queryVector：本地向量（有才做语义召回）；semanticMin：低于这个余弦就丢掉
 * @returns {{memories: object[], chars: number, path: string, cache: string,
 *            filtered: object, mode: string, considered: number,
 *            excluded: {id:number, reason:string, type:string, status:string, chars:number}[],
 *            overBudgetIds: number[]}}
 */
export function selectMemories(store, options = {}) {
  const limit = clamp(options.limit ?? 6, 1, 20);
  const budgetChars = clamp(options.budgetChars ?? 420, 80, 4000);
  const query = String(options.query ?? '');
  const projectId = Number(options.projectId ?? 0);
  const queryVector = options.queryVector && options.queryVector.length > 0 ? options.queryVector : null;
  const semanticMin = clamp(options.semanticMin ?? 0.5, 0.2, 0.95);
  const mode = QUERY_MODES.includes(String(options.mode ?? '')) ? String(options.mode) : 'current_message';
  const sessionId = String(options.sessionId ?? '');
  const sinceDays = clamp(options.sinceDays ?? 0, 0, 3650);
  const types = Array.isArray(options.types) && options.types.length > 0 ? options.types.map((t) => String(t)) : null;
  const includeSuperseded = options.includeSuperseded === true;
  const now = Number(options.now ?? Date.now());
  const filtered = { wrongStatus: 0, wrongType: 0, tooOld: 0, duplicate: 0, overBudget: 0, typeQuota: 0 };
  // v1.6 唤醒诊断：不只数「淘汰了几条」，还要能说清「哪一条、因为什么」被淘汰。
  // 只记 ID / 原因码 / 类型 / 长度，不记正文；上限 60 条，避免一条日志塞进整库记忆。
  const excluded = [];
  const overBudgetIds = [];
  const noteExcluded = (memory, reason) => {
    if (!memory || excluded.length >= 60) return;
    const id = Number(memory.id ?? 0);
    if (id <= 0) return;
    const chars = String(memory.content ?? '').length;
    excluded.push({
      id,
      reason,
      type: String(memory.type ?? ''),
      status: String(memory.status ?? ''),
      chars,
    });
    if (reason === 'overBudget' && overBudgetIds.length < 40) overBudgetIds.push(id);
  };
  // 「找到但没通过筛选」和「根本没找到」必须能分开：前者有 candidates，后者没有。
  const diagnostics = (considered) => ({
    considered,
    excluded,
    overBudgetIds,
    cacheState: null,
  });

  const eligible = (memory) => {
    if (!memory) return false;
    const status = String(memory.status ?? 'active');
    if (status === 'superseded') {
      if (!includeSuperseded) {
        filtered.wrongStatus += 1;
        noteExcluded(memory, 'wrongStatus');
        return false;
      }
    } else if (status !== 'active') {
      filtered.wrongStatus += 1;
      noteExcluded(memory, 'wrongStatus');
      return false;
    }
    if (types && !types.includes(String(memory.type ?? ''))) {
      filtered.wrongType += 1;
      noteExcluded(memory, 'wrongType');
      return false;
    }
    if (sinceDays > 0) {
      const touched = Number(memory.lastAccessedAt ?? 0) || Number(memory.updatedAt ?? 0);
      if (touched > 0 && now - touched > sinceDays * 86_400_000) {
        filtered.tooOld += 1;
        noteExcluded(memory, 'tooOld');
        return false;
      }
    }
    return true;
  };

  const pack = (rows) => {
    const out = [];
    let chars = 0;
    for (const memory of rows) {
      if (!memory) continue;
      const cost = Math.min(String(memory.content ?? '').length, 120) + 16;
      if (chars + cost > budgetChars) {
        filtered.overBudget += 1;
        noteExcluded(memory, 'overBudget');
        continue;
      }
      out.push(memory);
      chars += cost;
    }
    return { memories: out, chars };
  };

  // 缓存命中也要重读记录、重判可见性：库里被改过的记忆不能凭旧快照注入。
  const fingerprint = String(store.memoryFingerprint?.() ?? '');
  const cacheKey = [
    fingerprint,
    sessionId,
    mode,
    query,
    limit,
    budgetChars,
    projectId,
    sinceDays,
    types ? types.join(',') : '',
    includeSuperseded ? 1 : 0,
    queryVector ? 'vec' : '',
  ].join('|');
  const cached = cacheGet(cacheKey, now);
  if (cached) {
    const fresh = (cached.ids ?? []).map((id) => store.getMemory(id)).filter((memory) => memory && eligible(memory));
    const packedHit = pack(fresh);
    if (packedHit.memories.length > 0) {
      return {
        memories: packedHit.memories, chars: packedHit.chars, path: cached.path, cache: 'hit', filtered, mode,
        considered: (cached.ids ?? []).length, excluded, overBudgetIds,
      };
    }
    cache.delete(cacheKey);
  }

  const pool = new Map();
  let path = 'none';
  const add = (memory) => {
    if (!memory || pool.has(memory.id)) return;
    if (!eligible(memory)) return;
    pool.set(memory.id, memory);
  };

  if (query !== '') {
    for (const memory of store.searchMemories(query, Math.max(limit * 4, 24))) add(memory);
    if (pool.size > 0) path = 'literal';
  } else {
    for (const memory of store.topMemories(Math.max(limit * 3, 12))) add(memory);
    if (pool.size > 0) path = 'popular';
  }
  if (projectId > 0) {
    for (const memory of store.listMemories({ projectId, limit: 8 })) add(memory);
  }
  if (includeSuperseded) {
    for (const memory of store.supersededMemories({ limit: 8 })) add(memory);
  }

  if (queryVector) {
    for (const row of store.listEmbeddings('memory')) {
      const memory = store.getMemory(row.refId);
      if (!memory) continue;
      const score = cosine(queryVector, blobToVector(row.vector));
      if (!(score >= semanticMin)) continue;
      add(memory);
      path = 'vector';
    }
  }

  const ordered = [...pool.values()].sort((a, b) => rankScore(b) - rankScore(a));
  const picked = [];
  const perType = new Map();
  for (const memory of ordered) {
    if (picked.length >= limit) break;
    const type = String(memory.type ?? '');
    const used = perType.get(type) ?? 0;
    if (used >= 2) {
      filtered.typeQuota += 1;
      noteExcluded(memory, 'typeQuota');
      continue;
    }
    if (picked.some((previous) => similarity(previous.content, memory.content) >= 0.72)) {
      filtered.duplicate += 1;
      continue;
    }
    picked.push(memory);
    perType.set(type, used + 1);
  }

  const packed = pack(picked);
  cacheSet(cacheKey, { ids: packed.memories.map((memory) => memory.id), path }, now);
  return {
    memories: packed.memories, chars: packed.chars, path, cache: 'miss', filtered, mode,
    considered: ordered.length, excluded, overBudgetIds,
  };
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
