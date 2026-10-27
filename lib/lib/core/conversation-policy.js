/**
 * conversation-policy — 判断「这一轮是什么类型的对话」，供上下文注入取舍使用。
 *
 * 目的不是给对话贴标签本身，而是决定这一轮要不要把项目档案、旧记忆、关系回忆调出来：
 * 闲聊几秒钟能回的话，不该被档案塞满；工作/讨论/恢复项目时才值得调出相关资料。
 *
 * 纯启发式：正则 + 局部字符 bigram 重叠，不调模型、不读写数据库、无网络。
 * 所有导出都是纯函数，便于单元测试。
 */

/** 常见闲聊/问候/寒暄，命中后按「轻对话」处理。 */
const CASUAL_PATTERNS = [
  /^在吗[？?。！!~～\s]*$/u,
  /^(哈+|嘿+|嘿嘿|嗯+|哦+|噢+|好+|早|早上好|早安|晚安|午安|下午好|晚上好|你好|hi|hello|yo)[！!。~～\s]*$/iu,
  /^(你|你那边)?(在干嘛|在忙吗|忙吗|吃了吗|吃没|睡了吗|醒了吗|干嘛呢)[？?。！!~～\s]*$/u,
  /(困了|睡觉|睡吧|晚安|早安|起床|赖床|午睡)/u,
  /(无聊|随便聊|聊聊天|聊聊|说说话|陪我|陪你|逗你|找你说说话)/u,
  /(哈哈|笑死|乐死|太好笑|绷不住|好家伙)/u,
  /^(今天|昨天|明天|最近)(天气|心情|状态)/u,
  /^(好的|行|可以|收到|ok|OK|嗯嗯|没问题)[！!。~～\s]*$/u,
];

/** 明确拒绝工作/项目话题：即使出现「工作/项目」字样也按闲聊处理。 */
const REFUSE_WORK_RE = /(不想|不聊|不要|别提|别说|不谈|先不|暂时不|算了).{0,8}(工作|项目|代码|任务|进度)/u;
const WORK_RE = /(帮(我|忙)|改(一下|下|改)|修(一下|下)?|写(一下|下|个|个文档)|跑(一下|个|测试)|部署|提交|代码|文件|目录|脚本|命令|数据库|项目|进度|待办|任务|实现|调试|测试|重构|README|接口|依赖|bug|报错|日志)/iu;
const DISCUSSION_RE = /(你觉得|你怎么看|值不值得|要不要|该不该|方案|建议|为什么|比较一下|区别|权衡|选择哪个|怎么选|值不值|靠不靠谱)/u;
const RESUME_RE = /(继续|接着|上次|之前那|之前说|恢复|做到哪|接着做)/u;
const EMOTION_RE = /(烦|累|难受|压力|焦虑|崩溃|哭|委屈|不开心|郁闷|失眠|睡不着|好丧|心累|被(领导|老板|老师|同事|朋友|家人)(说|骂|批|怼))|心情(不好|差)/u;
const FLIRT_RE = /(想你|想我|抱抱|亲亲|亲我|喜欢(你|我)|爱我|想见|撒娇|可爱|宝贝|亲爱的|乖|贴贴|心动|暧昧|夸我)/u;
const TEST_RE = /(测试(一下)?(你|对话|效果)|你是不是(在)?(考|测试)|考核|证明你|证明自己|有性格|演我|表演|你是(不是)?(AI|机器人|模型)|有没有真感情|人格真实性)/iu;
const MEMORY_ASK_RE = /(记得|记不记得|上次|之前|曾经|回忆|聊到哪)/u;
/** 用户在对「说话方式」提意见：要的是自然反应，不是背景资料或整改方案。 */
const FEEDBACK_RE = /(你(的)?(说话|回答|回复|表达|语气|口吻|句式|格式|风格|腔调)|(说话|回答|回复|表达|语气|口吻|句式|格式|风格|腔调).{0,8}(固定|模板|套话|公式|人机|客服|说明书|AI|机械)|说明书|人机|客服腔|模板腔|背台词|念台词|像(客服|人机|机器人)|别(再)?(这么|这样)说话|不要这样讲话|又(来|在|是)(说|解释|分析|讲))/iu;

/**
 * 判断这一轮对话的类型。
 * @param {string} text 用户这一轮说的话
 * @param {{mode?: string, openQuestion?: string}} state 会话状态（mode 可由 /soul session 设置）
 * @returns {{kind: string, light: boolean, work: boolean, discussion: boolean, resume: boolean,
 *   emotional: boolean, flirt: boolean, test: boolean, memoryAsk: boolean, refuseWork: boolean}}
 */
export function classifyTurn(text, state = {}) {
  const raw = String(text ?? '').trim();
  const t = normalize(raw);
  const mode = String(state?.mode ?? '');

  const flags = {
    work: false, discussion: false, resume: false, emotional: false,
    flirt: false, test: false, memoryAsk: false, refuseWork: false, feedback: false,
  };

  if (t === '') return build('unknown', flags);

  if (REFUSE_WORK_RE.test(t)) {
    flags.refuseWork = true;
    return build('casual', flags);
  }
  if (TEST_RE.test(t)) {
    flags.test = true;
    return build('test', flags);
  }
  if (WORK_RE.test(t)) {
    flags.work = true;
    return build('work', flags);
  }
  if (DISCUSSION_RE.test(t)) {
    flags.discussion = true;
    return build('discussion', flags);
  }
  if (MEMORY_ASK_RE.test(t)) {
    flags.memoryAsk = true;
    return build('memory-ask', flags);
  }
  if (RESUME_RE.test(t)) {
    flags.resume = true;
    return build('resume', flags);
  }
  if (EMOTION_RE.test(t)) {
    flags.emotional = true;
    return build('emotional', flags);
  }
  if (FLIRT_RE.test(t)) {
    flags.flirt = true;
    return build('flirt', flags);
  }
  if (FEEDBACK_RE.test(t)) {
    flags.feedback = true;
    return build('feedback', flags);
  }
  if (CASUAL_PATTERNS.some((pattern) => pattern.test(t)) || t.length <= 12) {
    return build('casual', flags);
  }
  if (mode === 'work') {
    flags.work = true;
    return build('work', flags);
  }
  return build('chat', flags);
}

/** 这一轮问句/发言是否「有实质内容」：短问候、纯语气词不算。 */
export function hasSubstantiveQuery(text) {
  const t = normalize(text);
  if (t.length < 6) return false;
  if (t.length < 10 && CASUAL_PATTERNS.some((pattern) => pattern.test(t))) return false;
  return true;
}

/**
 * 当前项目与这句话的相关度：项目名、目标/待办与这句话是否有词重叠、是否是工作型请求。
 * 只因为「项目处于 active 状态」不算相关 —— 这是 v0.3 要修的核心问题。
 * @param {string} text
 * @param {{project?: object, byKind?: object}} snapshot store.projectSnapshot() 的返回值
 * @param {object} state
 * @param {{threshold?: number}} options
 * @returns {{relevant: boolean, score: number, reasons: string[]}}
 */
export function projectRelevance(text, snapshot, state = {}, options = {}) {
  const project = snapshot?.project ?? snapshot;
  if (!project) return { relevant: false, score: 0, reasons: [] };
  const raw = String(text ?? '');
  const t = normalize(raw);
  const intent = classifyTurn(raw, state);
  const reasons = [];
  let score = 0;

  const name = String(project.name ?? '').trim();
  if (name !== '') {
    if (t.includes(normalize(name))) {
      score += 0.95;
      reasons.push('提到项目名');
    } else {
      const parts = name.split(/[-_\s]+/u).map((part) => normalize(part)).filter((part) => part.length >= 2);
      if (parts.some((part) => t.includes(part))) {
        score += 0.35;
        reasons.push('提到项目名片段');
      }
    }
  }

  if (intent.refuseWork) score -= 0.5;
  if (intent.kind === 'work') { score += 0.4; reasons.push('工作型请求'); }
  else if (intent.kind === 'resume') { score += 0.5; reasons.push('恢复/继续话题'); }
  else if (intent.kind === 'discussion') { score += 0.2; }
  else if (intent.kind === 'memory-ask') { score += 0.15; }
  // 「这个项目/进度/待办」这类泛指也算明确指向当前项目，否则工作请求会被过度拦掉。
  if (intent.kind === 'work' && /(项目|进度|待办|任务)/u.test(t)) {
    score += 0.2;
    reasons.push('提到项目/进度');
  }
  if (String(state?.mode ?? '') === 'work') { score += 0.2; reasons.push('会话处于工作模式'); }

  const corpus = [
    project.goal,
    project.stage,
    ...((snapshot?.byKind?.todo ?? []).slice(0, 6).map((item) => item.content)),
    ...((snapshot?.byKind?.blocker ?? []).slice(0, 3).map((item) => item.content)),
  ].filter(Boolean).join(' ');
  if (corpus !== '') {
    const overlap = containmentScore(raw, corpus);
    if (overlap >= 0.2) {
      score += Math.min(0.45, overlap * 0.8);
      reasons.push(`内容相关 ${overlap.toFixed(2)}`);
    }
  }

  const threshold = Number(options?.threshold ?? 0.55);
  return { relevant: score >= threshold, score, reasons };
}

/** 会话里留的 openQuestion 是否与这句相关（决定要不要注入）。 */
export function shouldIncludeOpenQuestion(intent, text, state) {
  const question = String(state?.openQuestion ?? '');
  if (question === '') return false;
  if (intent.kind === 'work' || intent.kind === 'discussion' || intent.kind === 'resume') return true;
  return containmentScore(String(text ?? ''), question) >= 0.2;
}

/** 规范化：小写、去空白和标点符号。 */
export function normalize(text) {
  return String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
}

/** 字符 bigram 重叠率：交集 / 较短文本的 bigram 数（用于短句 vs 较长语料）。 */
export function containmentScore(a, b) {
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  return intersection / Math.min(left.size, right.size);
}

function bigrams(text) {
  const normalized = normalize(text);
  const out = new Set();
  for (let index = 0; index < normalized.length - 1; index += 1) {
    out.add(normalized.slice(index, index + 2));
  }
  return out;
}

function build(kind, flags) {
  const light = kind === 'casual' || kind === 'chat' || kind === 'flirt' || kind === 'test'
    || kind === 'memory-ask' || kind === 'feedback';
  return { kind, light, ...flags };
}

/**
 * v0.8.0：工作与常态合并——不再按意图分档给「回复方式」。
 *
 * 以前这里按讨论/情绪/回忆/暧昧各发一条格式指令，结果「先给结论，再补两条理由」
 * 这种工作指令会盖过人格，让每句话都变成报告。现在统一交给判断：这一轮怎么回、
 * 说几句、要不要给下一步，由当场判断决定，不再由意图标签下格式。
 * 只保留一条硬线（工作内容原样）——它写在 persona 里，不在这里重复。
 */
export function buildStyleHint(intent, text = '', state = {}) {
  return '';
}
