/**
 * dsh-soul extract — 从对话里「筛」出值得长期保留的信息。
 *
 * 这不是 LLM 抽取，而是保守的规则抽取 + 去噪：
 *   · 只记长期有效、未来真的会用到的内容（偏好、画像、决定、项目节点、交互偏好、关系事实）；
 *   · 问句、一次性情绪、玩笑、临时状态默认不落地；
 *   · 命中疑似密钥直接放弃（不写记忆、不进日志）。
 *
 * 为什么不用第二个模型来抽取：每轮多一次模型调用既贵又慢，而「哪些话值得记」
 * 的绝大多数信号在措辞里（「记住」「以后都」「我喜欢」…）。复杂语义由主模型
 * 通过 soul_remember 工具主动写入，是更可靠的补充路径。
 */
import { clip, isQuestion, looksSecret, normText } from '../util.js';

/** 一次性情绪 / 临时状态：默认不沉淀为长期记忆。 */
const TRANSIENT_PATTERNS = [
  /^(?:今天|刚才|刚刚|现在|目前|这会儿)/,
  /(?:好累|好困|好饿|好烦|好难受|有点累|有点困|有点烦|爽|郁闷|无聊|emo|崩溃)/i,
  /(?:哈哈|哈哈哈|笑死|233|草|awsl)/,
];

/** 明确的记忆指令。 */
const REMEMBER_RE = /(?:请?(?:你)?(?:记住|记一下|记着|别忘了|帮我记住|记下来|记录一下|留个印象))[：:，,\s]*(.{2,140})/gu;

/** 明确的纠正。 */
const CORRECTION_RE = /(?:不对|不是这样|其实不是|纠正一下|我说错了|我纠正|改一下|准确地说|更正一下|不是[^。！？\n]{1,10}是)[：:，,\s]*(.{2,140})/gu;

/** 稳定偏好。 */
const PREFERENCE_RE = /我(?:其实|比较|很|超|最|特别|真|更|也|还是|一直)?(喜欢|爱|偏爱|讨厌|不喜欢|受不了|习惯|不习惯|偏好|希望|想要|想让你|喜欢被)([^。！？\n；;]{2,60})/gu;

/** 用户画像（称呼/身份/环境）。 */
const PROFILE_RE = /我(?:叫|名字是|是|住在|来自|在做|正在做|的工作是|今年|本科|读|在[^。！？\n]{0,20}(?:工作|读书|住))/gu;

/** 明确决定。 */
const DECISION_RE = /(?:决定|定了|就这么定|说好了|以后都|以后就|从现在起|改成|换成|采用|就用|统一用|不再用)([^。！？\n；;]{2,80})/gu;

/** 项目进展信号。 */
const PROJECT_RE = /(?:项目|进度|推动|上线|部署|发布|修好|跑通|联调|重构|下一步|待办|阻塞|卡在|目标是|里程碑|需求|排期|这个项目|那个项目)([^。！？\n]{0,80})/gu;

/** 交互偏好信号（怎么被对待/怎么说话）。 */
const INTERACTION_RE = /(?:以后|下次|之后)?(?:别|不要|不用|少|多)(?:再)?(?:每次都|每次|总是|老是|一直)?(?:问我|解释|分析|总结|列(?:清单|任务)|叫我|喊我|说|用|重复|客套|废话|追问)[^。！？\n]{0,40}/gu;
const MANNER_RE = /(?:语气|说话方式|交流方式|沟通方式|风格|称呼|直接给结论|先给结论|别废话|少客套|不用铺垫|直接说)[^。！？\n]{0,50}/gu;

/** 关系事实信号。 */
const RELATION_RE = /(?:我们|咱们)(?:的)?(?:梗|暗号|约定|口号|称呼|昵称|回忆|第一次|那次)[^。！？\n]{0,60}/gu;

/** 长期目标/计划信号（长期有效，值得先做候选）。 */
const LONG_TERM_RE = /我(?:的)?(?:长期)?(?:目标|计划|打算|准备|希望)[^。！？\n；;]{2,60}/gu;

/** 稳定习惯信号（「我一般…」「我每周…」）。 */
const HABIT_RE = /我(?:一般|通常|平时|平常|每天|每周|每晚|早上|晚上|周末|习惯性)[^。！？\n；;]{2,60}/gu;

/** 多轮讨论后的共识/拍板信号。 */
const CONSENSUS_RE = /(?:那就|就)?(?:这么|这样)(?:定|办|做|来)了?|就按(?:你说的|这个|刚才说的)|照(?:你说的|这个)来|(?:我们|咱俩)(?:就)?(?:这么|这样)说定|达成(?:一致|共识)|(?:最终|最后)(?:决定|选)|说定了/u;

/** 临时性判断：命中则默认不写入（显式「记住」除外）。 */
export function isTransient(text) {
  const s = String(text ?? '').trim();
  if (s === '') return true;
  return TRANSIENT_PATTERNS.some((re) => re.test(s));
}

/** 清理抽出来的句子：去掉首尾空白与多余标点，限制长度。 */
function cleanSentence(text) {
  return clip(String(text ?? '')
    .replace(/^[：:，,、\s]+/u, '')
    .replace(/[。；;，,、\s]+$/u, ''), 140);
}

/** 类型猜测：把一句事实放进最合适的记忆类型。 */
export function guessMemoryType(content) {
  const c = String(content ?? '');
  if (/(喜欢|讨厌|受不了|习惯|偏好|希望|想要)/.test(c)) return 'preference';
  if (/(我叫|名字|住在|来自|在做|工作|读书|今年|身份)/.test(c)) return 'profile';
  if (/(决定|定了|以后都|改成|换成|采用|就用)/.test(c)) return 'episodic';
  if (/(项目|进度|上线|部署|需求|排期|待办|阻塞|代码|文件|重构)/.test(c)) return 'project';
  if (/(别|不要|直接|语气|称呼|叫我|喊我|废话|客套)/.test(c)) return 'interaction';
  if (/(我们|咱们|梗|暗号|约定|第一次)/.test(c)) return 'relationship';
  return 'fact';
}

/**
 * 从一条用户消息里抽取候选记忆。
 * @param {string} rawText
 * @returns {Array<{kind: 'memory'|'correction'|'project-note'|'relation'|'interaction',
 *                  type: string, content: string, tags: string, confidence: number, source: string}>}
 */
export function extractCandidates(rawText) {
  const text = String(rawText ?? '').trim();
  if (text.length < 4 || text.length > 3000) return [];
  if (looksSecret(text)) return [];
  const question = isQuestion(text);
  const transient = isTransient(text);
  const seen = new Set();
  const out = [];

  const add = (candidate) => {
    const content = cleanSentence(candidate.content);
    if (content.length < 3) return;
    const norm = normText(content);
    if (norm.length < 2 || seen.has(norm)) return;
    seen.add(norm);
    const source = candidate.source ?? 'auto';
    const kind = candidate.kind ?? 'memory';
    out.push({
      kind,
      type: candidate.type ?? guessMemoryType(content),
      content,
      tags: candidate.tags ?? '',
      confidence: candidate.confidence ?? 0.6,
      source,
      importance: scoreImportance(content, { source, kind }),
      status: candidate.status ?? (source === 'user-explicit' || source === 'user-correction' ? 'active' : 'candidate'),
    });
  };

  // 1) 显式「记住」：优先级最高，不受问句/临时情绪过滤影响。
  //    已有显式记忆时，同一句里的自动抽取全部跳过——用户的指令本身足够，
  //    再从同一句里抽偏好/项目信号只会制造重复条目。
  let explicitCount = 0;
  for (const match of text.matchAll(REMEMBER_RE)) {
    add({ kind: 'memory', content: match[1], tags: 'explicit', confidence: 0.92, source: 'user-explicit' });
    explicitCount += 1;
  }

  // 2) 明确纠正：交给上层去 supersede 旧记忆。
  for (const match of text.matchAll(CORRECTION_RE)) {
    add({ kind: 'correction', content: match[1], tags: 'correction', confidence: 0.85, source: 'user-correction' });
  }

  if (!transient && !question && explicitCount === 0) {
    // 3) 稳定偏好
    for (const match of text.matchAll(PREFERENCE_RE)) {
      add({ kind: 'memory', type: 'preference', content: `我${match[1]}${match[2]}`, confidence: 0.62 });
    }
    // 3b) 稳定习惯（「我一般…」「我每周…」）：长期有效，先做候选，重复出现再转正
    for (const match of text.matchAll(HABIT_RE)) {
      add({ kind: 'memory', type: 'preference', content: match[0], tags: 'habit', confidence: 0.6 });
    }
    // 3c) 长期目标/计划
    for (const match of text.matchAll(LONG_TERM_RE)) {
      add({ kind: 'memory', type: 'profile', content: match[0], tags: 'long-term-goal', confidence: 0.62 });
    }
    // 4) 画像
    for (const match of text.matchAll(PROFILE_RE)) {
      add({ kind: 'memory', type: 'profile', content: match[0], confidence: 0.68 });
    }
    // 5) 决定（既写长期记忆，也作为项目 decision 条目被 hooks 归档）
    for (const match of text.matchAll(DECISION_RE)) {
      add({ kind: 'decision', type: 'episodic', content: match[0], tags: 'decision', confidence: 0.66 });
    }
    // 6) 项目信号（由上层决定是否挂到当前项目）
    for (const match of text.matchAll(PROJECT_RE)) {
      add({ kind: 'project-note', type: 'project', content: match[0], confidence: 0.55 });
    }
    // 7) 交互偏好
    for (const match of text.matchAll(INTERACTION_RE)) {
      add({ kind: 'interaction', type: 'interaction', content: match[0], tags: 'interaction', confidence: 0.66 });
    }
    for (const match of text.matchAll(MANNER_RE)) {
      add({ kind: 'interaction', type: 'interaction', content: match[0], tags: 'interaction', confidence: 0.58 });
    }
    // 8) 关系事实
    for (const match of text.matchAll(RELATION_RE)) {
      add({ kind: 'relation', type: 'relationship', content: match[0], tags: 'relationship', confidence: 0.62 });
    }
  }

  return out;
}

/**
 * 从一句话里识别称呼、边界、语气的设定。
 * @returns {{userAlias: string, agentAlias: string, tone: string, boundaries: string[], sharedTerms: string[]}}
 */
export function detectRelationship(text) {
  const s = String(text ?? '');
  const out = { userAlias: '', agentAlias: '', tone: '', boundaries: [], sharedTerms: [] };

  /** 「别/不要…叫我X」是边界而不是称呼：跳过被否定的匹配。 */
  const isNegated = (index) => /(?:别|不要|不准|不许)\s*$/u.test(s.slice(Math.max(0, index - 4), index));

  const aliasOf = (verb) => {
    const re = new RegExp(
      "(?:以后|就|可以)?" + verb + "(?:为|做)?[「“\"'`]?([^\\s「」“”\"'`，。！？、；;:：]{1,12})",
      'gu',
    );
    for (const match of s.matchAll(re)) {
      const value = match[1].trim();
      if (isNegated(match.index)) continue;
      if (value.length >= 1 && !/^(什么|啥|名字|称呼)$/.test(value)) return value;
    }
    return '';
  };
  out.userAlias = aliasOf('叫我');
  out.agentAlias = aliasOf('叫你');

  // 边界：不喜欢/不要 与关系表达相关的约束
  const relational = /(叫|称呼|昵称|暧昧|撒娇|亲密|肉麻|撩|撩人|抱|亲|恋爱|关系)/;
  for (const match of s.matchAll(/(?:别|不要|不准|不许)(?:再)?([^。！？\n]{2,50})/gu)) {
    const segment = match[0];
    if (relational.test(segment)) out.boundaries.push(clip(segment, 60));
  }
  for (const match of s.matchAll(/我(?:不太)?(?:不喜欢|讨厌|受不了)([^。！？\n]{2,50})/gu)) {
    if (relational.test(match[0])) out.boundaries.push(clip(match[0], 60));
  }

  // 语气尺度
  if (/(?:可以|允许|随意)(?:更|再)?(?:亲密|暧昧|亲近|主动)(?:一点|一些|些)?/.test(s)) {
    out.tone = '允许更亲密/暧昧一些';
  }
  if (/(?:别|不要)(?:太|那么)?(?:亲密|暧昧|亲近|主动|肉麻)/.test(s)) {
    out.tone = '亲密表达保持克制';
  }

  // 共同梗/约定
  for (const match of s.matchAll(/(?:我们|咱们)(?:的)?(?:梗|暗号|约定|口号)(?:是|叫|：|:)?[「“"'`]?([^。！？\n；;]{2,40})/gu)) {
    const term = cleanSentence(match[1]);
    if (term.length >= 2) out.sharedTerms.push(term);
  }

  out.boundaries = [...new Set(out.boundaries)].slice(0, 5);
  out.sharedTerms = [...new Set(out.sharedTerms)].slice(0, 5);
  return out;
}

/** 把一段话归类成项目条目类型（用于当前项目的自动记录）。 */
export function classifyProjectNote(content) {
  const c = String(content ?? '');
  if (/(决定|定了|确定|采用|改成|换成|统一|以后都)/.test(c)) return 'decision';
  if (/(明天|下次|接下来|下一步|待办|要做|需要|计划|排期)/.test(c)) return 'todo';
  if (/(卡住|阻塞|问题|失败|报错|不行|bug|风险|担心)/i.test(c)) return 'issue';
  if (/(完成|做好了|修好|跑通|上线|发布|搞定|通过)/.test(c)) return 'done';
  return 'note';
}

/**
 * 从一句话里认出被明确提到的项目名（用于「开始/推进 X 这个项目」这类开场）。
 * 只认显式的「动词 + 名字 + 项目」结构，不做模糊联想，避免把普通名词当成项目。
 */
export function detectProjectName(rawText) {
  const s = String(rawText ?? '');
  const patterns = [
    /(?:推进|继续|开始|启动|开发|做|搞|维护|重构|接手)\s*[「“"']?([A-Za-z][\w.\-/]{1,40}|[\u4e00-\u9fa5A-Za-z0-9《》「」\-_]{2,20})[」”"']?\s*(?:这个|那个)?项目/gu,
    /(?:项目|工程)\s*[「“"']?([A-Za-z][\w.\-/]{1,40})[」”"']?/gu,
  ];
  for (const re of patterns) {
    for (const match of s.matchAll(re)) {
      const name = String(match[1] ?? '').replace(/^[《「“"']+|[》」”"']+$/g, '').trim();
      if (name.length >= 2 && !/^(这个|那个|一个|我们|咱们|自己)$/.test(name)) return name;
    }
  }
  return '';
}

/**
 * 记忆重要性（0-1）：决定检索排序与注入优先级，也决定低价值信息要不要先做「候选」。
 * 只做启发式打分，不追求精确——重要的是把「用户明确要求 / 纠正 / 决定」抬高，
 * 把「随口一句偏好」压低。
 */
export function scoreImportance(content, { source = 'auto', kind = 'memory' } = {}) {
  const s = String(content ?? '');
  let score = 0.45;
  if (source === 'user-explicit') score = 0.9;
  else if (source === 'user-correction') score = 0.85;
  else if (kind === 'decision') score = 0.72;
  else if (kind === 'relation' || kind === 'interaction') score = 0.66;
  else if (kind === 'project-note') score = 0.6;
  else if (kind === 'enhanced') score = 0.5;
  if (/(以后|永远|一直|长期|每次|约定|说好|记住|别忘)/.test(s)) score += 0.08;
  if (/(项目|决定|目标|截止|上线|发布|考研|部署)/.test(s)) score += 0.06;
  if (s.length < 8) score -= 0.05;
  return Math.min(0.95, Math.max(0.15, Number(score.toFixed(2))));
}

/** 「对，就是这样」「就这么办」——用户对刚才讨论内容的明确确认。 */
const CONFIRM_RE = /(?:就这么(?:定|办|做|来)|就按(?:这个|你说的|这样)|照(?:这个|你说的)来|同意(?:这个|你的)?(?:方案|建议|说法)?|没问题[，,]?\s*就(?:这样|这个|这么办)|对[，,]\s*就是这样|没错[，,]?\s*就(?:这样|这么办)|可以[，,]?\s*就(?:这样|这么办)|那就这么定了)/u;

/** 判断这句话是不是对前面内容的确认（用于把候选记忆转正）。 */
export function detectConfirmation(text) {
  return CONFIRM_RE.test(String(text ?? ''));
}

/**
 * 多轮讨论后的共识/拍板：只返回命中的标记词，是否值得记录由上层结合上下文判断
 * （比如会话里确实已经讨论过几轮、有活跃项目或未解决的问题）。
 */
export function detectConsensus(text) {
  const s = String(text ?? '').trim();
  if (s === '' || s.length > 80) return '';
  const match = s.match(CONSENSUS_RE);
  return match ? match[0] : '';
}

/**
 * 回合结束时的「增强抽取」（启发式，不调模型）：
 * 从助手的承诺/下一步和用户刚说过的话里，捞少量值得跟进的条目，先放进候选区，
 * 由「再次出现 / 用户确认 / 手动 approve」决定是否转正。
 */
export function enrichTurn({ userText = '', assistantText = '', maxItems = 2 } = {}) {
  const out = [];
  const seen = new Set();
  const push = (content) => {
    const text = cleanSentence(content);
    if (text.length < 6) return;
    const norm = normText(text);
    if (seen.has(norm)) return;
    seen.add(norm);
    out.push({
      kind: 'enhanced',
      type: guessMemoryType(text),
      content: text,
      tags: 'enhanced',
      confidence: 0.5,
      source: 'enhanced',
    });
  };
  for (const match of String(assistantText ?? '').matchAll(/(?:下一步|接下来|然后)(?:我|我们)?(?:会|可以|建议|需要|来)?([^。！？\n]{4,60})/gu)) {
    push(`下一步：${match[1]}`);
  }
  for (const match of String(userText ?? '').matchAll(/(?:说好|约定|就这么|以后都|统一)([^。！？\n]{2,60})/gu)) {
    push(`约定${match[1]}`);
  }
  return out.slice(0, Math.max(1, Number(maxItems) || 2));
}

/** 交互偏好 / 关系事实的标签整理。 */
export function tagForSource(source, type) {
  if (source === 'user-explicit') return 'explicit';
  if (source === 'user-correction') return 'correction';
  if (type === 'relationship') return 'relationship';
  if (type === 'interaction') return 'interaction';
  return 'auto';
}
