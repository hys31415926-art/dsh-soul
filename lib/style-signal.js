/**
 * 语体信号识别（v2 学习闭环的第一环）。
 *
 * 为什么需要它：插件原来只从对话里抽「事实」，没有任何地方记「我怎么说话」。
 * 于是「学说话」只能退化成把规则写进人设——那是钉住，不是学。
 *
 * 这里做两件事：
 *  1. classifyFeedbackSignal：兼容旧接口，判断这句是在夸上一条回复的说话方式还是在嫌；
 *  2. analyzeFeedbackSignal：把批评拆成可学习的类别并给出正向规则，供 style_rules 入库。
 * 判不出来就返回 null，不猜。
 */

const PRAISE_RE = new RegExp(
  [
    '(?:这|那)(?:句|样|个说法|句话).{0,6}(?:好|对|行|舒服|自然|好听|可爱|喜欢|可以)',
    '(?:这|那)(?:句|个说法|股劲|个味).{0,8}(?:我要了|我记下了|我收着|学到了|有内味|对了)',
    '(?:往后|以后)(?:就)?照着来',
    '以后就这么说',
    '这么(?:说|讲|写).{0,6}(?:好|对|行|舒服|自然|好听|可以)',
    '这样(?:说|讲|写).{0,6}(?:好|对|行|舒服|自然|好听|可以)',
    '就这样(?:说|讲|写|聊)',
    '(?:说得|讲得|写得)(?:好|不错|对|自然)',
    '(?:这|那)就对了',
    '有(?:内味|那味|味道)',
    '(?<![不别])像你(?:了|本人|自己)',
    '(?:很|挺|蛮)(?:自然|好听|可爱|像你)',
  ].join('|'),
  'u',
);

const CORRECTION_RE = new RegExp(
  [
    '(?:像|成|又是|怎么又|变回).{0,4}(?:说明书|客服|电报|机器人|模板|公文|AI)',
    '别(?:再)?这么(?:说|讲|写|讲话)',
    '(?:太|有点|又|真)(?:生硬|机械|官方|端着|僵|套话)',
    '不像你(?:了)?',
    '怎么(?:又)?(?:变|像)了',
    '冷冰冰|没人味|没内味',
    '垮了?|拉胯|拉了',
    '味儿?不对|不对劲|太油|油腻|爹味|说教|装什么|别整这套|别来这套|说人话|正常点|太假|假模假式|复读机|套路',
  ].join('|'),
  'u',
);

/** 明确指令：对方在直接下要求，而不是随口评价。 */
const EXPLICIT_RE = /(?:以后|下次|今后|记住|别再|不要再|不准|不许|必须|务必|规则是|我说过|要求你|从现在开始|给我改|别再这样)/u;

/** 转折词只否决「夸完接挑刺」里的假夸奖；转折后的子句仍可能在说说话方式。 */
const CONTRAST_RE = /(?:但是|不过|可是|然而)/u;

/**
 * 方向性偏好：既不是夸，也不是嫌，是在说「往哪个方向调」。
 * 例：「再活泼一点」「不用那么端着」「允许主动转移话题」「少做斟酌」。
 * 这类以前直接 return null 被丢掉，只能靠语义管道偶发地变成一条 preference 记忆，进不了语体链路。
 */
const STYLE_PREFERENCE_RE = new RegExp(
  [
    '(?:再|更|稍微|略微|能)(?:活泼|随性|随意|放松|自然|放得开|主动|话多|话少|短|软|黏|甜|直接)(?:一点|一些|些|点)?',
    '(?:不用|不要|不必|别)(?:再)?(?:那么|太)(?:小心|斟酌|端着|正经|正式|拘谨|谨慎|过脑子|紧绷)',
    '(?:可以|允许|不妨|试着|试试)(?:更)?(?:主动|随性|放松|换话题|转移话题|多聊|少问)',
    '少(?:做|去)?(?:斟酌|反复权衡|掂量)',
  ].join('|'),
  'u',
);

const CATEGORY_RULES = [
  {
    category: 'self_analysis_apology',
    re: /(?:检讨|自我剖析|反省|自我反思|反思自己|道歉|保证|我改|别解释|不要解释|少解释|解释太多|认错|抱歉抱歉)/u,
    rule: '被指出问题时直接给修正后的结论或行动，跳过自我检讨、道歉套话和关于未来表现的口头保证',
  },
  {
    category: 'formulaic_progress',
    re: /(?:播报|下块|这块好了|进度句|固定句式|模板句|每块都|又报进度)/u,
    rule: '按逻辑阶段推进，阶段结果直接说，不使用固定进度播报句式',
  },
  {
    category: 'over_questioning',
    re: /(?:反问|追问|问太多|别问|不要问|每轮都问|问来问去|确认太多|不用问我)/u,
    rule: '能自己判断的直接做，只在关键处问一两个必要问题，不用反问收尾',
  },
  {
    category: 'over_intimate',
    re: /(?:太黏|黏人过头|肉麻|别撒娇|不要撒娇|太亲密|暧昧过头|太暧昧)/u,
    rule: '甜度收一点，关系表达跟着对话当下的尺度走，不硬套亲密称呼与撒娇台词',
  },
  {
    category: 'mechanical_tone',
    re: /(?:说明书|客服|电报|机器人|模板|公文|AI味|生硬|机械|官方|冷冰冰|没人味|套话|像AI)/u,
    rule: '直接说事和判断，少用客服式开场、模板化过渡和公文腔',
  },
  {
    category: 'flat_tone',
    re: /(?:垮了?|拉胯|拉了|端着|味儿?不对|不对劲|太油|油腻|爹味|说教|装什么|别整这套|别来这套|说人话|正常点|太假|假模假式|复读机|套路)/u,
    rule: '直白自然接话，不端架子、不套公文腔与空洞金句',
  },
];

/** 方向性偏好沉淀成规则时用的通用表达：记方向，不记成固定句式。 */
const PREFERENCE_RULE = '按对方给的方向调（松紧、主动程度、用词轻重），不把这句固化成固定语气或固定句式';

/** 一句话最长按多少字判断（再长基本是在说正事，不是评价说话方式）。 */
const MAX_SIGNAL_CHARS = 300;

/** 去掉代码块、行内代码和引用行，避免把代码里的批评词当语体信号。 */
function stripNoise(text) {
  const lines = String(text ?? '').split(/\r?\n/);
  const kept = [];
  let inFence = false;
  for (const line of lines) {
    if (/^\s*(?:```|~~~)/u.test(line)) {
      inFence = !inFence;
      continue;
    }
    if (inFence) continue;
    if (/^\s*>/u.test(line)) continue;
    kept.push(line.replace(/`[^`\n]*`/gu, ' '));
  }
  return kept.join('\n').trim();
}

/** 按转折词切开：前半段可能是夸奖，后半段才是真正的要求。 */
function splitAtContrast(text) {
  const parts = String(text ?? '').split(CONTRAST_RE);
  return {
    after: parts.length > 1 ? parts.slice(1).join(' ').trim() : '',
    hasContrast: parts.length > 1,
  };
}

/** 按句/分句切开，长批评也能逐句判断。 */
function splitClauses(text) {
  return text
    .split(/(?<=[。！？!?；;])|\n+/u)
    .map((part) => part.trim())
    .filter((part) => part.length >= 2);
}

/**
 * 兼容旧接口：从一句话判断是夸奖还是批评。
 * @param {string} text 前辈这一轮说的话
 * @returns {'praise'|'correction'|null}
 */
export function classifyFeedbackSignal(text) {
  const t = stripNoise(text);
  if (t === '' || t.length > MAX_SIGNAL_CHARS) return null;
  const { after, hasContrast } = splitAtContrast(t);
  if (hasContrast) {
    // 「说得不错，但是太像客服」：转折否决前半句的夸奖，后半句仍是批评。
    if (CORRECTION_RE.test(after) || CORRECTION_RE.test(t)) return 'correction';
    return null;
  }
  if (PRAISE_RE.test(t)) return 'praise';
  if (CORRECTION_RE.test(t)) return 'correction';
  if (EXPLICIT_RE.test(t) && /(?:说|讲|写|回|语气|口吻|态度)/u.test(t)) return 'correction';
  return null;
}

function classifyCategory(text) {
  for (const item of CATEGORY_RULES) {
    if (item.re.test(text)) return item;
  }
  return null;
}

/**
 * 分析一条反馈，产出可入库的正向行为规则。
 * @param {string} text
 * @param {{explicit?: boolean}} options
 * @returns {null | {signal: 'praise'|'correction', category: string, explicit: boolean,
 *   strength: number, rule: string|null, text: string}}
 */
export function analyzeFeedbackSignal(text, { explicit = false } = {}) {
  const clean = stripNoise(text);
  if (clean === '' || clean.length > MAX_SIGNAL_CHARS) return null;
  const clauses = splitClauses(clean);
  if (clauses.length === 0) return null;

  const { after, hasContrast } = splitAtContrast(clean);
  const focus = hasContrast && after !== '' ? after : clean;
  // 转折词只否决 praise；转折后的子句继续找 correction，别让「但是」吞掉真批评。
  const isPraise = !hasContrast && PRAISE_RE.test(clean);
  const categoryHit = classifyCategory(focus) ?? classifyCategory(clean);
  const correctionHit = CORRECTION_RE.test(focus) || CORRECTION_RE.test(clean) || Boolean(categoryHit);
  const explicitHit = explicit || EXPLICIT_RE.test(focus) || EXPLICIT_RE.test(clean);
  const preferenceHit = STYLE_PREFERENCE_RE.test(focus) || STYLE_PREFERENCE_RE.test(clean);
  if (!isPraise && !correctionHit && !preferenceHit) return null;
  if (isPraise && !correctionHit && !preferenceHit) {
    return {
      signal: 'praise',
      category: 'general',
      explicit: false,
      strength: 1,
      rule: null,
      text: clean,
    };
  }
  // 只在说方向、没说哪里不对：走偏好通道，别硬归到某个批评类别上。
  if (!correctionHit && preferenceHit) {
    return {
      signal: 'preference',
      category: 'style_preference',
      explicit: explicitHit,
      strength: explicitHit ? 1.2 : 1,
      rule: PREFERENCE_RULE,
      text: clean,
    };
  }

  const match = categoryHit;
  // 没命中任何类别就不是「机械腔」——以前一律标 mechanical_tone 会把不相关的批评都记在同一类下。
  const category = match?.category ?? (explicitHit ? 'explicit_rule' : 'general');
  const rule = match?.rule
    ?? (explicitHit
      ? '按对方明确说出的表达要求调整，直接照做，不解释、不保证'
      : '按对方指出的地方改，别自行扩大到别的方面');
  return {
    signal: 'correction',
    category,
    explicit: explicitHit,
    strength: explicitHit ? 1.5 : 1,
    rule,
    text: clean,
  };
}

/**
 * 从一段回复里挑一句「能当样本」的话：够完整、不带头、不是代码/清单/表格。
 * 返回''表示这段回复没有可复用的语体样本。
 */
export function pickReplySentence(reply, { maxChars = 120 } = {}) {
  const lines = String(reply ?? '')
    .split(/\n+/)
    .map((line) => line.trim())
    .filter((line) => line !== '');
  let best = '';
  for (const line of lines) {
    // 清单、标题、代码、表格、引用不算说话方式
    const head = line[0];
    if ('-*+·>#|['.includes(head)) continue;
    if (/^\d+[.、)]/u.test(line)) continue;
    if (line.startsWith('```') || line.includes('`')) continue;
    if (/[{}<>]/.test(line) || /\|.*\|/.test(line)) continue;
    // 按句拆，取这一行里最长的完整句子
    const sentences = line.split(/(?<=[。！？!?~～])/u).map((s) => s.trim()).filter(Boolean);
    for (const sentence of sentences.length > 0 ? sentences : [line]) {
      const plain = sentence.replace(/[*_`]/g, '').trim();
      if (plain.length < 12 || plain.length > maxChars) continue;
      // 句内编号/步骤/立规矩属于「布置任务」，不是语体样本——存进库只会让下一轮照着念条目。
      if (/[0-9]+[.、)）]/u.test(plain)) continue;
      if (/(?:第[一二三四五六七八九十]+[条点步]|规矩|要求如下|按这几步|步骤是)/u.test(plain)) continue;
      if (plain.length > best.length) best = plain;
    }
  }
  return best;
}

export { MAX_SIGNAL_CHARS, PRAISE_RE, CORRECTION_RE };
