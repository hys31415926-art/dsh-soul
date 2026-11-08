/**
 * 写入凭据（mandate）v1.8
 *
 * 借鉴 dsh-superagent 的 Mandate 概念：一条记忆「凭什么被允许写进来」。
 * 它和 confidence 不是一回事——confidence 说「有多可信」，mandate 说「谁、按哪条规则、
 * 以什么强度授权的」。explicit 只来自用户明确要求或工具直写；inferred 来自自动抽取，
 * 后面应当可被 revalidation 推翻，而不是跟 explicit 一样硬。
 */

export const POLICY_VERSION = 1;

/** 强度由高到低，用于合并同一条记忆时保留更强的凭据。 */
export const MANDATE_STRENGTH_RANK = { explicit: 2, inferred: 1 };

const STRENGTHS = Object.keys(MANDATE_STRENGTH_RANK);

/**
 * 从 source 推一条默认凭据。老的 14 个 rememberMemory 调用点不必全改，
 * 这里按来源给出最保守的解释：用户说过的/user-* 和 tool 算 explicit，
 * 其余（auto、enhanced、curation:、relationship signal…）一律 inferred。
 */
function inferFromSource(source, { by = 'system', reason = '' } = {}) {
  const text = String(source ?? 'auto');
  const explicit = text === 'tool' || text.startsWith('user-') || text === 'user';
  return {
    strength: explicit ? 'explicit' : 'inferred',
    basis: text,
    rule: reason ? String(reason).slice(0, 80) : '',
    by,
    policyVersion: POLICY_VERSION,
    ts: Date.now(),
  };
}

/** 任何输入（对象/JSON 字符串/空）都归一成合法凭据对象。 */
export function normalizeMandate(input, fallback = {}) {
  const base = inferFromSource(fallback.source ?? 'auto', fallback);
  if (input == null || input === '') return base;
  let obj = input;
  if (typeof input === 'string') {
    try {
      obj = JSON.parse(input);
    } catch {
      return base;
    }
  }
  if (!obj || typeof obj !== 'object') return base;
  const strength = STRENGTHS.includes(obj.strength) ? obj.strength : base.strength;
  return {
    strength,
    basis: String(obj.basis ?? base.basis ?? '').slice(0, 80),
    rule: String(obj.rule ?? base.rule ?? '').slice(0, 80),
    by: String(obj.by ?? base.by ?? 'system').slice(0, 40),
    policyVersion: Number.isFinite(Number(obj.policyVersion)) ? Number(obj.policyVersion) : POLICY_VERSION,
    ts: Number.isFinite(Number(obj.ts)) ? Number(obj.ts) : Date.now(),
  };
}

/** 存库形态：稳定字段顺序的 JSON 字符串，空凭据存空串（老库兼容）。 */
export function serializeMandate(mandate) {
  if (!mandate) return '';
  const m = normalizeMandate(mandate);
  return JSON.stringify(m);
}

/** 读库形态：坏 JSON 不抛错，返回 null，让调用方按「没有凭据」处理。 */
export function parseMandate(raw) {
  if (raw == null || raw === '') return null;
  if (typeof raw === 'object') return normalizeMandate(raw);
  try {
    return normalizeMandate(JSON.parse(raw));
  } catch {
    return null;
  }
}

/** 比较两条凭据，返回更强的那条；同级时取更晚的（新决定覆盖老决定）。 */
export function strongerMandate(a, b) {
  const left = typeof a === 'string' ? parseMandate(a) : a;
  const right = typeof b === 'string' ? parseMandate(b) : b;
  if (!left) return right ?? null;
  if (!right) return left;
  const dl = MANDATE_STRENGTH_RANK[left.strength] ?? 0;
  const dr = MANDATE_STRENGTH_RANK[right.strength] ?? 0;
  if (dl !== dr) return dl > dr ? left : right;
  return (right.ts ?? 0) >= (left.ts ?? 0) ? right : left;
}

/** 给 /soul 用的一行人话：explicit / 依据 soul_remember / 由 assistant 写入。 */
export function describeMandate(raw) {
  const m = parseMandate(raw);
  if (!m) return '（没有记录写入凭据：v1.8 之前的旧记忆）';
  const strength = m.strength === 'explicit' ? '明确（explicit）' : '推断（inferred）';
  const parts = [`强度 ${strength}`, `依据 ${m.basis || '未知'}`, `写入者 ${m.by}`];
  if (m.rule) parts.push(`命中 ${m.rule}`);
  parts.push(`策略版本 v${m.policyVersion}`);
  if (m.ts) parts.push(`时间 ${new Date(m.ts).toISOString().slice(0, 19).replace('T', ' ')}`);
  return parts.join('，');
}
