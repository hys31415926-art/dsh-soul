/**
 * 双层裁决（借鉴 dsh-superagent 的 Eval：gate + assessment）。
 *
 * 为什么要有它：一件事「该不该我现在动手」不该只靠嘴说。把这一判断拆成两层，
 * 外面那层是确定的（谁在等、有没有被卡住、有没有被标成我在推），
 * 里面那层是可解释的打分（优先级、挂了多久、有没有验收条件）。
 *
 * 边界：这两个函数都不读库、不发请求，只吃一个 item 和一点上下文；
 * 状态在 store 里，判断在这里，写成什么样在别处。
 */

/** 默认接受模式：先观察，别自作主张。 */
export const DEFAULT_ACCEPT_MODE = 'observe';

const DAY = 24 * 3_600_000;

function clipText(value, max) {
  const text = String(value ?? '').trim();
  return text.length > max ? `${text.slice(0, max - 1)}…` : text;
}

/**
 * 第一层：确定性的闸门。只看「这件事现在归谁」。
 * 返回 { pass, strength, reason }。
 */
export function gateItem(item, { now = Date.now() } = {}) {
  if (!item || typeof item !== 'object') {
    return { pass: false, strength: 'not-admitted', reason: '没有这条' };
  }
  if (String(item.state ?? '') === 'done') {
    return { pass: false, strength: 'not-admitted', reason: '已经做完了' };
  }
  const report = String(item.report ?? '');
  if (report === 'blocked' || report === 'failed') {
    return { pass: false, strength: 'not-admitted', reason: '上次是卡住/失败，先别硬推' };
  }
  const stage = String(item.stage ?? '');
  if (stage === 'agent') {
    return { pass: true, strength: 'explicit', reason: '你标了这条我在推' };
  }
  if (stage === 'person') {
    return { pass: false, strength: 'not-admitted', reason: '这条在等你' };
  }
  if (stage === 'blocked') {
    return { pass: false, strength: 'not-admitted', reason: '这条标了卡住' };
  }
  if (stage === '') {
    const kind = String(item.kind ?? '');
    const priority = Number(item.priority ?? 0) || 0;
    if (kind === 'todo' && priority > 0) {
      return { pass: true, strength: 'inferred', reason: `没标状态，但优先级 ${priority}` };
    }
    return { pass: false, strength: 'not-admitted', reason: '没标在等谁，也没优先级' };
  }
  void now;
  return { pass: false, strength: 'not-admitted', reason: `认不出的 stage「${clipText(stage, 12)}」` };
}

/**
 * 第二层：可解释的打分，0–1。分数低不等于没价值，只代表不着急。
 * 返回 { score, matched }，matched 是给人看的理由短语。
 */
export function assessItem(item, { now = Date.now() } = {}) {
  const matched = [];
  let score = 0;
  const priority = Math.max(0, Number(item?.priority ?? 0) || 0);
  if (priority >= 3) { score += 0.4; matched.push(`优先级 ${priority}`); }
  else if (priority === 2) { score += 0.3; matched.push('优先级 2'); }
  else if (priority === 1) { score += 0.2; matched.push('优先级 1'); }

  const createdAt = Number(item?.createdAt ?? item?.created_at ?? 0) || 0;
  if (createdAt > 0) {
    const days = Math.max(0, (now - createdAt) / DAY);
    if (days >= 7) { score += 0.3; matched.push('挂了 7 天以上'); }
    else if (days >= 3) { score += 0.2; matched.push(`挂了 ${Math.floor(days)} 天`); }
  }

  if (String(item?.acceptance ?? '').trim() !== '') {
    score += 0.15;
    matched.push('写了验收条件');
  }
  if (String(item?.dependsOn ?? '').trim() !== '') {
    score -= 0.05;
    matched.push('有前置');
  }
  return { score: Math.min(1, Math.max(0, Number(score.toFixed(2)))), matched };
}

/**
 * 两层合起来给一个裁决。
 * mode = 'observe'（默认）：推断出来的事只记「本来会做」，不动手。
 * mode = 'auto'：推断 + 分数过线才算数。
 */
export function evaluateItem(item, {
  now = Date.now(),
  mode = DEFAULT_ACCEPT_MODE,
  minScore = 0.5,
} = {}) {
  const gate = gateItem(item, { now });
  if (!gate.pass) {
    const decision = gate.reason.includes('卡住') || gate.reason.includes('失败') ? 'wait' : 'ignore';
    return {
      decision,
      strength: gate.strength,
      score: 0,
      matched: [],
      why: gate.reason,
      gate,
    };
  }
  const { score, matched } = assessItem(item, { now });
  const why = matched.length > 0 ? matched.join('、') : '闸门放行，但没什么加分项';
  if (gate.strength === 'explicit') {
    return {
      decision: 'accept', strength: gate.strength, score, matched, why, gate,
    };
  }
  if (mode === 'auto' && score >= minScore) {
    return {
      decision: 'accept', strength: gate.strength, score, matched, why, gate,
    };
  }
  return {
    decision: 'observe', strength: gate.strength, score, matched, why, gate,
  };
}

/**
 * 一组条目按裁决排序：accept 在前，observe 次之，wait/ignore 垫底，同档按分数。
 */
export function rankItems(items, options = {}) {
  const order = { accept: 0, observe: 1, wait: 2, ignore: 3, unavailable: 4 };
  return (items ?? [])
    .map((item) => ({ item, verdict: evaluateItem(item, options) }))
    .sort((a, b) => {
      const byDecision = (order[a.verdict.decision] ?? 9) - (order[b.verdict.decision] ?? 9);
      if (byDecision !== 0) return byDecision;
      if (b.verdict.score !== a.verdict.score) return b.verdict.score - a.verdict.score;
      return Number(a.item?.id ?? 0) - Number(b.item?.id ?? 0);
    });
}
