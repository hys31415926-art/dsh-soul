/**
 * dsh-soul render — 把记忆/项目/关系状态渲染成给模型看的短文本，或给用户看的状态文本。
 *
 * 两条硬规则：
 *   · 注入块是「每轮都付 token」的东西，所以有硬预算：超了就整行整段地丢，绝不半句截断；
 *   · 注入块里明确写「可能过时、以当前对话为准、不要复述本块」，避免模型把记忆当圣旨。
 */
import { clip, estimateTokens, formatAge, formatSpan, formatTime, smartClip } from '../util.js';
import { buildQuery, selectMemories, selectRelationshipMaterial } from './retrieval.js';
import { buildStyleHint, classifyTurn, hasSubstantiveQuery, projectRelevance, shouldIncludeOpenQuestion } from '../core/conversation-policy.js';
import { styleSummaryOf } from './style.js';
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
    return [
      '【当前这轮：主人在说你的说话方式本身】',
      '先接住这句话（最多一句），然后直接继续正常内容。',
      '不要解释原因、不要自我分析、不要承诺改变（例如「我以后会…」「我把话说简短一点」），不要反问确认。',
    ].join('\n');
  }
  const query = buildQuery(queryText, state);
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
  // 轻对话且没有实质内容时不检索记忆：宁可不注入，也不把旧事硬塞进闲聊。
  const memorySelection = memoryEnabled && !(intent.light && !substantive)
    ? selectMemories(store, {
      query,
      limit: clampNumber(config.memoryInjectCount, 1, 16, 8),
      budgetChars: Math.max(140, plan.memories - judgmentBudget),
      projectId: projectGate.relevant ? (state?.activeProjectId ?? 0) : 0,
      queryVector: input.queryVector ?? null,
      semanticMin: config.embeddingThreshold,
    })
    : { memories: [], chars: 0 };
  const relationMemories = config.relationMemory === false ? [] : selectRelationshipMaterial(store, 4);
  const turns = Number(rel?.turns ?? 0);
  const sessions = store.sessionCount();

  const relationText = config.relationMemory === false
    ? ''
    : renderRelationLines({ rel, relationMemories, plan, turns, intent, substantive });
  const projectText = projectGate.relevant ? renderProjectLines(project, plan.project) : '';
  const memText = memorySelection.memories.length > 0
    ? renderInjectedMemories(memorySelection.memories, plan.memories)
    : '';

  const soulBits = [];
  if (soulStyle !== '') soulBits.push(`主人的说话习惯（本地统计，只用来调语气，不是人设）：${soulStyle}`);
  if (selfModel !== '') soulBits.push(`我对自己的认知（随时间微调，别当固定人设背）：${clip(selfModel, 90)}`);
  const soulText = soulBits.length > 0 ? soulBits.join('\n') : '';

  const hasAnything = relationText !== '' || projectText !== '' || memText !== '' || includeQuestion || styleHint !== '' || soulText !== '' || judgmentText !== '' || recapText !== '' || emotionText !== '';
  if (!hasAnything) return '';

  const sections = [];
  if (styleHint !== '') sections.push({ key: 'style', text: styleHint, budget: 160 });
  if (emotionText !== '') sections.push({ key: 'emotion', text: emotionText, budget: 120 });
  if (recapText !== '') sections.push({ key: 'recap', text: recapText, budget: 360 });
  if (relationText !== '') sections.push({ key: 'relation', text: relationText, budget: plan.relation });
  if (soulText !== '') sections.push({ key: 'soul', text: soulText, budget: 200 });
  if (projectText !== '') sections.push({ key: 'project', text: projectText, budget: plan.project });
  if (judgmentText !== '') sections.push({ key: 'judgment', text: judgmentText, budget: 200 });
  if (memText !== '') sections.push({ key: 'memories', text: memText, budget: plan.memories });
  if (includeQuestion) {
    sections.push({ key: 'question', text: `之前留下、还没解决的事：${clip(state.openQuestion, 100)}`, budget: 120 });
  }
  if (sections.length === 0) return '';

  const header = '【soul · 我记着的】以下是我对这个人的一些观察记录，可能过时、可能片面。它们只是判断素材，不是必须执行的清单：用哪条、怎么开口、要不要提，都由此刻的判断决定；和他当前这句话冲突时，以这句话为准。';
  const footer = '（没记过的事别当成共同经历；不用为了显得记得而翻旧账；背景只是背景，不主动汇报。）';
  const body = sections.map((s) => s.text).join('\n');
  let text = `${header}\n${body}\n${footer}`;
  if (text.length > plan.total) text = enforceFreeformBudget(header, sections, footer, plan.total);
  if (text === '') return '';
  logger?.debug?.(`注入块 ${text.length} 字（~${estimateTokens(text)} token）`);
  return text;
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
  if (Math.abs(evolved.valence) < 0.05 && reason === '') return '';
  const tail = reason !== '' ? `（${clip(reason, 24)}）` : '';
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
    meta.push(`认识 ${days} 天，一起聊过 ${turns} 轮`);
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

function renderInjectedMemories(memories, budget) {
  const lines = ['可能相关的旧信息（只在确实有帮助时取用，不必主动提及）：'];
  let used = lines[0].length;
  for (const memory of memories) {
    // 带时效：让模型自己判断「这条还成不成立」，而不是把记忆当永久事实。
    const age = memory.updatedAt ? formatAge(memory.updatedAt) : '';
    const tail = age !== '' && age !== '刚刚' ? `（${age}记的）` : '';
    const line = `- [${typeLabel(memory.type)}] ${smartClip(String(memory.content ?? ''), 80)}${tail}`;
    if (used + line.length + 1 > budget) break;
    lines.push(line);
    used += line.length + 1;
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
  // 纯闲聊且无实质内容时不注入：没有在对话/做事，判断素材只会让人显得在念日记。
  if (intent?.light && !substantive) return '';
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

function enforceFreeformBudget(header, sections, footer, total) {
  const ordered = [...sections].sort((a, b) => (a.key === 'memories' ? 1 : 0) - (b.key === 'memories' ? 1 : 0));
  const kept = [...ordered];
  const assemble = () => [header, ...kept.map((s) => s.text), footer].join('\n');
  let text = assemble();
  while (text.length > total && kept.length > 1) {
    // 先丢记忆段，再丢最不关键的段
    const idx = kept.findIndex((s) => s.key === 'memories');
    if (idx >= 0) kept.splice(idx, 1);
    else kept.pop();
    text = assemble();
  }
  if (text.length > total) text = smartClip(text, total);
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
export function renderStatus({ store, config, paths, personaInfo, version = '0.1.0' }) {
  const stats = store.stats();
  const mem = stats.memories;
  const typeBits = Object.entries(mem.byType ?? {}).map(([type, n]) => `${typeLabel(type)} ${n}`).join('，');
  const plan = budgetPlan(config);
  const lines = [
    `soul v${version} — ${store.path}`,
    `记忆库：${mem.total} 条有效记忆${typeBits ? `（${typeBits}）` : ''}；检索：${stats.fts ? 'FTS5 trigram + LIKE' : 'LIKE（FTS5 不可用）'}`,
    ...(mem.candidates > 0 ? [`候选记忆：${mem.candidates} 条（/soul candidates 查看；approve <id> 转正）`] : []),
    `会话：${stats.sessions} 个，回合：${stats.turns} 个；项目：${stats.projects.active} 个活跃 / ${stats.projects.paused} 个暂停；任务：${stats.tasks.open} 个未完成（阻塞 ${stats.tasks.blocked}）`,
    `关系：认识 ${stats.relation?.firstSeen ? Math.max(0, Math.floor((Date.now() - stats.relation.firstSeen) / 86_400_000)) : 0} 天，聊过 ${stats.relation?.turns ?? 0} 轮${stats.relation?.userAlias ? `；称呼「${stats.relation.userAlias}」` : ''}`,
    `注入：${config.inject === false ? '关闭' : `开（总预算 ${plan.total} 字，其中记忆 ${plan.memories} 字 / 最多 ${config.memoryInjectCount ?? 8} 条）`}；人格文件：${personaInfo?.sources?.filter((s) => s.ok).length ?? 0}/${personaInfo?.sources?.length ?? 3} 个已加载`,
    `配置：capture=${config.capture !== false}，relationMemory=${config.relationMemory !== false}，tools=${config.tools !== false}，commands=${config.commands !== false}`,
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
