/**
 * continuity — 关系连续性：把「称呼、语气尺度、边界、共同梗」这类被用户真实确认过的
 * 关系事实落到关系表 + 关系记忆里。
 *
 * 刻意不做的事：
 *   · 不做好感度/亲密度数值——关系状态只由真实发生过的互动事实构成；
 *   · 不推断未经确认的关系阶段——只在用户明确说「叫我/叫你/以后别…/我们的梗是…」时更新；
 *   · 覆盖式更新只发生在确有变化时，避免每轮重复写记忆把命中次数刷高。
 */
import { clip } from '../util.js';
import { detectRelationship } from '../memory/extract.js';

/** 把用「；」分隔的旧值列表与新值合并，去重、限长。 */
function mergeList(existing, additions, max = 8) {
  const parts = [];
  const push = (value) => {
    const text = clip(String(value ?? '').replace(/[；;、,，\s]+$/u, '').trim(), 80);
    if (text !== '' && !parts.includes(text)) parts.push(text);
  };
  for (const value of String(existing ?? '').split(/[；;]/u)) push(value);
  for (const value of additions) push(value);
  return parts.slice(-max).join('；');
}

function sameText(a, b) {
  return String(a ?? '').trim() === String(b ?? '').trim();
}

/**
 * 识别并保存一句话里的关系设定信号。
 * @param {object} store
 * @param {{sessionId?: string, text: string, source?: string}} input
 * @returns {string[]} 本次真正发生更新的关系事实（用于日志/复盘）
 */
export function applyRelationshipSignals(store, { sessionId = '', text, source = 'auto' } = {}) {
  const signals = detectRelationship(text);
  const rel = store.getRelation() ?? store.ensureRelation();
  const patch = {};
  const applied = [];

  if (signals.userAlias !== '' && !sameText(signals.userAlias, rel?.userAlias)) {
    patch.user_alias = clip(signals.userAlias, 20);
  }
  if (signals.agentAlias !== '' && !sameText(signals.agentAlias, rel?.agentAlias)) {
    patch.agent_alias = clip(signals.agentAlias, 20);
  }
  if (signals.tone !== '' && !sameText(signals.tone, rel?.tone)) {
    patch.tone = clip(signals.tone, 60);
  }
  if (signals.boundaries.length > 0) {
    const merged = mergeList(rel?.boundaries, signals.boundaries);
    if (!sameText(merged, rel?.boundaries)) patch.boundaries = merged;
  }
  if (signals.sharedTerms.length > 0) {
    const merged = mergeList(rel?.sharedTerms, signals.sharedTerms);
    if (!sameText(merged, rel?.sharedTerms)) patch.shared_terms = merged;
  }
  if (Object.keys(patch).length === 0) return [];

  store.setRelation(patch);
  const source2 = source === 'user-explicit' ? 'user-explicit' : 'auto';

  const remember = (type, content, confidence) => {
    try {
      store.rememberMemory({ type, content, source: source2, confidence, sessionId: sessionId || undefined, reason: 'relationship signal' });
    } catch { /* 关系表已更新；记忆写失败不影响主流程 */ }
  };
  if (patch.user_alias) {
    const line = `约定称呼：我叫用户「${patch.user_alias}」`;
    remember('relationship', line, 0.85);
    applied.push(line);
  }
  if (patch.agent_alias) {
    const line = `约定称呼：用户叫我「${patch.agent_alias}」`;
    remember('relationship', line, 0.85);
    applied.push(line);
  }
  if (patch.tone) {
    const line = `关系表达尺度：${patch.tone}`;
    remember('relationship', line, 0.8);
    applied.push(line);
  }
  if (patch.boundaries) {
    const line = `关系边界：${clip(patch.boundaries, 80)}`;
    remember('interaction', line, 0.85);
    applied.push(line);
  }
  if (patch.shared_terms) {
    const line = `共同的梗/约定：${clip(patch.shared_terms, 80)}`;
    remember('relationship', line, 0.8);
    applied.push(line);
  }
  return applied;
}

/** 关系快照的一行文字（日志/调试用）。 */
export function relationLine(rel) {
  if (!rel) return '（关系表为空）';
  const bits = [];
  if (rel.userAlias) bits.push(`用户称呼「${rel.userAlias}」`);
  if (rel.agentAlias) bits.push(`我叫「${rel.agentAlias}」`);
  if (rel.tone) bits.push(`尺度：${clip(rel.tone, 40)}`);
  if (rel.boundaries) bits.push(`边界：${clip(rel.boundaries, 60)}`);
  if (rel.sharedTerms) bits.push(`梗：${clip(rel.sharedTerms, 60)}`);
  return bits.length > 0 ? bits.join('；') : '（还没有确认过的关系设定）';
}
