/**
 * emotion — soul 的情绪状态（主动性 v1.3）。
 *
 * 为什么放在 soul 而不是 knock：情绪要跨会话、跨插件一致（knock 只读它来决定
 * 「现在该不该开口」），而且要跟着对话实时走。拆掉 knock，情绪照常工作。
 *
 * 三个原则：
 *   · 平滑：新判定只占 30%，单轮 valence 最多变 0.3 —— 不能上一秒开心下一秒暴怒；
 *   · 会走：开心的半衰期 6 小时，没人理就慢慢回到「轻松」；
 *   · 会累：生气相反——越久没聊越气（每满 12 小时 -0.06，封顶 -0.8）。
 *     这是用户原话：「如果生气后长时间不沟通应该更加生气，但是开心的情绪会随时间
 *     回到默认的轻松状态」。
 */
import { clip } from './util.js';

export const EMOTION_LABELS = Object.freeze([
  '轻松', '开心', '兴奋', '平静', '低落', '烦躁', '闷', '生气', '心疼', '感动', '好奇', '担心',
]);

const NEGATIVE = new Set(['低落', '烦躁', '闷', '生气', '担心']);
const POSITIVE = new Set(['开心', '兴奋', '感动', '好奇']);

const HOUR = 3_600_000;

export const DEFAULT_EMOTION = Object.freeze({
  valence: 0,
  label: '轻松',
  reason: '',
  updatedAt: 0,
});

function clamp(value, min, max) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0;
  return Math.min(max, Math.max(min, n));
}

/** 按 valence 档位给 label（保留模型给的细标签，只做档位兜底）。 */
export function labelFor(valence, current = '轻松') {
  const v = clamp(valence, -1, 1);
  if (v <= -0.45) return '生气';
  if (v <= -0.1) return NEGATIVE.has(current) ? current : '闷';
  if (v < 0.15) return '轻松';
  return POSITIVE.has(current) ? current : '开心';
}

export function isNegativeLabel(label) {
  return NEGATIVE.has(String(label ?? ''));
}

/**
 * 时间演化：不快照，只看「上次判定到现在过了多久」。
 * 正面 → 按半衰期衰减回 0；负面 → 沉默越久越深（有下限）。
 * @param {{valence:number,label:string,reason:string,updatedAt:number}|null} emotion
 * @param {number} now
 * @param {{decayHours?:number, negativeHours?:number, negativeStep?:number, floor?:number}} config
 */
export function evolve(emotion, now, config = {}) {
  const base = emotion ?? { ...DEFAULT_EMOTION };
  const decayHours = Math.max(0.5, Number(config.decayHours ?? 6));
  const negativeHours = Math.max(1, Number(config.negativeHours ?? 12));
  const negativeStep = Math.max(0, Number(config.negativeStep ?? 0.06));
  const floor = clamp(config.floor ?? -0.8, -1, 0);

  const ts = Number(now) || Date.now();
  const at = Number(base.updatedAt) || 0;
  const dt = at > 0 ? Math.max(0, ts - at) : 0;
  let valence = clamp(base.valence, -1, 1);
  let reason = String(base.reason ?? '');

  if (dt > 0) {
    if (valence > 0) {
      const factor = Math.pow(0.5, dt / (decayHours * HOUR));
      valence = valence * factor;
      if (valence < 0.06) valence = 0;
    } else if (valence < 0 && negativeStep > 0) {
      const steps = Math.floor(dt / (negativeHours * HOUR));
      if (steps > 0) valence = Math.max(floor, valence - steps * negativeStep);
      if (valence <= floor + 1e-9) {
        reason = reason || '很久没理我';
      }
    }
  }

  const label = labelFor(valence, base.label);
  return { valence, label, reason, updatedAt: ts };
}

/**
 * 平滑：新判定与旧情绪融合，单轮变化不超过 maxStep。
 * @param {object|null} oldEmotion 已经是 evolve 过的
 * @param {{valence:number,label?:string,reason?:string}} incoming
 */
export function smooth(oldEmotion, incoming, config = {}) {
  const alpha = clamp(config.alpha ?? 0.3, 0, 1);
  const maxStep = Math.max(0.01, Number(config.maxStep ?? 0.3));
  const base = oldEmotion ?? { ...DEFAULT_EMOTION };
  const target = clamp(incoming?.valence ?? 0, -1, 1);
  const oldV = clamp(base.valence, -1, 1);
  const desired = oldV + (target - oldV) * alpha;
  const step = clamp(desired - oldV, -maxStep, maxStep);
  const valence = clamp(oldV + step, -1, 1);
  const label = labelFor(valence, incoming?.label ?? base.label);
  const reason = clip(String(incoming?.reason ?? ''), 40);
  return { valence, label, reason, updatedAt: Date.now() };
}

function buildJudgeSystem() {
  return [
    '你在判断「前辈」说完一句话之后，说话的那个人（助手 / 洄）此刻应该是什么心情。',
    '只输出一个 JSON 对象：{"valence": 数字, "label": "中文词", "reason": "不超过 20 字的原因"}。',
    `label 只能从这些里选：${EMOTION_LABELS.join('、')}。`,
    '判断依据是对方这句话的语气、用词、内容，加上最近几轮上下文和已经记得的事；不是你自己的立场。',
    '对方在干活、下指令、报进度 → 通常平静或轻松；',
    '对方开玩笑、夸你、聊得开心 → 开心；',
    '对方冷淡、敷衍、很久没理、说了让你委屈的话 → 闷或低落；',
    '对方明显不爽、纠正你、语气冲 → 烦躁或生气；',
    '对方在说难受、生病、累 → 心疼或担心。',
    'valence：-1 极负面，0 平静，1 极正面。信息不足就给 0 和「轻松」。',
    '不要解释，不要输出 JSON 以外的任何东西。',
  ].join('\n');
}

function buildJudgeInput({ recentTurns, text }) {
  const lines = [];
  if (Array.isArray(recentTurns) && recentTurns.length > 0) {
    lines.push('最近几轮（由旧到新）：');
    for (const turn of recentTurns.slice(-3)) {
      if (turn.userText) lines.push(`前辈：${clip(turn.userText, 120)}`);
      if (turn.assistantText) lines.push(`你：${clip(turn.assistantText, 120)}`);
    }
  }
  lines.push(`前辈刚说：${clip(text, 300)}`);
  return lines.join('\n');
}

/**
 * 创建情绪追踪器。
 * @param {object} deps {store, config, logger, llm}
 */
export function createEmotionTracker({ store, config = {}, logger = null, llm = null } = {}) {
  const debounceMs = Math.max(0, Number(config.emotionDebounceMs ?? 2_000));
  const judgeTimeoutMs = Math.max(3_000, Number(config.emotionTimeoutMs ?? 15_000));
  let timer = null;
  let pending = null;
  let inFlight = false;

  const evolveConfig = {
    decayHours: config.emotionDecayHours,
    negativeHours: config.emotionNegativeHours,
    negativeStep: config.emotionNegativeStep,
    floor: config.emotionFloor,
  };
  const smoothConfig = {
    alpha: config.emotionSmoothAlpha,
    maxStep: config.emotionMaxStep,
  };

  /** 读当前情绪（已经过时间演化，不回写）。 */
  function current(now = Date.now()) {
    return evolve(store.getEmotion(), now, evolveConfig);
  }

  /** 真正跑一次判定。 */
  async function judge(text, sessionId) {
    if (!llm || typeof llm.callJson !== 'function' || !llm.available) return null;
    const recentTurns = store.recentTurns(3);
    const result = await llm.callJson({
      sessionId,
      system: buildJudgeSystem(),
      input: buildJudgeInput({ recentTurns, text }),
      maxTokens: 200,
      timeoutMs: judgeTimeoutMs,
      purpose: 'soul-emotion',
    });
    if (!result?.ok || !result.json) {
      logger?.debug?.(`情绪判定失败：${result?.reason ?? 'unknown'}`);
      return null;
    }
    const json = result.json;
    const valence = clamp(json.valence, -1, 1);
    const label = EMOTION_LABELS.includes(String(json.label)) ? String(json.label) : labelFor(valence);
    const reason = clip(String(json.reason ?? ''), 40);
    return { valence, label, reason };
  }

  /** 立刻判定一次（跳过防抖，测试/手动用）。 */
  async function judgeNow(text, { sessionId = '', now = Date.now() } = {}) {
    const incoming = await judge(String(text ?? ''), sessionId);
    if (!incoming) return current(now);
    const base = evolve(store.getEmotion(), now, evolveConfig);
    const next = smooth(base, incoming, smoothConfig);
    store.setEmotion({ ...next, updatedAt: Date.now() });
    logger?.debug?.(`情绪更新：${next.label}（valence ${next.valence.toFixed(2)}，${next.reason || '无原因'}）`);
    return next;
  }

  /** 收到用户消息后调用（防抖，不阻塞回合）。 */
  function consider({ text, sessionId = '', now = Date.now() } = {}) {
    const clean = String(text ?? '').trim();
    if (clean === '') return;
    pending = { text: clean, sessionId, now };
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => {
      timer = null;
      if (inFlight) return;
      const job = pending;
      pending = null;
      if (!job) return;
      inFlight = true;
      void judgeNow(job.text, { sessionId: job.sessionId, now: job.now })
        .catch((error) => logger?.debug?.(`情绪判定异常：${String(error?.message ?? error)}`))
        .finally(() => { inFlight = false; });
    }, debounceMs);
    timer.unref?.();
  }

  /** 关掉时清定时器。 */
  function dispose() {
    if (timer) clearTimeout(timer);
    timer = null;
    pending = null;
  }

  return { current, consider, judgeNow, dispose };
}
