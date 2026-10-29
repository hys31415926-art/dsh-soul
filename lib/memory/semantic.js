/**
 * semantic — 用模型做「语义记忆抽取」，程序负责校验与落库。
 *
 * 用户指出的问题（本模块存在的全部理由）：
 *   1. 规则抽取会断句：从「如果发现项目有进展，就写到记忆中」截出「下一步：项目…」；
 *   2. 归属会错：把助手的承诺/建议写进用户事实与项目记录；
 *   3. 没有证据：写进去的记忆无法回答「哪一轮、哪句话」；
 *   4. 项目不主动维护：只有正则碰巧命中才有条目。
 *
 * 设计边界（任务书要求）：
 *   · 模型只做「理解 + 提议」，输出严格 JSON；
 *   · 证据引用由程序在真实会话事件里取（event seq / 原句），**不信任模型给的 quote**；
 *   · 用户事实必须有用户原句支撑，否则丢弃；
 *   · 助手内容只能作为「工作过程」证据（项目进展），不能升级为用户/关系/偏好事实；
 *   · 一次抽取有 token/超时上限，失败静默降级，不阻塞对话。
 */
import { clip, normText } from '../util.js';
import { addEvidence } from './evidence.js';
import { buildForbiddenRules, findForbidden } from '../output-guard.js';
import { addStyleExample, penalizeStyleExamples } from './style-examples.js';
import { recordJournal, normalizeJournalKind } from './journal.js';

/** 允许写入的记忆类型。 */
const MEMORY_TYPES = new Set(['preference', 'profile', 'episodic', 'project', 'interaction', 'relationship', 'fact']);
/** 用户事实类：必须由用户原句支撑。 */
const USER_FACT_TYPES = new Set(['preference', 'profile', 'episodic', 'interaction', 'relationship', 'fact']);
/** 明显是断句残片/命令词开头的内容直接拒绝。 */
const FRAGMENT_PREFIX_RE = /^(?:下一步|待办|项目|记忆|关系表达尺度|记住|注意|备注|TODO)[:：]/iu;
/** 用户第一人称原话被整句贴进来当结论（不是转述，也没有观察价值）。 */
const RAW_QUOTE_AS_FACT_RE = /^(?:我|俺)(?:爱|恨|喜欢|讨厌)(?:你|前辈)/u;
/** 把「我猜他当时很难受」写成稳定偏好：降成候选，等下一次真凭据再升。 */
const SPECULATED_EMOTION_RE = /(?:觉得|感到|认为)[^。]{0,12}(?:很难受|委屈|伤心|失望|生气|难过)|为此[^。]{0,8}(?:难受|伤心|失望)/u;
/** 内容最小/最大长度。 */
const MIN_CONTENT = 8;
const MAX_CONTENT = 160;
/**
 * 单回合项目更新上限。
 * 模型倾向于把每一步过程都写成一条进展（实测单回合 4~6 条），落库前统一收敛；
 * 超出上限的条目计入 rejected，方便在日志里看见「模型给多了」而不是悄悄丢。
 */
const MAX_PROJECT_UPDATES = 3;
/** 只有稳定类型才进项目档案；progress/work/note/idea 属于过程记录，只进工作日志。 */
const ARCHIVE_KINDS = new Set(['decision', 'plan', 'issue', 'done']);

/** 系统提示词：只描述任务与输出协议，人格由 prompts 负责，不在这里重复。 */
export const SEMANTIC_SYSTEM_PROMPT = `你是一个记忆抽取器，不是对话者。你的唯一任务：从给定的一轮（或几轮）真实对话中，抽取「值得长期保留」的信息与「项目进展」，输出严格 JSON。

规则：
1. 只记录**用户明确表达**、且在未来对话里仍成立的事实、偏好、长期目标、纠正、共同经历、关系设定。用户随口吐槽、玩笑、临时情绪、对未来的假设，不要记录。
2. **助手的话不能当成用户事实**。助手的承诺、建议、方案、解释只能作为「工作过程证据」，用于 projectUpdates（实际做了什么、决定了什么、遇到什么问题），不能用于 user 事实。
3. 每条 user 事实必须给 evidenceQuote：从用户原话里**逐字复制**一句（≤60 字）作为依据；给不出原句就不要输出这条。
4. 项目进展 projectUpdates 只记录本轮**实际发生**的：执行了命令/改了文件/验证了结果/形成决定/发现阻塞/产生计划。kind 只能是 progress|work|plan|idea|decision|issue|done|note。**最多 3 条**：优先记录决定、问题、完成这类稳定信息；过程性步骤合并成一条，不要逐步罗列。
5. 不确定就不输出；宁可少，不可编。禁止把这句话本身、命令名、文件路径碎片写进 content。
6. styleRules/styleExamples 只在用户明确夸/嫌某种说法，或助手明确采纳用户金句时输出。rule 写正向行为，不复述脏话；styleExamples.text 必须是被夸/被嫌的原句，positive 最多 2，negative 最多 2。
7. 输出 JSON 且只输出 JSON，不要 markdown 围栏，不要解释。

输出格式：
{"memories":[{"type":"preference|profile|episodic|interaction|relationship|fact","content":"一句完整的话（必须自足，不要代词指代）","confidence":0.0-1.0,"importance":0.0-1.0,"evidenceQuote":"用户原话片段","supersedesId":null}],
 "projectUpdates":[{"projectId":0,"kind":"progress|work|plan|idea|decision|issue|done|note","summary":"一句完整的进展描述","evidenceQuote":"助手或用户原话片段","confidence":0.0-1.0}],
 "styleRules":[{"rule":"正向行为规则","scene":"work|chat|","category":"mechanical_tone|self_analysis_apology|over_questioning|formulaic_progress|over_intimate|flat_tone|general","explicit":true,"evidenceQuote":"用户反馈原句"}],
 "styleExamples":[{"text":"被夸或被嫌的原句","kind":"positive|negative","scene":"work|chat|","evidenceQuote":"依据原句"}],
 "relation":{},
 "rejected":[]}
若某类没有内容，给空数组/空对象。projectUpdates 最多 3 条，styleRules/styleExamples 各最多 2 条。`;

/** 把「最近几轮窗口」渲染成模型输入（控制长度，只给必要上下文）。 */
export function renderWindowForPrompt({ turns = [], project = null, openTasks = [], relatedMemories = [] } = {}) {
  const lines = [];
  if (project) {
    lines.push(`当前项目：${project.name}（阶段：${project.stage || '未设定'}；目标：${clip(project.goal || '', 120)}）`);
  }
  if (openTasks.length > 0) {
    lines.push(`未完成任务：${openTasks.slice(0, 5).map((task) => `${task.title}(${task.state})`).join('；')}`);
  }
  if (relatedMemories.length > 0) {
    lines.push('已有相关记忆（用于判断是否重复/纠正，不要复述）：');
    for (const memory of relatedMemories.slice(0, 6)) lines.push(`- #${memory.id} [${memory.type}] ${clip(memory.content, 80)}`);
  }
  lines.push('', '对话记录（按时间顺序）：');
  for (const turn of turns) {
    lines.push(`--- 第 ${turn.turn} 轮 ---`);
    if (turn.userText) lines.push(`[用户] ${clip(turn.userText, 800)}`);
    if (turn.toolNames?.length > 0) lines.push(`[工具] ${turn.toolNames.slice(0, 10).join(', ')}`);
    if (turn.assistantText) lines.push(`[助手] ${clip(turn.assistantText, 900)}`);
  }
  return lines.join('\n');
}

/** 生成辅助抽取输入（供 hooks 调用）。 */
export function buildExtractionInput(context) {
  return `${renderWindowForPrompt(context)}\n\n请按协议输出 JSON。`;
}

/** 在候选文本里找与内容最相近的一句真实原句（程序侧证据，不信任模型）。 */
export function findEvidenceQuote(texts, content) {
  const target = normText(content);
  if (target === '') return null;
  let best = null;
  let bestScore = 0;
  for (const text of texts) {
    const source = String(text ?? '');
    if (source.trim() === '') continue;
    const sentences = source.split(/(?<=[。！？!?\n；;])/).map((s) => s.trim()).filter((s) => s.length >= 4);
    for (const sentence of sentences) {
      const sentenceNorm = normText(sentence);
      // 标点/空白差异先按归一化后的精确包含判断；命中就直接当证据。
      if (sentenceNorm.includes(target) || target.includes(sentenceNorm)) {
        return clip(sentence.replace(/\s+/g, ' ').trim(), 120);
      }
      const score = overlapScore(sentenceNorm, target);
      if (score > bestScore) {
        bestScore = score;
        best = sentence;
      }
    }
    const wholeNorm = normText(source);
    if (wholeNorm.includes(target) || target.includes(wholeNorm)) {
      return clip(source.replace(/\s+/g, ' ').trim(), 120);
    }
    const whole = overlapScore(wholeNorm, target);
    if (whole > bestScore) {
      bestScore = whole;
      best = source;
    }
  }
  if (!best || bestScore < 0.55) return null;
  return clip(best.replace(/\s+/g, ' ').trim(), 120);
}

/** 模型给的 evidenceQuote 必须真的出现在原话里；逐字或仅标点/空白差异才算数。 */
function verifyProvidedEvidence(texts, quote) {
  const raw = String(quote ?? '').replace(/\s+/g, ' ').trim()
    .replace(/^["'“”「」『』]+|["'“”「」『』]+$/g, '')
    .trim();
  if (raw.length < 4) return null;
  const target = normText(raw);
  if (target.length < 4) return null;
  for (const text of texts) {
    const source = String(text ?? '');
    if (source.trim() === '') continue;
    if (normText(source).includes(target)) return clip(raw, 120);
  }
  return null;
}

/** 证据原句和抽出来的 content 至少要有实质重叠，防止真原句配假结论。 */
function quoteSupportsContent(quote, content) {
  const left = normText(quote);
  const right = normText(content);
  if (left.length < 2 || right.length < 2) return false;
  return overlapScore(left, right) >= 0.12;
}

/** 归一化后的字符 bigram 包含度（中文短句够用）。 */
function overlapScore(sourceNorm, targetNorm) {
  if (sourceNorm.length < 2 || targetNorm.length < 2) return 0;
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const left = grams(sourceNorm);
  const right = grams(targetNorm);
  let hit = 0;
  for (const gram of left) if (right.has(gram)) hit += 1;
  return hit / Math.min(left.size, right.size);
}

/** 校验并规范化模型输出的单条记忆。 */
function normalizeMemoryOp(op, { sessionId, turn, userTexts, project }) {
  if (!op || typeof op !== 'object') return null;
  const type = String(op.type ?? '').trim();
  if (!MEMORY_TYPES.has(type)) return null;
  const content = clip(String(op.content ?? '').replace(/\s+/g, ' ').trim(), MAX_CONTENT);
  if (content.length < MIN_CONTENT) return null;
  if (FRAGMENT_PREFIX_RE.test(content)) return null;
  if (RAW_QUOTE_AS_FACT_RE.test(content)) return null;
  // 用户事实必须有用户原句证据；关系/偏好等同理。
  if (USER_FACT_TYPES.has(type)) {
    const provided = verifyProvidedEvidence(userTexts, op.evidenceQuote);
    const quote = provided && quoteSupportsContent(provided, content)
      ? provided
      : findEvidenceQuote(userTexts, content);
    if (!quote) return null;
    const confidence = clamp01(op.confidence, 0.7);
    return {
      type,
      content,
      // 「他觉得你很差并为此难受」是当场情绪，不是稳定偏好：压到候选线以下。
      confidence: SPECULATED_EMOTION_RE.test(content) ? Math.min(confidence, 0.6) : confidence,
      importance: clamp01(op.importance, 0.55),
      quote,
      sessionId,
      turn,
      projectId: project?.id ?? null,
      supersedesId: Number.isFinite(Number(op.supersedesId)) && Number(op.supersedesId) > 0 ? Number(op.supersedesId) : null,
    };
  }
  return null;
}

/** 校验项目进展：summary 需与助手/工具内容相关（防止凭空写项目进展）。 */
function normalizeProjectUpdate(op, { assistantTexts, userTexts, project }) {
  if (!op || typeof op !== 'object') return null;
  const summary = clip(String(op.summary ?? '').replace(/\s+/g, ' ').trim(), 160);
  if (summary.length < 6) return null;
  // 项目进展既可能出现在助手「我做了什么」里，也可能是用户亲口说「今天我们做完了 X」。
  // 模型给的 evidenceQuote 先验真，再要求它和 summary 有实质重叠；验不过才退回相似句匹配。
  let quote = verifyProvidedEvidence(assistantTexts, op.evidenceQuote);
  let role = 'assistant';
  if (!quote || !quoteSupportsContent(quote, summary)) {
    const userQuote = verifyProvidedEvidence(userTexts, op.evidenceQuote);
    if (userQuote && quoteSupportsContent(userQuote, summary)) {
      quote = userQuote;
      role = 'user';
    } else {
      quote = findEvidenceQuote(assistantTexts, summary);
      role = 'assistant';
      if (!quote) {
        quote = findEvidenceQuote(userTexts, summary);
        role = quote ? 'user' : '';
      }
    }
  }
  if (!quote) return null;
  return {
    projectId: Number.isFinite(Number(op.projectId)) && Number(op.projectId) > 0 ? Number(op.projectId) : (project?.id ?? 0),
    kind: normalizeJournalKind(op.kind),
    summary,
    confidence: clamp01(op.confidence, 0.6),
    quote,
    role,
  };
}

/** 校验一条行为规则：必须有用户反馈原句作证据，rule 必须是正向表述。 */
function normalizeStyleRule(op, { userTexts, turn }) {
  if (!op || typeof op !== 'object') return null;
  const rule = clip(String(op.rule ?? '').replace(/\s+/g, ' ').trim(), 120);
  if (rule.length < 6) return null;
  if (findForbidden(rule).length > 0) return null;
  const quote = findEvidenceQuote(userTexts, String(op.evidenceQuote ?? ''));
  if (!quote) return null;
  const scene = op.scene === 'work' || op.scene === 'chat' ? op.scene : '';
  const category = clip(String(op.category ?? 'general').trim(), 30) || 'general';
  return {
    rule,
    scene,
    category,
    explicit: op.explicit !== false,
    quote,
    turn: Number(turn) || 0,
  };
}

/** 校验一条语体样本：原句必须在真实对话里出现，且不含禁用表达。 */
function normalizeStyleExample(op, { userTexts, assistantTexts }) {
  if (!op || typeof op !== 'object') return null;
  const text = clip(String(op.text ?? '').replace(/\s+/g, ' ').trim(), 160);
  if (text.length < 8) return null;
  if (findForbidden(text).length > 0) return null;
  const declared = op.kind === 'negative' ? 'negative' : 'positive';
  // 正向锚点只能是「我自己说过的原话」。只在用户那边出现的句子（表白、指令、
  // 复述人格文件）一律降成 borrowed 留档：它仍然可以当参考，但永远不进
  // selectStyleAnchors（那只取 positive），避免把用户的话当成我的语气样本反复贴。
  const assistantQuote = findEvidenceQuote(assistantTexts, text);
  const kind = declared === 'positive' && !assistantQuote ? 'borrowed' : declared;
  const quote = assistantQuote ?? findEvidenceQuote(userTexts, text);
  if (!quote) return null;
  const scene = op.scene === 'work' || op.scene === 'chat' ? op.scene : '';
  return { text, kind, scene, quote };
}

/** 字符 bigram Jaccard，语义落库前拦「换句话说的同一条」。 */
function memorySimilarity(a, b) {
  const grams = (text) => {
    const set = new Set();
    for (let i = 0; i < text.length - 1; i += 1) set.add(text.slice(i, i + 2));
    return set;
  };
  const jaccard = (left, right) => {
    if (left.size === 0 || right.size === 0) return 0;
    let hit = 0;
    for (const gram of left) if (right.has(gram)) hit += 1;
    return hit / (left.size + right.size - hit);
  };
  const plain = (text) => String(text ?? '').toLowerCase().replace(/[\s\p{P}\p{S}]+/gu, '');
  // 「用户希望 / 前辈觉得 / 用户要求」这类同义前缀剥掉后再比一次，取两者较大值：
  // 只剥不取大，会把「两边都写用户希望」这种本该合并的句子反而拉远。
  const stripped = (text) => String(text ?? '').toLowerCase()
    .replace(/^(?:用户|前辈|对方)(?:希望|觉得|表示|要求|不喜欢|喜欢|习惯|明确|会|在|不)/u, '')
    .replace(/[\s\p{P}\p{S}]+/gu, '');
  return Math.max(
    jaccard(grams(plain(a)), grams(plain(b))),
    jaccard(grams(stripped(a)), grams(stripped(b))),
  );
}

/** 找同类型、同状态里最像的一条，命中阈值就并进去，别再长一条近重复。 */
function findSimilarMemory(store, memory) {
  let rows = [];
  try {
    rows = [
      ...store.listMemories({ status: 'active', limit: 200 }),
      ...store.listMemories({ status: 'candidate', limit: 200 }),
    ];
  } catch {
    return null;
  }
  let best = null;
  let bestScore = 0;
  for (const row of rows) {
    if (row.type !== memory.type) continue;
    const score = memorySimilarity(memory.content, row.content);
    if (score > bestScore) {
      bestScore = score;
      best = row;
    }
  }
  return best && bestScore >= 0.45 ? best : null;
}

function clamp01(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(0, Math.min(1, n));
}

/**
 * 校验模型输出（纯函数，便于单测）。
 * @returns {{memories:object[], projectUpdates:object[], rejected:object[]}}
 */
export function validateSemanticResult(json, context = {}) {
  const { sessionId = '', turn = null, turns = [], project = null } = context;
  const userTexts = turns.map((t) => t.userText).filter(Boolean);
  const assistantTexts = turns.map((t) => t.assistantText).filter(Boolean);
  const rawMemories = Array.isArray(json?.memories) ? json.memories : [];
  const rawUpdates = Array.isArray(json?.projectUpdates) ? json.projectUpdates : [];
  const rawStyleRules = Array.isArray(json?.styleRules) ? json.styleRules : [];
  const rawStyleExamples = Array.isArray(json?.styleExamples) ? json.styleExamples : [];
  const memories = [];
  const projectUpdates = [];
  const styleRules = [];
  const styleExamples = [];
  const rejected = [];
  for (const op of rawMemories) {
    const normalized = normalizeMemoryOp(op, { sessionId, turn, userTexts, project });
    if (normalized) memories.push(normalized);
    else rejected.push({ kind: 'memory', content: clip(String(op?.content ?? ''), 80), reason: 'no-user-evidence-or-invalid' });
  }
  for (const op of rawUpdates) {
    const normalized = normalizeProjectUpdate(op, { assistantTexts, userTexts, project });
    if (normalized && normalized.projectId > 0) projectUpdates.push(normalized);
    else rejected.push({ kind: 'project-update', content: clip(String(op?.summary ?? ''), 80), reason: 'no-work-evidence-or-invalid' });
  }
  for (const op of rawStyleRules.slice(0, 4)) {
    const normalized = normalizeStyleRule(op, { userTexts, turn });
    if (normalized) styleRules.push(normalized);
    else rejected.push({ kind: 'style-rule', content: clip(String(op?.rule ?? ''), 80), reason: 'no-user-evidence-or-invalid' });
  }
  for (const op of rawStyleExamples.slice(0, 4)) {
    const normalized = normalizeStyleExample(op, { userTexts, assistantTexts });
    if (normalized) styleExamples.push(normalized);
    else rejected.push({ kind: 'style-example', content: clip(String(op?.text ?? ''), 80), reason: 'no-evidence-or-invalid' });
  }
  // 收敛单回合条数：优先保留稳定类型（决定/问题/完成/计划），其余按模型给出的顺序补足。
  if (projectUpdates.length > MAX_PROJECT_UPDATES) {
    const ranked = projectUpdates
      .map((update, index) => ({ update, index, rank: ARCHIVE_KINDS.has(update.kind) ? 0 : 1 }))
      .sort((a, b) => a.rank - b.rank || a.index - b.index);
    const kept = ranked.slice(0, MAX_PROJECT_UPDATES).sort((a, b) => a.index - b.index).map((entry) => entry.update);
    for (const entry of ranked.slice(MAX_PROJECT_UPDATES)) {
      rejected.push({ kind: 'project-update', content: clip(entry.update.summary, 80), reason: 'over-limit' });
    }
    projectUpdates.length = 0;
    projectUpdates.push(...kept);
  }
  return {
    memories,
    projectUpdates,
    styleRules: styleRules.slice(0, 2),
    styleExamples: styleExamples.slice(0, 2),
    rejected,
  };
}

/**
 * 落库：写入记忆 + 证据 + 项目日志/档案 + 关系变更。
 * @returns {{created:number[], reinforced:number[], superseded:number[], journal:number, projectItems:number, rejected:number, evidence:number}}
 */
export function applySemanticResult(store, {
  sessionId = '',
  turn = null,
  result,
  window = {},
  config = {},
  logger = null,
} = {}) {
  const stats = {
    created: [],
    reinforced: [],
    superseded: [],
    journal: 0,
    projectItems: 0,
    styleRules: 0,
    styleExamples: 0,
    rejected: result?.rejected?.length ?? 0,
    evidence: 0,
  };
  const styleGuardRules = buildForbiddenRules(config?.forbiddenPatterns ?? []);
  const project = window.project ?? null;
  const eventRefs = window.eventRefs ?? {};
  const evidenceRefs = [];
  for (const memory of result?.memories ?? []) {
    try {
      // 语义抽取也可能把助手套话概括进来；这类内容不落库。
      if (findForbidden(String(memory.content ?? '')).length > 0) {
        stats.rejected += 1;
        continue;
      }
      if (memory.supersedesId) {
        // 模型明确说这条取代旧条：写新条后标记旧条，历史可追溯。
        const existing = store.getMemory(memory.supersedesId);
        if (existing && existing.status === 'active') {
          const saved = store.rememberMemory({
            type: memory.type, content: memory.content, tags: 'semantic', source: 'semantic:llm',
            confidence: memory.confidence, importance: memory.importance,
            status: memory.confidence >= 0.8 ? 'active' : 'candidate',
            createdBy: 'assistant', sessionId, projectId: memory.projectId, reason: '语义抽取（纠错）',
            promoteHits: Number(config.candidateHits ?? 2),
          });
          store.supersedeMemory(existing.id, { newId: saved.id, reason: '语义抽取判定被新信息取代' });
          stats.superseded.push(saved.id);
          const ref = buildEvidenceRef(memory, eventRefs);
          stats.evidence += addEvidence(store, saved.id, ref);
          evidenceRefs.push(ref);
          continue;
        }
      }
      const similar = findSimilarMemory(store, memory);
      if (similar) {
        const merged = store.rememberMemory({
          type: similar.type,
          content: similar.content,
          tags: 'semantic',
          source: 'semantic:llm',
          confidence: memory.confidence,
          importance: memory.importance,
          status: similar.status === 'candidate' ? 'candidate' : 'active',
          createdBy: 'user',
          sessionId,
          projectId: similar.projectId ?? memory.projectId ?? project?.id ?? null,
          reason: '语义抽取（近重复合并）',
          promoteHits: Number(config.candidateHits ?? 2),
        });
        const dupRef = buildEvidenceRef(memory, eventRefs);
        stats.evidence += addEvidence(store, merged.id, [dupRef]);
        stats.reinforced.push(merged.id);
        continue;
      }
      const saved = store.rememberMemory({
        type: memory.type,
        content: memory.content,
        tags: 'semantic',
        source: 'semantic:llm',
        confidence: memory.confidence,
        importance: memory.importance,
        status: memory.confidence >= 0.8 ? 'active' : 'candidate',
        createdBy: 'user',
        sessionId,
        projectId: memory.projectId ?? project?.id ?? null,
        reason: '语义抽取',
        promoteHits: Number(config.candidateHits ?? 2),
      });
      const ref = buildEvidenceRef(memory, eventRefs);
      stats.evidence += addEvidence(store, saved.id, [ref]);
      stats.created.push(saved.id);
    } catch (error) {
      logger?.warn?.('语义记忆落库失败：', error?.message ?? error);
    }
  }

  // 反馈沉淀：语义管道也能直接产出一条正向规则/一条原句样本，不再只靠本地正则。
  for (const rule of result?.styleRules ?? []) {
    try {
      if (typeof store.upsertBehaviorRule !== 'function') break;
      const saved = store.upsertBehaviorRule({
        rule: rule.rule,
        scene: rule.scene,
        category: rule.category,
        isExplicit: rule.explicit !== false,
        turnId: Number(rule.turn ?? turn) || 0,
        weight: rule.explicit !== false ? 1.5 : 1,
        source: 'semantic:style',
      });
      if (saved) stats.styleRules += 1;
    } catch (error) {
      logger?.warn?.('语义行为规则落库失败：', error?.message ?? error);
    }
  }
  for (const example of result?.styleExamples ?? []) {
    try {
      const saved = addStyleExample(store, {
        text: example.text,
        kind: example.kind,
        scene: example.scene,
        source: 'semantic:style',
        score: example.kind === 'positive' ? 0.8 : 0.3,
        rules: styleGuardRules,
      });
      if (saved) stats.styleExamples += 1;
      if (saved && example.kind === 'negative') {
        penalizeStyleExamples(store, { text: example.text, scene: example.scene });
      }
    } catch (error) {
      logger?.warn?.('语体样本落库失败：', error?.message ?? error);
    }
  }

  for (const update of result?.projectUpdates ?? []) {
    try {
      const projectId = Number(update.projectId ?? project?.id ?? 0);
      if (!Number.isFinite(projectId) || projectId <= 0) continue;
      const journal = recordJournal(store, {
        projectId,
        sessionId,
        turn,
        kind: update.kind,
        summary: update.summary,
        refs: JSON.stringify(buildJournalRefs(update, eventRefs)),
        confidence: update.confidence,
      });
      if (journal) stats.journal += 1;
      // 只有稳定条目（决定/计划/问题/完成）进项目档案；过程性进展（progress/work/note/idea）
      // 只留在工作日志里，避免项目档案被每轮过程记录淹没（v0.6.2 线上实测单回合 4~5 条）。
      if (ARCHIVE_KINDS.has(update.kind) && config.projectAutoUpdate !== false) {
        try {
          const item = store.addProjectItem(projectId, stableItemKind(update.kind), update.summary, { source: 'semantic' });
          if (item) stats.projectItems += 1;
        } catch {
          // 档案条目去重失败不影响日志。
        }
      }
    } catch (error) {
      logger?.warn?.('项目进展落库失败：', error?.message ?? error);
    }
  }

  return stats;
}

function stableItemKind(kind) {
  if (kind === 'decision') return 'decision';
  if (kind === 'plan') return 'todo';
  if (kind === 'issue') return 'issue';
  if (kind === 'done') return 'done';
  return 'note';
}

function buildEvidenceRef(memory, eventRefs) {
  return {
    sessionId: memory.sessionId ?? '',
    turn: memory.turn,
    eventSeq: eventRefs?.user?.seq ?? null,
    role: 'user',
    quote: memory.quote,
  };
}

function buildJournalRefs(update, eventRefs) {
  return {
    userSeq: eventRefs?.user?.seq ?? null,
    assistantSeq: eventRefs?.assistant?.seq ?? null,
    role: update.role ?? 'assistant',
    quote: update.quote,
  };
}

/** 程序侧兜底：有工具调用的回合，至少记一条「做了什么」到项目日志。 */
export function recordTurnWorkJournal(store, { project, sessionId, turn, userText, assistantText, toolNames = [], toolCalls = 0, assistantSeq = null }) {
  if (!project || project.id <= 0) return null;
  const names = Array.isArray(toolNames) ? toolNames.filter(Boolean) : [];
  const count = names.length > 0 ? names.length : Math.max(0, Number(toolCalls) || 0);
  if (count <= 0) return null;
  const what = names.length > 0
    ? `使用 ${names.slice(0, 3).join('、')}${names.length > 1 ? ` 等 ${names.length} 个工具` : '工具'}`
    : `执行了 ${count} 次工具调用`;
  const summary = clip(`[本轮] ${userText ? clip(userText, 60) : ''} → ${what}`, 160);
  return recordJournal(store, {
    projectId: project.id,
    sessionId,
    turn,
    kind: 'work',
    summary,
    refs: JSON.stringify({ toolNames: names, toolCalls: count }),
    confidence: 0.55,
    assistantSeq,
  });
}
