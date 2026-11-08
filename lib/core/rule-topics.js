/**
 * 规则主题：注入时按「这条规矩在管哪件事」去重。
 *
 * 实测库里同时 active 的三条 chat 规则——
 *   34 flat_tone          「说话活泼随性，直接表达真实感受，不反复掂量对方想法」
 *   35 general            「直接说出自己的态度和情绪，不先揣测对方会怎么想、不反复权衡后再开口」
 *   39 self_analysis_apology「直接表达喜欢或烦，不自我反省、不检讨自己有什么问题」
 * 字面相似度只有 0.2，任何 based-on-bigram 的合并都不会动它们；但它们说的是同一件事的三个侧面。
 * 三条一起注入，读起来就是「被同一条要求反复按住」。
 *
 * 这里不删数据、不改状态，只在注入时按主题留一条（证据多的优先）。
 * 主题判不出来就各留各的——宁可有两条，也不硬归到一类。
 */

const TOPIC_PATTERNS = [
  // 顺序有意义：「提问时直接给出可选项」核心是提问方式，不能因为带「直接」就被归到表达直接。
  ['questioning', /提问|追问|反问|确认|选项|开放式/u],
  ['catchphrase', /口头禅|服了|认输|算了|行吧/u],
  ['mechanical', /客服|说明书|人机|模板|套话|解释|分析|排版|条目|小标题/u],
  ['sweetness', /口癖|语气词|波浪号|卖萌|可爱|撒娇|亲昵|讨好/u],
  ['directness', /直接|表达|说出|讲出|坦诚|不揣测|不掂量|不反省|不检讨|不反复|态度|真实感受/u],
  ['length', /字数|长段|简短|别写太长|展开/u],
];

/** 判断一条规则在管哪件事。判不出来返回空串（不硬归）。 */
export function ruleTopic(norm) {
  const text = String(norm ?? '');
  if (text === '') return '';
  for (const [topic, pattern] of TOPIC_PATTERNS) {
    if (pattern.test(text)) return topic;
  }
  return '';
}

/**
 * 按主题去重：同一主题只留证据最多的一条（证据相同留 id 大的，即较新的）。
 * 主题为空的不参与去重，全部保留。
 * @param {Array<{id?: number, norm?: string, evidence_count?: number, updated_at?: number}>} rules
 * @returns {Array} 去重后的规则（保持原顺序中首次出现的位置）
 */
export function dedupeRulesByTopic(rules) {
  const list = Array.isArray(rules) ? rules : [];
  const best = new Map();
  for (const rule of list) {
    const topic = ruleTopic(rule?.norm);
    if (topic === '') continue;
    const current = best.get(topic);
    if (!current || better(rule, current)) best.set(topic, rule);
  }
  const out = [];
  const emittedTopics = new Set();
  for (const rule of list) {
    const topic = ruleTopic(rule?.norm);
    if (topic === '') { out.push(rule); continue; }
    if (emittedTopics.has(topic)) continue;
    emittedTopics.add(topic);
    out.push(best.get(topic) ?? rule);
  }
  return out;
}

function better(candidate, current) {
  const left = Number(candidate?.evidence_count ?? 0);
  const right = Number(current?.evidence_count ?? 0);
  if (left !== right) return left > right;
  return Number(candidate?.id ?? 0) > Number(current?.id ?? 0);
}
