/**
 * 输出防线：程序级禁用表达拦截。
 *
 * 规则集中在代码里，不把正则原文拼进 System Prompt；提示词里只用正向行为描述。
 * 只清洗代码块与行内代码之外的文本，避免误伤用户要求的代码内容。
 */

const CODE_SPAN_RE = /(```[\s\S]*?```|`[^`\n]*`)/g;

/** 内置禁用表达。key 用于统计，pattern/flags 只在代码内。 */
export const FORBIDDEN_PATTERNS = Object.freeze([
  {
    key: 'banned_phrase_shou_xia_le',
    label: '机械收尾套话',
    pattern: '收下了',
    flags: 'u',
  },
  {
    key: 'banned_promise_wo_gai',
    label: '自我检讨与口头保证',
    pattern: '(?:我保证以后|下次一定改|我以后注意|我先检讨|我反思一下|我保证不会)',
    flags: 'u',
  },
  {
    key: 'banned_progress_chant',
    label: '固定进度播报',
    pattern: '这块好了[，,]?\\s*下块(?:做什么|是什么)',
    flags: 'u',
  },
  {
    key: 'banned_query_narration',
    label: '查询过程旁白',
    pattern: '我查了一下',
    flags: 'u',
  },
  {
    key: 'banned_idle_promise',
    label: '跨会话后台值守承诺',
    pattern: '(?:我盯着|弄好了告诉你|我会盯着)',
    flags: 'u',
  },
]);

function compile(entry, index) {
  if (typeof entry === 'string') {
    return {
      key: `custom_${index}`,
      label: entry,
      re: new RegExp(entry.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'u'),
    };
  }
  if (!entry || typeof entry !== 'object') return null;
  const source = String(entry.pattern ?? entry.source ?? '');
  if (source === '') return null;
  try {
    return {
      key: String(entry.key ?? `custom_${index}`),
      label: String(entry.label ?? source),
      re: new RegExp(source, String(entry.flags ?? 'u')),
    };
  } catch {
    return null;
  }
}

/** 合入 config.forbiddenPatterns 的自定义规则（字符串或 {key,pattern,flags}）。 */
export function buildForbiddenRules(extra = []) {
  const rules = FORBIDDEN_PATTERNS.map((item, index) => compile(item, index)).filter(Boolean);
  if (Array.isArray(extra)) {
    extra.forEach((item, index) => {
      const rule = compile(item, index);
      if (rule) rules.push(rule);
    });
  }
  return rules;
}

const DEFAULT_RULES = buildForbiddenRules();

function tidy(text) {
  return text
    .replace(/[ \t]+([，。！？；：、])/gu, '$1')
    .replace(/[，、；]+\s*(?=[。！？!?]|$)/gu, '')
    .replace(/^[ \t]*[，、；]+/gmu, '')
    .replace(/([。！？!?])\1+/gu, '$1');
}

/**
 * 清洗助手输出。
 * @returns {{text: string, hits: Array<{key: string, label: string, match: string}>, changed: boolean}}
 */
export function sanitizeAssistantOutput(text, { rules, config } = {}) {
  const raw = String(text ?? '');
  if (raw === '') return { text: '', hits: [], changed: false };
  const active = Array.isArray(rules)
    ? rules
    : buildForbiddenRules(config?.forbiddenPatterns ?? []);
  const parts = raw.split(CODE_SPAN_RE);
  const hits = [];
  let changed = false;
  let output = '';
  for (let i = 0; i < parts.length; i += 1) {
    const part = parts[i];
    if (i % 2 === 1) {
      output += part;
      continue;
    }
    let segment = part;
    for (const rule of active) {
      segment = segment.replace(rule.re, (match) => {
        hits.push({ key: rule.key, label: rule.label, match });
        changed = true;
        return '';
      });
    }
    output += tidy(segment);
  }
  return { text: changed ? output.trim() : raw, hits, changed };
}

/** 只检测、不改写；用于样本入库与记忆抽取前的拒收判断。 */
export function findForbidden(text, rules = DEFAULT_RULES) {
  const raw = String(text ?? '');
  if (raw === '') return [];
  const hits = [];
  const parts = raw.split(CODE_SPAN_RE);
  for (let i = 0; i < parts.length; i += 2) {
    for (const rule of rules) {
      rule.re.lastIndex = 0;
      const match = rule.re.exec(parts[i]);
      if (match) hits.push({ key: rule.key, label: rule.label, match: match[0] });
    }
  }
  return hits;
}

export function isCleanText(text, rules = DEFAULT_RULES) {
  return findForbidden(text, rules).length === 0;
}

/** 把命中累加进 meta.guard_hits；结构 {total, byKey, lastAt, lastBy}。 */
export function recordGuardHits(store, hits, { now = Date.now(), logger } = {}) {
  if (!store || typeof store.metaGet !== 'function' || typeof store.metaSet !== 'function') return null;
  if (!Array.isArray(hits) || hits.length === 0) return null;
  let stats = { total: 0, byKey: {}, lastAt: 0, lastBy: [] };
  try {
    const previous = store.metaGet('guard_hits');
    if (previous) stats = { ...stats, ...JSON.parse(String(previous)) };
  } catch (error) {
    logger?.warn?.(`guard_hits 读取失败：${error instanceof Error ? error.message : String(error)}`);
  }
  for (const hit of hits) {
    stats.total += 1;
    stats.byKey[hit.key] = (stats.byKey[hit.key] ?? 0) + 1;
  }
  stats.lastAt = now;
  stats.lastBy = [...new Set(hits.map((hit) => hit.key))];
  try {
    store.metaSet('guard_hits', JSON.stringify(stats));
  } catch (error) {
    logger?.warn?.(`guard_hits 写入失败：${error instanceof Error ? error.message : String(error)}`);
  }
  return stats;
}
