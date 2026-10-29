/**
 * dsh-soul render — 把记忆/项目/关系状态渲染成给模型看的短文本，或给用户看的状态文本。
 *
 * 两条硬规则：
 *   · 注入块是「每轮都付 token」的东西，所以有硬预算：超了就整行整段地丢，绝不半句截断；
 *   · 注入块里明确写「可能过时、以当前对话为准、不要复述本块」，避免模型把记忆当圣旨。
 */
import { clip, estimateTokens, formatAge, formatSpan, formatTime, normText, smartClip } from '../util.js';
import { buildQuery, planRetrieval, selectMemories, selectRelationshipMaterial, usageOf } from './retrieval.js';
import { buildStyleHint, classifyTurn, hasSubstantiveQuery, projectRelevance, shouldIncludeOpenQuestion } from '../core/conversation-policy.js';
import { sceneFallbacks, sceneOf } from '../core/scene.js';
import { styleSummaryOf } from './style.js';
import { markStyleAnchorsUsed, selectStyleAnchors } from './style-examples.js';
import { buildForbiddenRules, findForbidden } from '../output-guard.js';

/** 工作场景：语体样本按场景挑，避免把闲聊语气贴进干活回合。 */
const WORK_SCENES = new Set(['work', 'discussion', 'resume']);
import { evolve } from '../emotion.js';

const TYPE_LABELS = {
  preference: '偏好',
  profile: '画像',
  episodic: '经历',
  project: '项目',
  interaction: '相处',
  relationship: '关系',
  fact: '事实',
};

export function typeLabel(type) {
  return TYPE_LABELS[type] ?? String(type ?? '事实');
}

/**
 * 注入预算拆分：总预算 → 关系 / 项目 / 记忆。
 * 默认 2000 字符（约 1200 token）：够放下关系、一个项目的关键条目和 8 条记忆，
 * 又不至于每轮都在上下文里堆一整页。标题/结尾固定开销另留 180 字符。
 */
export function budgetPlan(config = {}) {
  const total = clampNumber(config.injectBudget, 300, 8000, 2000);
  const relation = Math.floor(total * 0.15);
  const project = config.projectInject === false ? 0 : Math.floor(total * 0.4);
  const memories = Math.max(160, total - relation - project - 180);
  return { total, relation, project, memories };
}

/**
 * 生成每轮注入的上下文块。
 *
 * v0.3 的取舍：先判断这一轮是什么类型的话，再决定注入多少——
 *   - 闲聊/问候/玩笑：关系语气保留，项目档案不注入，旧记忆不硬塞；
 *   - 工作/讨论/恢复项目：项目状态和相关记忆按相关度注入；
 *   - 项目是否注入不取决于「项目处于 active 状态」，而取决于当前这句话是否真的相关。
 *
 * @param {{store: any, config: object, sessionId: string, query?: string, queryVector?: Float32Array|null, logger?: any}} input
 * @returns {string} 空字符串表示这轮没什么值得注入的
 */
export function renderContextBlock(input) {
  const { store, config, sessionId } = input;
  const logger = input.logger;
  // v1.6 可观测：调用方可以传一个 report 收集器，函数把「这一轮为什么注入/没注入什么」
  // 写进去；返回值仍是字符串，老调用方不用改。
  const report = input && typeof input.report === 'object' && input.report !== null ? input.report : null;
  // dryRun：/soul plan 预览用。不改 meta['retrieval.last']、不记锚点使用，纯函数重算。
  const dryRun = input?.dryRun === true;
  const startedAt = Date.now();
  const degraded = [];
  const finish = (text, extra = {}) => {
    if (report) {
      const value = String(text ?? '');
      Object.assign(report, extra, {
        rendered: value.length > 0,
        chars: value.length,
        budgetUsed: value.length,
        degraded: degraded.join(','),
        ms: Date.now() - startedAt,
      });
    }
    return text;
  };
  const plan = budgetPlan(config);
  const rel = store.getRelation();
  const state = store.getSessionState(sessionId);
  const queryText = String(input.query ?? '') !== '' ? String(input.query) : String(state?.lastUserText ?? '');
  const intent = classifyTurn(queryText, state);
  const substantive = hasSubstantiveQuery(queryText);
  const styleHint = buildStyleHint(intent, queryText, state);
  const soulStyle = styleSummaryOf(store);
  const selfModel = String(store.metaGet('soul.selfModel') ?? '').trim();
  // v0.5.1：对话方式反馈回合不注入背景资料，但用最小行为提示压住「分析→认错→保证→反问」的惯性（不涉及任何个人偏好记忆）。
  if (intent.kind === 'feedback') {
    logger?.debug?.('本轮是对话方式反馈，只给最小行为提示、不注入背景');
    if (report) {
      report.intent = intent.kind;
      report.skipped = true;
      report.skipReason = '反馈回合：只给最小行为提示，不注入背景';
    }
    degraded.push('feedbackOnly');
    return finish([
      '【当前这轮：前辈在说你的说话方式本身】',
      '先接住这句话（最多一句），然后直接继续正常内容。',
      '不解释原因、不自我剖析、不作口头保证、不反问确认；直接给修正后的说法或下一步。',
    ].join('\n'));
  }
  // v1.5 检索路由：默认只按当前消息检索——把旧话题、未决问题拼进检索词最容易答非所问。
  const retrievalPlan = planRetrieval({ text: queryText, intent, state, config });
  const query = retrievalPlan.query;
  if (report) {
    report.intent = intent.kind;
    report.mode = retrievalPlan.mode;
    report.windowDays = retrievalPlan.windowDays;
    report.types = retrievalPlan.types ?? [];
    report.includeSuperseded = retrievalPlan.includeSuperseded === true;
    report.queryChars = query.length;
    report.budget = { total: plan.total, relation: plan.relation, project: plan.project, memories: plan.memories };
  }
  // 跨会话接话：距上一条消息够久，就把「上次最后几轮原话」接回来。
  // 刚聊完不注入（上下文里本来就有），避免同一段话被说两遍。
  const recapText = renderRecapLines(store, config);
  // v1.3 情绪：只在有情绪时注入一行（中性不占预算），给模型调语气用。
  const emotionText = renderEmotionLine(store, config);
  // v0.7 主动性：注入「我上次猜错/还没验证过的判断」作为素材，而不是注入「你该主动关心」的指令。
  // 用不用、怎么用由模型当场判断；纯闲聊且无实质内容时不占预算。
  const judgmentText = config.judgmentInject === false ? '' : renderJudgmentLines(store, { intent, substantive });
  const judgmentBudget = judgmentText === '' ? 0 : 200;
  const project = state?.activeProjectId ? store.projectSnapshot(state.activeProjectId) : null;
  const projectGate = project !== null && config.projectInject !== false
    ? (config.projectInjectRelevance === false
      ? { relevant: true, score: 1, reasons: ['配置强制注入'] }
      : projectRelevance(queryText, project, state))
    : { relevant: false, score: 0, reasons: [] };
  const includeQuestion = shouldIncludeOpenQuestion(intent, queryText, state);
  const memoryEnabled = config.inject === true || config.inject === undefined;
  // v2：记忆改成事件驱动。同一会话里刚聊完、不是在干活、也没让「回忆」时，不检索。
  // 这一条是为稳定性服务的：每次挑不同的记忆，注入块文本就每轮都变，宿主无法去重，
  // 历史里会堆满互相矛盾的旧快照。
  const gapMinutes = clampNumber(config.memoryGapMinutes, 1, 720, 30);
  const recentSameSession = Number(state?.updatedAt ?? 0) > 0 && Date.now() - Number(state.updatedAt) < gapMinutes * 60_000;
  const recallAsk = /(还记得|记不记得|我说过|跟你说过|上次|之前|以前|那天|那时候|当时)/.test(queryText);
  const memoryWanted = intent.memoryAsk === true || recallAsk || WORK_SCENES.has(intent.kind) || !recentSameSession || substantive;
  const memorySelection = memoryEnabled && memoryWanted && !(intent.light && !substantive)
    ? selectMemories(store, {
      query,
      limit: clampNumber(config.memoryInjectCount, 1, 16, 8),
      budgetChars: Math.max(140, plan.memories - judgmentBudget),
      projectId: projectGate.relevant ? (state?.activeProjectId ?? 0) : 0,
      queryVector: input.queryVector ?? null,
      sessionId,
      mode: retrievalPlan.mode,
      sinceDays: retrievalPlan.windowDays,
      types: retrievalPlan.types,
      includeSuperseded: retrievalPlan.includeSuperseded,
      semanticMin: config.embeddingThreshold,
    })
    : { memories: [], chars: 0, path: 'none', cache: 'off', filtered: {} };
  // v1.6 诊断：选中了什么、哪些是因为什么被淘汰的、渲染时又裁掉了哪几条。
  const renderBudget = { shownIds: [], droppedIds: [] };
  if (report) {
    report.memoryEnabled = memoryEnabled;
    report.memoryWanted = memoryWanted;
    report.path = memorySelection.path ?? 'none';
    report.cache = memorySelection.cache ?? 'off';
    report.considered = Number(memorySelection.considered ?? (memorySelection.memories?.length ?? 0));
    report.filtered = memorySelection.filtered ?? {};
    report.excluded = Array.isArray(memorySelection.excluded) ? memorySelection.excluded.slice(0, 60) : [];
    report.overBudgetIds = Array.isArray(memorySelection.overBudgetIds) ? memorySelection.overBudgetIds : [];
    report.injectedIds = (memorySelection.memories ?? []).map((memory) => Number(memory.id));
  }
  const relationMemories = config.relationMemory === false ? [] : selectRelationshipMaterial(store, 4);
  const turns = Number(rel?.turns ?? 0);
  const sessions = store.sessionCount();

  const relationText = config.relationMemory === false
    ? ''
    : renderRelationLines({ rel, relationMemories, plan, turns, intent, substantive });
  const projectText = projectGate.relevant ? renderProjectLines(project, plan.project) : '';
  // v1.5 可观测：这一轮按什么路径检索、命中还是重算、哪些被过滤掉了。
  // 跳过检索也记一笔——否则 /soul why 看不出「这轮为什么什么都没注入」。
  const retrievalSkipped = memorySelection.cache === 'off';
  // 跳过也要能解释清楚：是配置关了、是事件驱动不检索、还是轻闲聊。
  const skipReason = !memoryEnabled
    ? '配置关闭注入'
    : (!memoryWanted ? '事件驱动：刚聊完且无实质内容' : (intent.light && !substantive ? '轻闲聊' : ''));
  if (report) {
    report.skipped = retrievalSkipped;
    report.skipReason = retrievalSkipped ? (skipReason || '不检索') : '';
  }
  if (retrievalSkipped) {
    if (!dryRun) store.metaSet?.('retrieval.last', `模式 ${retrievalPlan.mode}｜这一轮不检索（轻闲聊或刚聊完且无实质内容）`);
    logger?.debug?.('记忆检索：这一轮不检索（轻闲聊或刚聊完且无实质内容）');
  } else {
    const reasons = retrievalPlan.reasons.length > 0 ? '；' + retrievalPlan.reasons.join('、') : '';
    const dropped = Object.entries(memorySelection.filtered ?? {})
      .filter(([, count]) => count > 0)
      .map(([key, count]) => key + '=' + count)
      .join(' ');
    const path = memorySelection.path ?? 'none';
    const cache = memorySelection.cache ?? 'miss';
    const size = `${memorySelection.memories.length} 条 ${memorySelection.chars ?? 0} 字`;
    if (!dryRun) store.metaSet?.('retrieval.last', `模式 ${retrievalPlan.mode}｜路径 ${path}｜缓存 ${cache}｜${size}｜${retrievalPlan.reasons.join('；') || '默认按当前消息'}`);
    logger?.debug?.(`记忆检索：模式 ${retrievalPlan.mode}、路径 ${path}、缓存 ${cache}、${size}${reasons}${dropped === '' ? '' : '；过滤 ' + dropped}`);
  }
  const memText = memorySelection.memories.length > 0
    ? renderInjectedMemories(memorySelection.memories, plan.memories, renderBudget)
    : '';
  // 选中了却在渲染预算里被裁掉的，也要留下 ID 和原因（第三类淘汰）。
  if (report) {
    report.renderedIds = renderBudget.shownIds.slice();
    const droppedByRender = renderBudget.droppedIds.filter((id) => !renderBudget.shownIds.includes(id));
    if (droppedByRender.length > 0) {
      report.excluded = [...report.excluded, ...droppedByRender.slice(0, 40).map((id) => ({ id, reason: 'renderBudget' }))];
      degraded.push('memoriesTrimmedAtRender');
    }
  }

  // v2 语体锚：贴两条「我真实说过、被前辈夸过」的原句。
  // 位置在注入块内、跟着最新快照走；不写规则、不解释，避免又变成一段指令。
  const scene = sceneOf(intent.kind);
  const sceneExtra = sceneFallbacks(scene);
  const guardRules = buildForbiddenRules(config?.forbiddenPatterns ?? []);
  // P1：只注入 active 规则；candidate/superseded/disabled 一律不出现。
  // 只贴 3 条：同一场景里常有多条「换句话说的同一条反馈」，全贴出来就是在同一件事上被念四遍。
  const activeRules = config.styleRuleInject === false || typeof store.activeStyleRules !== 'function'
    ? []
    : store.activeStyleRules({ scene, limit: 3, fallbackScenes: sceneExtra }).filter((rule) => findForbidden(rule.rule, guardRules).length === 0);
  const rulesText = activeRules.length === 0
    ? ''
    : truncateSection(['【这轮先这样做（之前反馈沉淀的规则，不是台词）】', ...activeRules.map((rule) => `- ${rule.rule}`)], 220);
  // P4：严肃排障/要求收敛时减少或跳过撒娇锚点，避免语气压过正事。
  const serious = /(?:认真|严肃|说正事|别撒娇|收敛|闭嘴|排障|报错|崩溃|线上)/u.test(queryText);
  const anchorLimit = serious ? 0 : (substantive && WORK_SCENES.has(intent.kind) ? 1 : 2);
  const anchors = config.styleAnchor === false || anchorLimit === 0
    ? []
    : selectStyleAnchors(store, { scene, limit: anchorLimit, rules: guardRules, fallbackScenes: sceneExtra }).filter((anchor) => findForbidden(anchor.text, guardRules).length === 0);
  const anchorIds = anchors.map((anchor) => Number(anchor.id));
  const anchorText = anchors.length === 0
    ? ''
    : ['【我以前这样说话，前辈说对（原话，别背句子，照着语气）】', ...anchors.map((a) => `「${a.text}」`)].join('\n');

  // v2 画像槽：常驻一小段「关于前辈」，按固定顺序拼，同一批记忆渲染结果相同，
  // 宿主可以对整块去重；事件型检索只负责补「这一轮真的要用的那几条」。
  const profileText = config.profileInject === false ? '' : buildProfileSlot(store, 200);

  const soulBits = [];
  if (soulStyle !== '') soulBits.push(`前辈的说话习惯（本地统计，只用来调语气，不是人设）：${soulStyle}`);
  if (selfModel !== '') soulBits.push(`我对自己的认知（随时间微调，别当固定人设背）：${clip(selfModel, 90)}`);
  const soulText = soulBits.length > 0 ? soulBits.join('\n') : '';

  const hasAnything = relationText !== '' || projectText !== '' || memText !== '' || includeQuestion || styleHint !== '' || soulText !== '' || judgmentText !== '' || recapText !== '' || emotionText !== '' || anchorText !== '' || profileText !== '' || rulesText !== '';
  if (!hasAnything) return finish('');

  const sections = [];
  // 优先级：P1 行为规则 → 情绪/近况/关系 → P2 项目与未决判断 → P3 记忆 → P4 画像/场景策略/正向锚点 → 未决问题。
  if (rulesText !== '') sections.push({ key: 'rules', text: rulesText, budget: 220 });
  if (emotionText !== '') sections.push({ key: 'emotion', text: emotionText, budget: 120 });
  if (recapText !== '') sections.push({ key: 'recap', text: recapText, budget: 360 });
  if (relationText !== '') sections.push({ key: 'relation', text: relationText, budget: plan.relation });
  if (projectText !== '') sections.push({ key: 'project', text: projectText, budget: plan.project });
  if (judgmentText !== '') sections.push({ key: 'judgment', text: judgmentText, budget: 200 });
  if (memText !== '') sections.push({ key: 'memories', text: memText, budget: plan.memories });
  if (soulText !== '') sections.push({ key: 'soul', text: soulText, budget: 200 });
  if (profileText !== '') sections.push({ key: 'profile', text: profileText, budget: 200 });
  if (styleHint !== '') sections.push({ key: 'style', text: styleHint, budget: 160 });
  if (anchorText !== '') sections.push({ key: 'voicestyle', text: anchorText, budget: 260 });
  if (includeQuestion) {
    sections.push({ key: 'question', text: `之前留下、还没解决的事：${clip(state.openQuestion, 100)}`, budget: 120 });
  }
  dedupeSectionLines(sections);
  const kept = sections.filter((section) => section.text.trim() !== '');
  if (report) {
    report.sections = Object.fromEntries(kept.map((section) => [section.key, section.text.length]));
  }
  if (kept.length === 0) return finish('');
  const header = '【soul · 我记着的】以下是我对这个人的一些观察记录，可能过时、可能片面。它们只是判断素材，不是必须执行的清单：用哪条、怎么开口、要不要提，都由此刻的判断决定；和他当前这句话冲突时，以这句话为准。';
  const footer = '（没记过的事别当成共同经历；不用为了显得记得而翻旧账；背景只是背景，不主动汇报。）';
  const body = kept.map((s) => s.text).join('\n');
  let text = `${header}\n${body}\n${footer}`;
  if (text.length > plan.total) {
    const trace = {};
    text = enforceFreeformBudget(header, kept, footer, plan.total, trace);
    if (report) report.removedSections = trace.removedSections ?? [];
    if (trace.hardCap) degraded.push('hardCap');
  }
  if (text === '') return finish('');
  // 只有最终文本里真的留下的锚点才算「上一轮用过」，供下一轮负评归责。
  if (anchorIds.length > 0) {
    const visibleIds = anchors
      .filter((anchor) => text.includes(`「${anchor.text}」`))
      .map((anchor) => Number(anchor.id));
    if (visibleIds.length > 0 && !dryRun) {
      try { markStyleAnchorsUsed(store, visibleIds); } catch { /* 统计失败不影响注入 */ }
    }
  }
  logger?.debug?.(`注入块 ${text.length} 字（~${estimateTokens(text)} token）`);
  return finish(text);
}

/** 跨层去重：同一句在规则/记忆/画像/关系里只保留第一次出现。 */
function dedupeSectionLines(sections) {
  const seen = new Set();
  for (const section of sections) {
    const kept = [];
    for (const line of String(section.text ?? '').split('\n')) {
      const key = normText(line);
      if (key !== '' && seen.has(key)) continue;
      if (key !== '') seen.add(key);
      kept.push(line);
    }
    section.text = kept.join('\n');
  }
}

/**
 * 「我现在的心情」段（v1.3）。
 *
 * 只注入一行：情绪 + 一句原因，给模型调语气，不解释、不命令（「所以你要对我好点」
 * 这种话不写）。中性（轻松且无原因）时不注入，不为零情绪付 token。
 * 时间演化（开心衰减、生气累积）由 evolve 负责，这里只渲染。
 */
export function renderEmotionLine(store, config = {}, now = Date.now()) {
  if (config.emotionInject === false) return '';
  let emotion = null;
  try {
    emotion = store.getEmotion?.() ?? null;
  } catch {
    return '';
  }
  if (!emotion) return '';
  const evolved = evolve(emotion, now, {
    decayHours: config.emotionDecayHours,
    negativeHours: config.emotionNegativeHours,
    negativeStep: config.emotionNegativeStep,
    floor: config.emotionFloor,
  });
  const reason = String(evolved.reason ?? '').trim();
  const topic = String(evolved.topic ?? '').trim();
  if (Math.abs(evolved.valence) < 0.05 && reason === '' && topic === '') return '';
  const parts = [];
  if (topic !== '') parts.push(clip(topic, 20));
  if (reason !== '') parts.push(clip(reason, 24));
  const tail = parts.length > 0 ? `（${parts.join('，')}）` : '';
  return `我现在的心情：${evolved.label}${tail}。`;
}

/**
 * 「上次聊天」段：久别之后第一句，把上次最后几轮的原话接回来。
 *
 * 判据只有时间：距上一条消息超过 recapWindowMinutes 才注入。刚聊完不注入，
 * 因为那段对话本来就在上下文里；隔了半小时再从零开始问「你刚说啥」才是问题。
 * 只给原话 + 时间，不做解读——接不接、怎么接，留给当下判断。
 *
 * @returns {string} 空字符串表示不需要这一段
 */
export function renderRecapLines(store, config = {}, now = Date.now()) {
  if (config.recapInject === false) return '';
  let material = null;
  try {
    material = store.recapMaterial({ turns: config.recapTurns ?? 3, now });
  } catch {
    return '';
  }
  if (!material || material.turns.length === 0) return '';
  const windowMinutes = clampNumber(config.recapWindowMinutes, 5, 24 * 60, 30);
  if (material.gapMs < windowMinutes * 60_000) return '';
  const lines = [`上次聊天（${formatSpan(material.gapMs)}前）：`];
  for (const turn of material.turns) {
    const user = String(turn.userText ?? '').trim();
    const assistant = String(turn.assistantText ?? '').trim();
    if (user !== '') lines.push(`你：${smartClip(user, 60)}`);
    if (assistant !== '') lines.push(`我：${smartClip(assistant, 60)}`);
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 关系段：只用于语气与称呼。
 *
 * v0.8.0：工作与常态合并——不再标「做事/讨论场景」，也不再因为对方在干活就
 * 把梗或边界收起来；称呼、语气、尺度一视同仁。
 */
/**
 * 画像槽（L3）：把「前辈是谁 / 长期偏好」预编译成一小段常驻文本。
 *
 * 和事件检索的分工：画像槽回答「这个人一直是什么样的」，检索只回答「这一轮要用的那几条」。
 * 按 store.topMemories 的固定顺序拼接，同一批记忆每次渲染结果相同——宿主靠文本比较去重，
 * 文本一变就会在历史里多一条快照，所以这里刻意不掺时间、轮数这类每轮都变的东西。
 */
export function buildProfileSlot(store, limitChars = 200) {
  let rows = [];
  try {
    rows = store.topMemories(12, ['preference', 'profile', 'relationship', 'interaction']) ?? [];
  } catch {
    return '';
  }
  const seen = new Set();
  const parts = [];
  for (const row of rows) {
    const text = String(row?.content ?? '').trim();
    if (text === '' || seen.has(text)) continue;
    seen.add(text);
    parts.push(smartClip(text, 40));
  }
  if (parts.length === 0) return '';
  return `【关于前辈（长期有效；只在相关时用，别当话题）】${clip(parts.join('；'), limitChars)}`;
}

function renderRelationLines({ rel, relationMemories, plan, turns, intent, substantive = false }) {
  if (!rel && relationMemories.length === 0) return '';
  const kind = intent?.kind ?? 'chat';
  const lines = [];
  const aliasBits = [];
  if (rel?.userAlias) aliasBits.push(`你叫用户「${clip(rel.userAlias, 12)}」`);
  if (rel?.agentAlias) aliasBits.push(`允许用户叫你「${clip(rel.agentAlias, 12)}」`);
  const meta = [];
  if (turns > 0) {
    const days = rel?.firstSeen ? Math.max(0, Math.floor((Date.now() - rel.firstSeen) / 86_400_000)) : 0;
    // 不写「聊过 N 轮」：这个数字每回合都变，会让整块注入文本每轮都不同，
    // 宿主就不会去重，历史里会堆几十份只差一个数字的旧快照。
    meta.push(`认识 ${days} 天`);
  }
  if (aliasBits.length > 0) meta.push(aliasBits.join('，'));
  if (rel?.tone) meta.push(`当前表达尺度：${clip(rel.tone, 40)}`);
  if (meta.length > 0) lines.push(`关系背景（只用于语气与称呼，不必提及）：${meta.join('；')}`);
  if (rel?.boundaries) lines.push(`要遵守的边界：${clip(rel.boundaries, 80)}`);
  if (rel?.sharedTerms) lines.push(`共同的梗/约定：${clip(rel.sharedTerms, 80)}`);
  const factLimit = intent?.memoryAsk === true
    ? 3
    : ((kind === 'flirt' || kind === 'chat' || kind === 'casual') && substantive ? 1 : 0);
  if (factLimit > 0) {
    // 关系细节只在确实需要回忆（或闲聊有实质内容）时给，避免模型为了显得熟而念旧。
    const facts = dedupeRelationFacts(relationMemories)
      .map((text) => smartClip(text, 48))
      .filter((text) => text.length >= 3)
      .slice(0, factLimit);
    if (facts.length > 0) lines.push(`关系细节（只在合适时自然接一句，不必主动提）：${facts.join('；')}`);
  }
  return truncateSection(lines, plan?.relation ?? 300);
}

/** 关系细节去重：同一句话的多个版本只留一条，避免自相矛盾的设定同时出现。 */
function dedupeRelationFacts(memories) {
  const out = [];
  for (const memory of memories) {
    const content = String(memory?.content ?? '').trim();
    if (content === '') continue;
    if (out.some((kept) => kept === content || kept.includes(content) || content.includes(kept))) continue;
    out.push(content);
  }
  return out;
}

function renderProjectLines(snapshot, budget) {
  const { project, byKind } = snapshot;
  const bits = [];
  if (project.goal) bits.push(`目标：${clip(project.goal, 60)}`);
  if (project.stage) bits.push(`阶段：${clip(project.stage, 30)}`);
  const head = `项目背景（仅当当前话题确实相关时才接话，不要主动汇报进度）：「${project.name}」（${project.status}${project.lastTouchedAt ? `，${formatAge(project.lastTouchedAt)}更新` : ''}）${bits.length > 0 ? ` — ${bits.join('，')}` : ''}`;
  const lines = [head];
  const picks = [
    ['done', '已完成', 4],
    ['decision', '关键决定', 4],
    ['todo', '待办', 5],
    ['blocker', '阻塞', 3],
    ['issue', '问题', 2],
    ['next', '下一步', 2],
  ];
  for (const [kind, label, max] of picks) {
    const items = (byKind?.[kind] ?? []).filter((item) => item.state !== 'done' || kind === 'done');
    if (items.length === 0) continue;
    const texts = items.slice(0, max).map((item) => smartClip(item.content, 40)).filter((t) => t.length > 0);
    if (texts.length > 0) lines.push(`  ${label}：${texts.join('；')}`);
  }
  const todosLeft = (byKind?.todo ?? []).length;
  return truncateSection(lines, budget, todosLeft);
}

function truncateSection(lines, budget, extraNote = 0) {
  let text = lines.join('\n');
  if (extraNote > 0 && text.length + 20 <= budget) text += `\n  （还有 ${extraNote} 条待办未列出）`;
  while (text.length > budget && lines.length > 1) {
    lines.pop();
    text = lines.join('\n');
  }
  if (text.length > budget) text = smartClip(text, budget);
  return text;
}

/**
 * 注入分三级（v1.4）：能提的 / 只调语气的 / 拿不准的。
 * 以前所有记忆都是一个口气，等于把「观察」和「事实」混着往外说；
 * 分开之后，低置信和很久以前的只带不确定感，偏好类只影响语气、不复述内容。
 */
export function renderInjectedMemories(memories, budget, collect) {
  // 带时效：让模型自己判断「这条还成不成立」，而不是把记忆当永久事实。
  const ageTail = (memory) => {
    const age = memory.updatedAt ? formatAge(memory.updatedAt) : '';
    return age !== '' && age !== '刚刚' ? `（${age}记的）` : '';
  };
  const groups = { mention: [], past: [], tone: [], uncertain: [] };
  for (const memory of memories) {
    const usage = usageOf(memory);
    (groups[usage] ?? groups.mention).push(memory);
  }
  const header = '可能相关的旧信息（只在确实有帮助时取用，不必主动提及）：';
  const lines = [header];
  // 诊断：哪些条目真的进了文本、哪些被这层预算裁掉（第三类淘汰原因）。
  const shownIds = collect?.shownIds ?? [];
  const droppedIds = collect?.droppedIds ?? [];
  let used = header.length;
  const push = (line) => {
    if (used + line.length + 1 > budget) return false;
    lines.push(line);
    used += line.length + 1;
    return true;
  };
  const sections = [
    {
      key: 'mention',
      title: '【可以自然提起】',
      format: (memory) => `- [${typeLabel(memory.type)}] ${smartClip(String(memory.content ?? ''), 80)}${ageTail(memory)}`,
    },
    {
      key: 'past',
      title: '【以前的情况：只能当「以前」说，别当现在】',
      format: (memory) => `~ ${smartClip(String(memory.content ?? ''), 70)}${ageTail(memory)}`,
    },
    {
      key: 'tone',
      title: '【只影响语气，不要复述内容】',
      format: (memory) => `· ${smartClip(String(memory.content ?? ''), 60)}${ageTail(memory)}`,
    },
    {
      key: 'uncertain',
      title: '【拿不准／较旧，别当事实说】',
      format: (memory) => `? ${smartClip(String(memory.content ?? ''), 60)}${ageTail(memory)}`,
    },
  ];
  for (const section of sections) {
    const rows = groups[section.key] ?? [];
    if (rows.length === 0) continue;
    if (!push(section.title)) {
      for (const rest of rows) droppedIds.push(Number(rest.id));
      break;
    }
    for (let index = 0; index < rows.length; index += 1) {
      const memory = rows[index];
      if (push(section.format(memory))) {
        shownIds.push(Number(memory.id));
        continue;
      }
      for (const rest of rows.slice(index)) droppedIds.push(Number(rest.id));
      return lines.length > 1 ? lines.join('\n') : '';
    }
  }
  return lines.length > 1 ? lines.join('\n') : '';
}

/**
 * 判断素材段（v0.7 主动性）：不给「该主动关心/该追问」的指令，只给「我上次的判断和它的结果」。
 * 素材带结果、时效和不确定标记，用不用、怎么用由模型当场判断。
 */
function renderJudgmentLines(store, { intent, substantive }) {
  let material;
  try {
    material = store.judgmentMaterial({ wrongDays: 7, staleDays: 2 });
  } catch {
    return '';
  }
  const { wrong, stale } = material;
  if (wrong.length === 0 && stale.length === 0) return '';
  // P2：只在工作/讨论/恢复场景注入，纯闲聊不念日记。
  if (!WORK_SCENES.has(intent?.kind)) return '';
  const lines = ['我自己的判断记录（不是事实，用来提醒自己别重复同一个错）：'];
  for (const item of wrong) {
    const note = item.note ? `（${smartClip(item.note, 40)}）` : '';
    lines.push(`- 我上次猜「${smartClip(item.guess, 60)}」，猜错了${note}`);
  }
  for (const item of stale) {
    const subject = item.subject ? `（针对「${smartClip(item.subject, 40)}」）` : '';
    lines.push(`- 我判断过「${smartClip(item.guess, 60)}」${subject}，还没验证，可能已经过时`);
  }
  return truncateSection(lines, 200);
}

function enforceFreeformBudget(header, sections, footer, total, trace) {
  const ordered = [...sections].sort((a, b) => (a.key === 'memories' ? 1 : 0) - (b.key === 'memories' ? 1 : 0));
  const kept = [...ordered];
  const assemble = () => [header, ...kept.map((s) => s.text), footer].join('\n');
  let text = assemble();
  while (text.length > total && kept.length > 1) {
    // 先丢记忆段，再丢最不关键的段
    const idx = kept.findIndex((s) => s.key === 'memories');
    if (idx >= 0) {
      if (trace) (trace.removedSections ??= []).push(kept[idx].key);
      kept.splice(idx, 1);
    } else {
      if (trace) (trace.removedSections ??= []).push(kept[kept.length - 1].key);
      kept.pop();
    }
    text = assemble();
  }
  if (text.length > total) {
    if (trace) trace.hardCap = true;
    text = smartClip(text, total);
  }
  if (trace && !trace.hardCap) trace.hardCap = false;
  return text;
}

// ── 给用户看的渲染（/soul 命令、soul_* 工具） ────────────────────

/** 记忆列表：`#12 [偏好] 内容（3 次，2 天前）`。 */
export function renderMemoryList(memories, { showIds = true, clipChars = 100 } = {}) {
  if (!Array.isArray(memories) || memories.length === 0) return '（没有匹配的记忆）';
  return memories.map((m) => {
    const id = showIds ? `#${m.id} ` : '';
    const hits = m.hits > 1 ? `，${m.hits} 次` : '';
    const age = m.updatedAt ? `，${formatAge(m.updatedAt)}` : '';
    const tags = m.tags ? ` [${m.tags}]` : '';
    const mark = m.status === 'candidate' ? '，候选' : '';
    const importance = Number(m.importance ?? 0.5) >= 0.8 ? '，重要' : '';
    return `${id}[${typeLabel(m.type)}]${tags} ${clip(m.content, clipChars)}（置信 ${Number(m.confidence ?? 0).toFixed(2)}${importance}${hits}${age}${mark}）`;
  }).join('\n');
}

/** 项目快照（给命令/工具用的详细版）。 */
export function renderProjectSnapshot(snapshot, { verbose = true } = {}) {
  if (!snapshot) return '（项目不存在）';
  const { project, byKind } = snapshot;
  const lines = [`项目「${project.name}」#${project.id} — ${project.status}${project.stage ? ` / 阶段：${project.stage}` : ''}`];
  if (project.goal) lines.push(`目标：${project.goal}`);
  if (project.lastTouchedAt) lines.push(`最近更新：${formatTime(project.lastTouchedAt)}（${formatAge(project.lastTouchedAt)}）`);
  const groups = [
    ['done', '已完成'], ['decision', '重要决定'], ['todo', '待办'], ['issue', '未解决问题'],
    ['blocker', '阻塞'], ['next', '下一步'], ['note', '备注'], ['file', '相关文件'], ['session', '相关会话'],
  ];
  for (const [kind, label] of groups) {
    const items = byKind?.[kind] ?? [];
    if (items.length === 0) continue;
    lines.push(`${label}：`);
    for (const item of items.slice(0, verbose ? 20 : 5)) {
      const extra = [];
      if (item.priority) extra.push(`P${item.priority}`);
      if (item.dependsOn) extra.push(`依赖 ${item.dependsOn}`);
      if (item.acceptance) extra.push(`验收 ${clip(item.acceptance, 40)}`);
      lines.push(`  - #${item.id} ${item.content}${extra.length ? `（${extra.join('；')}）` : ''}`);
    }
  }
  return lines.join('\n');
}

/** 项目列表。 */
export function renderProjectList(projects, store) {
  if (!Array.isArray(projects) || projects.length === 0) return '（还没有项目记录）';
  return projects.map((p) => {
    const snapshot = store.projectSnapshot(p.id);
    const todos = (snapshot?.byKind?.todo ?? []).length;
    const blockers = (snapshot?.byKind?.blocker ?? []).length;
    return `#${p.id} 「${p.name}」${p.status}${p.stage ? ` / ${p.stage}` : ''} — 待办 ${todos}，阻塞 ${blockers}${p.lastTouchedAt ? `，${formatAge(p.lastTouchedAt)}更新` : ''}`;
  }).join('\n');
}

/** 插件状态（/soul status、soul_status）。 */
export function renderStatus({ store, config, paths, personaInfo, version = '0.1.0', embedding = null }) {
  const stats = store.stats();
  const mem = stats.memories;
  const typeBits = Object.entries(mem.byType ?? {}).map(([type, n]) => `${typeLabel(type)} ${n}`).join('，');
  const plan = budgetPlan(config);
  const health = typeof store.health === 'function' ? store.health() : { ok: true, detail: 'ok' };
  const rules = stats.styleRules ?? (typeof store.styleRuleStats === 'function' ? store.styleRuleStats() : null);
  const guard = stats.guardHits ?? {};
  const guardTotal = Number(guard.total ?? 0) || 0;
  const personaSources = personaInfo?.sources ?? [];
  const personaLoaded = personaSources.filter((source) => source.ok).length;
  const personaTotal = personaSources.length || 3;
  const personaKeys = personaSources.map((source) => source.key);
  const personaDuplicates = [...new Set(personaKeys.filter((key, index) => personaKeys.indexOf(key) !== index))];
  const personaState = personaInfo?.usingFallback === true
    ? '使用后备人格（文件缺失）'
    : personaDuplicates.length > 0
      ? `警告：重复挂载 ${personaDuplicates.join(', ')}`
      : '正常';
  const vectors = typeof store.embeddingCount === 'function' ? store.embeddingCount('memory') : null;
  const vectorBit = vectors === null ? '' : `，已建索引 ${vectors} 条`;
  const embeddingLine = config.embeddingRetrieval === false
    ? '语义检索：关（只做字面检索）'
    : embedding?.ready === true
      ? `语义检索：开（${embedding.model} 已加载${vectorBit}）`
      : embedding?.failed
        ? `语义检索：降级为字面（${clip(embedding.failed, 80)}${vectorBit}）`
        : `语义检索：开（模型懒加载，尚未触发${vectorBit}）`;
  let extractionLast = null;
  try {
    extractionLast = JSON.parse(store.metaGet('extraction.last') ?? 'null');
  } catch { /* 统计坏了不影响状态展示 */ }
  let lastRule = null;
  try {
    lastRule = rules?.lastUpdatedAt ? store.listStyleRules({ limit: 1 })[0] ?? null : null;
  } catch { /* 同上 */ }
  // v1.6 可观测：唤醒日志有没有在记、最近一次走的哪条路、有没有降级。
  let wakeStats = { total: 0, lastAt: 0 };
  let lastWake = null;
  try {
    wakeStats = typeof store.wakeLogStats === 'function' ? store.wakeLogStats() : wakeStats;
    lastWake = typeof store.recentWakeLogs === 'function' ? (store.recentWakeLogs({ limit: 1 })[0] ?? null) : null;
  } catch { /* 诊断坏了不影响状态展示 */ }
  const wakeLine = wakeStats.total > 0
    ? `唤醒日志：${wakeStats.total} 行，最近 ${formatAge(wakeStats.lastAt)}（路径 ${lastWake?.path || '?'}${lastWake?.degraded ? `，降级 ${clip(lastWake.degraded, 40)}` : ''}）`
    : '唤醒日志：还没有记录（v1.6 起每轮写一行）';
  const lines = [
    `soul v${version} — ${store.path}`,
    `记忆库：${mem.total} 条有效记忆${typeBits ? `（${typeBits}）` : ''}；检索：${stats.fts ? 'FTS5 trigram + LIKE' : 'LIKE（FTS5 不可用）'}；schema v${stats.schemaVersion ?? '?'}；健康检查：${health.ok ? 'ok' : `失败（${clip(health.detail, 60)}）`}`,
    ...(mem.candidates > 0 ? [`候选记忆：${mem.candidates} 条（/soul candidates 查看；approve <id> 转正）`] : []),
    `会话：${stats.sessions} 个，回合：${stats.turns} 个；项目：${stats.projects.active} 个活跃 / ${stats.projects.paused} 个暂停；任务：${stats.tasks.open} 个未完成（阻塞 ${stats.tasks.blocked}）`,
    `关系：认识 ${stats.relation?.firstSeen ? Math.max(0, Math.floor((Date.now() - stats.relation.firstSeen) / 86_400_000)) : 0} 天，聊过 ${stats.relation?.turns ?? 0} 轮${stats.relation?.userAlias ? `；称呼「${stats.relation.userAlias}」` : ''}`,
    `人格：${personaState}（${personaLoaded}/${personaTotal} 个文件已加载）`,
    `行为规则：active ${rules?.active ?? 0}，candidate ${rules?.candidate ?? 0}，superseded ${rules?.superseded ?? 0}，disabled ${rules?.disabled ?? 0}${lastRule ? `；最近学习 ${formatAge(lastRule.updatedAt)}（${lastRule.category}）` : ''}`,
    `输出守卫：累计拦截 ${guardTotal} 次${guard.lastAt ? `，最近 ${formatAge(guard.lastAt)}` : ''}`,
    `语义抽取：${extractionLast?.at ? `最近 ${formatAge(extractionLast.at)}（turn ${extractionLast.turn ?? '?'}，记忆 ${extractionLast.memories ?? 0} 条）` : '还没有记录'}${config.memoryExtraction === 'off' ? '；已关闭' : ''}`,
    embeddingLine,
    wakeLine,
    `注入：${config.inject === false ? '关闭' : `开（总预算 ${plan.total} 字，其中记忆 ${plan.memories} 字 / 最多 ${config.memoryInjectCount ?? 8} 条）`}`,
    `配置：capture=${config.capture !== false}，relationMemory=${config.relationMemory !== false}，styleRuleInject=${config.styleRuleInject !== false}，tools=${config.tools !== false}，commands=${config.commands !== false}`,
    `最近整理：${stats.lastCurationAt ? `${formatTime(stats.lastCurationAt)}（${formatAge(stats.lastCurationAt)}）` : '未执行'}`,
    `日志：${paths?.logFile ?? '—'}`,
  ];
  return lines.join('\n');
}

/** 复盘摘要（/soul review、soul_review）：全部本地生成，不额外调模型。 */
export function renderReview(store, { turns: turnLimit = 15 } = {}) {
  const lines = [];
  const projects = store.listProjects({ status: 'any', limit: 10 });
  const openTasks = store.openTasks(20);
  const recent = store.recentTurns(turnLimit);
  const rel = store.getRelation();

  lines.push('【复盘】');
  if (rel) {
    lines.push(`关系：${rel.turns} 轮${rel.userAlias ? `，用户称呼「${rel.userAlias}」` : ''}${rel.tone ? `，尺度：${rel.tone}` : ''}`);
  }
  if (recent.length > 0) {
    lines.push('最近聊过：');
    for (const turn of recent.slice(0, 8)) {
      const user = clip(turn.userText, 60);
      if (user === '') continue;
      lines.push(`  - [${formatAge(turn.endedAt)}] ${user}${turn.toolCalls > 0 ? `（用了 ${turn.toolCalls} 次工具）` : ''}`);
    }
  }
  if (projects.length > 0) {
    lines.push('项目状态：');
    for (const project of projects) {
      const snapshot = store.projectSnapshot(project.id);
      const todos = (snapshot?.byKind?.todo ?? []).filter((i) => i.state !== 'done');
      const blockers = snapshot?.byKind?.blocker ?? [];
      const next = snapshot?.byKind?.next ?? [];
      lines.push(`  - 「${project.name}」${project.status}${project.stage ? `/${project.stage}` : ''}：待办 ${todos.length}，阻塞 ${blockers.length}${blockers.length ? `（${clip(blockers[0].content, 50)}）` : ''}${next.length ? `，下一步：${clip(next[0].content, 50)}` : ''}`);
    }
  }
  if (openTasks.length > 0) {
    lines.push('未完成任务：');
    for (const task of openTasks.slice(0, 10)) {
      lines.push(`  - #${task.id} [${task.state}] ${clip(task.title, 70)}`);
    }
  }
  const mem = store.memoryCounts();
  lines.push(`记忆：${mem.total} 条有效（${Object.entries(mem.byType ?? {}).map(([t, n]) => `${typeLabel(t)} ${n}`).join('，') || '无'}）`);
  if (lines.length <= 2) lines.push('（最近没有足够的记录可以复盘；等积累几轮对话再看）');
  return lines.join('\n');
}

function clampNumber(value, min, max, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}
