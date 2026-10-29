/**
 * hooks — 接入宿主生命周期（v0.6）。
 *
 * 两条线：
 *   1. `system-prompt/assemble`：把与当前请求相关的「关系 / 活跃项目 / 相关记忆 / 留下的问题」
 *      压缩成一块短上下文注入（interpolate:false，绝不覆盖宿主系统提示词）；
 *   2. `session/event`：
 *        · user/message：只做「用户明确要求记住」这类高置信度快速落库 + 关系设定解析；
 *        · turn/end：记录回合摘要（原始事实），并把最近几轮交给语义抽取控制器
 *          （lib/memory/extraction.js）在后台做记忆/项目日志抽取。
 *
 * 记忆写入原则（v0.6 起）：
 *   · 正则不再把整段用户消息切片后直接写长期记忆——碎片化记忆的来源就在这里；
 *   · 语义抽取由模型完成，但落库必须经过程序侧校验（证据句、项目证据、碎片过滤）；
 *   · 助手的话不会变成「用户事实」；助手文本只作为项目工作记录的证据。
 *
 * 所有写入都幂等（store 层唯一约束/去重），任何异常只记日志，绝不打断宿主对话。
 * 不记录子代理、委派、团队转述（relay）消息，避免把后台工作的内容当成用户偏好。
 */
import { clip, looksSecret, normText } from './util.js';
import { renderContextBlock } from './memory/render.js';
import {
  extractCandidates,
  detectProjectName,
  guessMemoryType,
  detectConfirmation,
  detectConsensus,
  scoreImportance,
} from './memory/extract.js';
import { maybeRecordProjectNote, activeProject } from './core/project-manager.js';
import { applyRelationshipSignals } from './relationship/continuity.js';
import { addEvidence } from './memory/evidence.js';
import { createExtractionController } from './memory/extraction.js';
import { recordStyle } from './memory/style.js';
import { classifyTurn } from './core/conversation-policy.js';
import { sceneOf } from './core/scene.js';
import { analyzeFeedbackSignal, pickReplySentence } from './style-signal.js';
import { addStyleExample, penalizeStyleExamples } from './memory/style-examples.js';
import { buildForbiddenRules, findForbidden, recordGuardHits, sanitizeAssistantOutput } from './output-guard.js';

/** 单条用户消息最多抽取这么多字，超长的多半是粘贴内容，不当作偏好。 */
const MAX_CAPTURE_CHARS = 1500;
/** 一个回合里 assistant 文本最多留这么多字，够摘要与工作记录证据即可。 */
const MAX_ASSISTANT_CHARS = 3000;
/** 明确要求记住的句子，直接落库（用户已经替我们做了「值得记」的判断）。 */
const EXPLICIT_SOURCES = new Set(['user-explicit', 'user-correction']);
/** 本地规则还能直接写的情况：用户明确的纠正与决定（其余一律交给语义抽取）。 */
const LOCAL_KINDS = new Set(['correction', 'decision']);
/** 碎片前缀：这些不是完整事实，只是列表/标题片段，绝不能写成记忆或项目条目。 */
const FRAGMENT_PREFIX_RE = /^(?:下一步|待办|待办事项|项目|记忆|问题|关系表达尺度|记住|注意|备注|TODO|todo|提示|结论)[:：，,、\s]/u;
/** 工作态判定：只有这些意图算「在干活」，其余回合不注入工作策略。 */
const WORK_KINDS = new Set(['work', 'discussion', 'resume']);
/** 助手明确采纳前辈的说法/金句时，反向把这句话记成正向样本。 */
const ADOPT_RE = /(?:这说法|这个说法|这句|这股劲|这个味).{0,8}(?:我要了|记下了|学到了|收着)|往后照着来|以后就这么说/u;
/** 助手自己认错时，把上一轮那句真的记成负样本，不靠用户再骂一遍。 */
const SELF_BLAME_RE = /拉了就是拉了|确实(?:拉了|垮了|端着了|生硬了)|不狡辩|刚才那句(?:确实|有点)垮/u;
/** 把指定 system section 的文本清空；宿主渲染时会丢弃空 section（renderSystemPrompt 过滤空文本）。 */
function blankSection(assembly, name) {
  const sections = assembly?.sections;
  if (!Array.isArray(sections)) return;
  for (const section of sections) {
    if (section && section.name === name) section.text = '';
  }
}

export function installHooks(ctx, store, config, logger, llm = null, embedder = null, emotion = null, extras = {}) {
  const disposers = [];
  const turnMeta = new Map(); // sessionId -> { turn, startedAt, toolCalls, assistantText, toolNames }
  const injectedAssemblies = new WeakSet();
  /** 语体指标记录器（可选）：没配就整个功能不存在，不写任何文件。 */
  const metrics = extras.metrics?.enabled ? extras.metrics : null;
  /** 本回合实际注入的文本，供结束时和输出一起落盘比对。 */
  const injectionBySession = new Map();
  // v1.6：这一轮注入块的结构化诊断，等 turn/end 落进 wake_log。
  const wakeReports = new Map();

  const extraction = createExtractionController({ store, config, logger, llm });

  /**
   * 补做上次进程遗留的未抽取回合：有配置路由时启动即做；
   * 否则等本进程第一次真实请求捕获到路由后再做（避免误标已抽取）。
   */
  function recoverPendingExtractions() {
    try {
      extraction.recoverPending();
    } catch (error) {
      logger?.warn?.(`恢复遗留回合抽取失败：${error?.message ?? error}`);
    }
  }
  recoverPendingExtractions();
  if (llm && typeof llm === 'object') {
    const previousOnRoute = llm.onRoute;
    llm.onRoute = (route) => {
      try { previousOnRoute?.(route); } catch { /* 忽略 */ }
      recoverPendingExtractions();
    };
  }

  /** 只关心主会话：子代理/委派/团队成员的会话不进入长期记忆。 */
  function isSubagentSession(session) {
    const header = session?.header ?? {};
    if (header.origin === 'subagent' || header.origin === 'delegation') return true;
    if (Number(header.delegationDepth ?? 0) > 0) return true;
    return false;
  }

  function sessionIdOf(session) {
    return String(session?.id ?? session?.header?.id ?? '');
  }

  function sessionHeader(session) {
    return session?.header ?? {};
  }

  function contentText(content) {
    if (!Array.isArray(content)) return typeof content === 'string' ? content : '';
    return content
      .filter((block) => block && block.type === 'text' && typeof block.text === 'string')
      .map((block) => block.text)
      .join('\n')
      .trim();
  }

  function combine() {
    const disposer = () => {
      try {
        extraction.dispose();
      } catch {
        /* 抽取器清理失败不阻塞其他清理 */
      }
      for (const dispose of disposers) {
        try {
          dispose?.();
        } catch {
          /* 卸载失败不阻塞其他清理 */
        }
      }
      disposers.length = 0;
    };
    // 把抽取控制器挂到卸载函数上，供 /soul reextract 复用同一个队列。
    disposer.extraction = extraction;
    return disposer;
  }

  function turnMetaFor(sessionId) {
    let meta = turnMeta.get(sessionId);
    if (!meta) {
      meta = { turn: -1, startedAt: Date.now(), toolCalls: 0, assistantText: '', toolNames: [], guardHits: 0, styleFeedback: '', styleHandledTurnId: 0, styleHandledSignal: '', selfAckDone: false, selfBlameDone: false };
      turnMeta.set(sessionId, meta);
    }
    return meta;
  }

  // ── 1. 注入：每轮组装系统提示词时追加一块相关长期上下文 ─────────────────
  disposers.push(ctx.on('system-prompt/assemble', async (assembly, promptCtx, next) => {
    try {
      if (config.inject !== false && assembly && typeof assembly === 'object') {
        if (injectedAssemblies.has(assembly)) return next();
        injectedAssemblies.add(assembly);
        const session = promptCtx?.agent?.session;
        if (!isSubagentSession(session)) {
          const sessionId = sessionIdOf(session);
          if (sessionId !== '') {
            const state = store.getOrCreateSessionState(sessionId);
            // 工作策略层只在工作态出现：闲聊/玩笑/暧昧时清空，避免工作流程压住语气。
            if (!WORK_KINDS.has(classifyTurn(String(state?.lastUserText ?? '')).kind)) {
              blankSection(assembly, 'dsh-soul:work-policy');
            }
            // 语义检索：先算当前这句话的向量；模型没装好/算不出来就退回字面检索。
            let queryVector = null;
            if (embedder && config.embeddingRetrieval !== false) {
              const queryText = String(state?.lastUserText ?? '').trim();
              if (queryText !== '') {
                try {
                  const vectors = await embedder.embed([queryText]);
                  queryVector = vectors?.[0] ?? null;
                } catch {
                  queryVector = null;
                }
              }
            }
            const report = {};
            const text = renderContextBlock({
              store,
              config,
              sessionId,
              query: state?.lastUserText ?? '',
              queryVector,
              logger,
              report,
            });
            wakeReports.set(sessionId, report);
            if (text !== '') {
              assembly.contexts.push({ name: 'dsh-soul:context', text, interpolate: false });
            }
            if (metrics) injectionBySession.set(sessionId, text);
          }
        }
      }
    } catch (error) {
      logger.warn('注入长期上下文失败：', error?.message ?? error);
    }
    return next();
  }));

  if (config.capture === false) return combine();

  // ── 2. 捕获：会话事件 → 回合记录 / 关系 / 高置信度记忆 / 语义抽取调度 ──────
  disposers.push(ctx.on('session/event', (session, event) => {
    try {
      if (!event || typeof event !== 'object') return;
      if (isSubagentSession(session)) return;
      handleEvent(session, event);
    } catch (error) {
      logger.warn(`会话事件处理失败（${event?.type ?? '?'}）：`, error?.message ?? error);
    }
  }));

  function handleEvent(session, event) {
    const sessionId = sessionIdOf(session);
    if (sessionId === '') return;

    switch (event.type) {
      case 'turn/start': {
        const existing = turnMeta.get(sessionId);
        turnMeta.set(sessionId, {
          turn: Number(event.data?.turn ?? -1),
          startedAt: Date.now(),
          toolCalls: 0,
          assistantText: '',
          toolNames: [],
          guardHits: 0,
          userText: existing?.userText ?? '',
          styleFeedback: '',
          styleHandledTurnId: 0,
          styleHandledSignal: '',
          selfAckDone: false,
          selfBlameDone: false,
        });
        break;
      }
      case 'tool/call': {
        const meta = turnMetaFor(sessionId);
        meta.toolCalls += 1;
        const name = String(event.data?.name ?? '');
        if (name !== '') meta.toolNames.push(name);
        break;
      }
      case 'assistant/message': {
        const meta = turnMetaFor(sessionId);
        const message = event.data?.message;
        const text = contentText(message?.content);
        if (text === '') break;
        // 输出防线：代码块之外命中禁用表达时清洗，并累计 guard_hits。
        const guarded = sanitizeAssistantOutput(text, { config });
        if (guarded.changed) {
          const hits = guarded.hits;
          meta.guardHits += hits.length;
          try { recordGuardHits(store, hits, { logger }); } catch { /* 统计失败不影响输出 */ }
          logger.debug?.(`输出防线清洗 ${hits.length} 处：${hits.map((hit) => hit.key).join('、')}`);
          // 尽量同步改回消息块；宿主不支持时至少保证回合摘要与统计是干净的。
          try {
            if (typeof message?.content === 'string') {
              message.content = guarded.text;
            } else {
              for (const block of Array.isArray(message?.content) ? message.content : []) {
                if (block && block.type === 'text' && typeof block.text === 'string') {
                  const one = sanitizeAssistantOutput(block.text, { config });
                  if (one.changed) block.text = one.text;
                }
              }
            }
          } catch { /* 消息块只读时忽略 */ }
        }
        const clean = sanitizeAssistantOutput(guarded.text, { config }).text;
        if (meta.assistantText.length < MAX_ASSISTANT_CHARS) {
          meta.assistantText = clip(`${meta.assistantText}\n${clean}`.trim(), MAX_ASSISTANT_CHARS);
        }
        // 双向自认领：助手自己说「这说法我要了」/「拉了就是拉了」，不依赖用户再补一刀。
        try { captureAssistantSelfFeedback(store, sessionId, meta, clean); } catch (error) {
          logger.warn('助手自认领落账失败：', error?.message ?? error);
        }
        break;
      }
      case 'user/message': {
        captureUserMessage(session, sessionId, event);
        break;
      }
      case 'turn/end': {
        finishTurn(session, sessionId, event.data);
        break;
      }
      default:
        break;
    }
  }

  /**
   * 本地规则还能直接写记忆的范围（v0.6 收窄）：
   *   · 用户明确要求记住 / 明确纠正 / 明确决定；
   *   · 偏好与画像类候选（「我一般…」「我计划…」「我更喜欢…」）——它们本来就是候选区，
   *     重复出现才转正，风险低。
   * 项目片段、交互偏好、关系事实等一律交给 turn/end 的语义抽取：
   * 这些恰是过去写进碎片记忆（「待办事项」「项目，应能…」）的主要来源。
   */
  const RELATION_CONTENT_RE = /(叫我|喊我|称呼我|我的昵称|叫我做|起个名字)/u;

  function allowedLocalCandidate(candidate) {
    const source = String(candidate.source ?? '');
    if (EXPLICIT_SOURCES.has(source)) return true;
    const kind = String(candidate.kind ?? 'memory');
    const content = String(candidate.content ?? '');
    // 称呼/昵称属于关系设定，由 applyRelationshipSignals 处理，不该进项目档案。
    if ((kind === 'decision' || kind === 'project-note') && RELATION_CONTENT_RE.test(content)) return false;
    if (LOCAL_KINDS.has(kind)) return true;
    if (kind !== 'memory' || candidate.status !== 'candidate') return false;
    const type = String(candidate.type ?? '');
    return type === 'preference' || type === 'profile';
  }

  /**
   * 语体学习闭环的第二环：前辈夸/嫌上一轮的说法时，把上一轮的**原句**存进样本库。
   *
   * 只在信号明确、且上一轮是刚结束的情况下入库（30 分钟内），避免把「这句好」
   * 绑到一段无关的旧回复上。存的是原句，不是「要温柔一点」这类规则。
   */
  function captureStyleSignal(store, sessionId, text) {
    const feedback = analyzeFeedbackSignal(text);
    if (!feedback) return null;
    const latest = store.recentTurns(1, sessionId)[0];
    if (!latest) return null;
    const previousTurnId = Number(latest.id ?? latest.turn ?? 0);
    const meta = turnMetaFor(sessionId);
    // 本回合的反馈只处理一次：user/message 识别到之后，assistant/message 不再补刀。
    if (previousTurnId > 0 && Number(meta.styleHandledTurnId) === previousTurnId) return null;
    if (Date.now() - Number(latest.endedAt ?? 0) > 30 * 60_000) return null;
    const scene = sceneOf(classifyTurn(String(latest.userText ?? '')).kind);
    meta.styleFeedback = feedback.signal;
    meta.styleHandledTurnId = previousTurnId;
    meta.styleHandledSignal = feedback.signal;
    if (feedback.signal === 'praise') {
      const sentence = pickReplySentence(latest.assistantText, { maxChars: 120 });
      if (sentence === '') return null;
      const saved = addStyleExample(store, {
        text: sentence,
        kind: 'positive',
        scene,
        source: 'praise',
        rules: buildForbiddenRules(config?.forbiddenPatterns ?? []),
      });
      if (saved) {
        logger.info(`语体样本入库（夸·${scene}·#${saved.id}）：${clip(sentence, 24)}`);
      }
      return saved;
    }
    // 方向性偏好：只记方向，不追责上一轮——那句回复未必错，只是不够对路。
    if (feedback.signal === 'preference') {
      const rule = store.upsertBehaviorRule({
        rule: feedback.rule,
        scene,
        category: feedback.category,
        isExplicit: feedback.explicit,
        turnId: previousTurnId,
        weight: feedback.strength,
        source: feedback.explicit ? 'user-explicit' : 'user-preference',
      });
      if (rule) logger.info(`偏好规则入库（${feedback.category}·${rule.status}·#${rule.id}）`);
      return rule;
    }
    // 批评不落用户原话：生成正向规则。负样本永远不进注入。
    const saved = store.upsertBehaviorRule({
      rule: feedback.rule,
      scene,
      category: feedback.category,
      isExplicit: feedback.explicit,
      turnId: previousTurnId,
      weight: feedback.strength,
      source: feedback.explicit ? 'user-explicit' : 'user-feedback',
    });
    // 负评归责：只给「文字高度重合」或「上一回合确实注入过」的正样本扣分。
    // 这句被嫌原话只用于内部定位，永远不进注入块。
    const sentence = pickReplySentence(latest.assistantText, { maxChars: 160 });
    if (sentence !== '') {
      addStyleExample(store, {
        text: sentence,
        kind: 'negative',
        scene,
        source: 'criticism',
        score: 0.3,
        rules: buildForbiddenRules(config?.forbiddenPatterns ?? []),
      });
      const injectedSince = Number(latest.startedAt ?? 0) > 0
        ? Number(latest.startedAt) - 2 * 60_000
        : 0;
      const penalized = penalizeStyleExamples(store, {
        text: sentence,
        scene,
        turnId: previousTurnId,
        injectedSince,
        logger,
      });
      if (penalized.length > 0) {
        logger.info(`负评扣分（${scene}·#${penalized[0].id}·score ${penalized[0].score}·${penalized[0].attribution}）`);
      } else {
        logger.info('负评未命中可归责样本，不扣分');
      }
    }
    if (saved) {
      logger.info(`行为规则入库（${feedback.category}·${saved.status}·#${saved.id}·证据${saved.evidenceCount}）`);
    }
    return saved;
  }

  /**
   * 助手自认领：用户没夸，但助手自己说「这说法我要了」，也算一次明确的采纳；
   * 用户没骂，但助手自己说「拉了就是拉了」，也算一次明确的认错。
   * 这样语体学习不必依赖用户每轮都补一句反馈。
   */
  function captureAssistantSelfFeedback(store, sessionId, meta, text) {
    const latest = store.recentTurns(1, sessionId)[0];
    if (!latest) return null;
    const previousTurnId = Number(latest.id ?? latest.turn ?? 0);
    // 用户本轮已经给过明确反馈（夸/批），助手自评不再补一份证据。
    if (previousTurnId > 0 && Number(meta.styleHandledTurnId) === previousTurnId) return null;
    if (Date.now() - Number(latest.endedAt ?? 0) > 30 * 60_000) return null;
    const scene = sceneOf(classifyTurn(String(meta.userText || latest.userText || '')).kind);
    const rules = buildForbiddenRules(config?.forbiddenPatterns ?? []);
    if (!meta.selfAckDone && ADOPT_RE.test(text) && meta.styleFeedback !== 'praise') {
      meta.selfAckDone = true;
      // 自采纳只是「助手觉得这句话好」，不是用户认可的证据。
      // 用户的好措辞只作为 borrowed 参考留档，永远不进 positive 锚点；
      // 行为规则只提候选，等用户明确肯定或第二次独立出现再升级。
      const userLine = pickReplySentence(meta.userText || latest.userText, { maxChars: 160 });
      const sample = userLine === '' ? null : addStyleExample(store, {
        text: userLine,
        kind: 'borrowed',
        scene,
        source: 'self-adopt',
        score: 0.5,
        rules,
      });
      const rule = store.upsertBehaviorRule({
        rule: '沿用前辈认可的说法与劲头，不改成公文腔或空洞金句',
        scene,
        category: 'adopted_phrase',
        isExplicit: false,
        turnId: previousTurnId,
        weight: 1,
        source: 'self-adopt',
        candidateOnly: true,
      });
      if (sample) logger.info(`参考措辞留档（自采纳·${scene}·#${sample.id}）：${clip(userLine, 24)}`);
      return { sample, rule };
    }
    if (!meta.selfBlameDone && SELF_BLAME_RE.test(text)) {
      meta.selfBlameDone = true;
      // 自认错同样不能给自己扣分：只沉淀待验证的候选规则。
      const rule = store.upsertBehaviorRule({
        rule: '直白自然接话，不端架子、不套公文腔与空洞金句',
        scene,
        category: 'flat_tone',
        isExplicit: false,
        turnId: previousTurnId,
        weight: 1,
        source: 'self-blame',
        candidateOnly: true,
      });
      return { rule };
    }
    return null;
  }

  function captureUserMessage(session, sessionId, event) {
    const data = event?.data ?? {};
    const source = data?.source ?? {};
    const sourceKind = String(source.kind ?? '');
    // 桌面/Web 是 user；QQ 通道（OneBot）以 plugin:dsh-onebot 注入用户消息。
    // v3 前只认 user，导致 onebot 会话 105 轮 user_text 全空、提炼没有用户证据。
    if (sourceKind !== 'user' && sourceKind !== 'plugin:dsh-onebot') return;
    if (source.form === 'relay') return; // 团队/委派转述，不是用户本人说的
    const text = contentText(data?.content);
    if (text === '') return;

    store.markSession(sessionId, {
      origin: String(sessionHeader(session).origin ?? ''),
      cwd: String(sessionHeader(session).cwd ?? ''),
    });
    store.setSessionState(sessionId, { lastUserText: clip(text, 200) });
    // 说话习惯统计（句长/表情/口头禅）：本地零成本，只用来调语气，不写长期记忆。
    try { recordStyle(store, text); } catch { /* 统计失败不影响对话 */ }
    // 语体学习：前辈夸/嫌上一轮的说法 → 原句入库（不写规则、不写人格）。
    try { captureStyleSignal(store, sessionId, text); } catch (error) { logger.warn('语体样本记录失败：', error?.message ?? error); }
    // 情绪判定（v1.3）：防抖 2 秒后异步判，不阻塞这一轮回复。
    try { emotion?.consider?.({ text, sessionId }); } catch { /* 判定失败不影响对话 */ }
    const meta = turnMetaFor(sessionId);
    meta.userText = clip(text, MAX_CAPTURE_CHARS);
    meta.userSeq = Number(event?.seq ?? meta.userSeq ?? 0) || null;

    // 会话里第一次明确提到项目时自动建档并设为活跃项目：
    // 项目记忆需要一个容器，否则后续的决定/待办没有地方归档。
    if (config.projectAutoUpdate !== false) {
      try {
        if (!activeProject(store, sessionId)) {
          const name = detectProjectName(text);
          if (name) {
            const project = store.upsertProject({ name, source: 'auto' });
            store.setSessionState(sessionId, { activeProjectId: project.id });
            logger.info(`自动建档项目「${project.name}」#${project.id}，并设为当前活跃项目`);
          }
        }
      } catch (error) {
        logger.warn('自动建档项目失败：', error?.message ?? error);
      }
    }

    // 称呼/边界/梗等关系设定：即使消息很长也值得识别（只动关系表）。
    try {
      const applied = applyRelationshipSignals(store, { sessionId, text, source: 'auto' });
      if (applied.length > 0) logger.info(`关系设定更新：${applied.join('；')}`);
    } catch (error) {
      logger.warn('关系设定更新失败：', error?.message ?? error);
    }

    // 用户明确确认（「对，就是这样」「就这么办」）→ 把本会话最近的候选记忆转正。
    if (detectConfirmation(text)) {
      try {
        const promoted = store.promoteSessionCandidates({
          sessionId,
          since: Date.now() - 30 * 60_000,
          limit: Number(config.candidateConfirmLimit ?? 3),
        });
        if (promoted.length > 0) {
          logger.info(`用户确认：候选记忆转正 ${promoted.length} 条（${promoted.map((m) => `#${m.id}`).join('、')}）`);
        }
      } catch (error) {
        logger.warn('候选记忆转正失败：', error?.message ?? error);
      }
    }

    // 多轮讨论后的拍板：先写成候选记忆（语义抽取随后会看到同一句话，做去重与项目更新）。
    if (config.consensusExtraction !== false) {
      try {
        const consensus = recordMultiTurnConsensus(sessionId, text);
        if (consensus) {
          logger.info(`多轮共识：${clip(consensus.memory.content, 60)}${consensus.projectNote ? `（项目条目 ${consensus.projectNote.kind}）` : ''}`);
        }
      } catch (error) {
        logger.warn('共识记录失败：', error?.message ?? error);
      }
    }

    // 判断结果的自动记录（v0.7 主动性）：假设由模型自己用 soul_judge 记；这里只在用户
    // 明确纠正/确认时，把本会话最近一条还悬着的判断标上结果——框架只记结果，不产生判断。
    try {
      const corrected = text.includes('我的意思是') || /^(?:不是|不对|错了|搞错)/.test(text);
      // 「确认」用比候选转正更宽的口语识别（只认短句），否则「对/嗯」这类答复没法结算判断。
      const confirmed = text.length <= 40 && /^(?:对|是的|没错|嗯|可以|就这样|就是这个意思)/u.test(text);
      const cue = corrected ? 'wrong' : (confirmed ? 'right' : '');
      if (cue !== '') {
        const pending = store.listJudgments({ outcome: 'open', sessionId, limit: 1 })
          .find((item) => item.updatedAt >= Date.now() - 10 * 60_000);
        if (pending) {
          store.resolveJudgment(pending.id, {
            outcome: cue,
            note: cue === 'right' ? '（自动推测）他应了一声，不一定是确认' : '（自动推测）他好像纠正了一句',
          });
          logger.debug(`判断 #${pending.id} 标记为${cue === 'right' ? '对' : '错'}`);
        }
      }
    } catch { /* 判断记录失败不影响对话 */ }

    // ── 3. 本地快速通道：只处理用户明确要求记住、纠正、明确决定；其它候选与记忆碎片一律丢弃，
    //       等 turn/end 后的语义抽取统一判断（避免把列表片段、条件句写成长期记忆）。
    if (text.length > MAX_CAPTURE_CHARS || looksSecret(text)) return;
    for (const candidate of extractCandidates(text)) {
      try {
        if (!allowedLocalCandidate(candidate)) continue;
        const saved = handleCandidate(sessionId, candidate);
        if (saved?.id) {
          addEvidence(store, saved.id, [{
            sessionId,
            turn: meta.turn >= 0 ? meta.turn : null,
            seq: meta.userSeq ?? null,
            role: 'user',
            quote: clip(text, 160),
          }]);
        }
      } catch (error) {
        logger.warn('候选记忆写入失败：', error?.message ?? error);
      }
    }
  }

  /** 近邻去重/冲突检查用的相似记忆池：最近记忆 + 全部候选（数量有上限，代价可控）。 */
  function similarPool() {
    const pool = new Map();
    for (const memory of store.listMemories({ limit: 120 })) pool.set(memory.id, memory);
    for (const memory of store.listCandidates(60)) pool.set(memory.id, memory);
    return [...pool.values()];
  }

  function findSimilar(content, type) {
    let best = null;
    let bestScore = 0;
    for (const memory of similarPool()) {
      const sameType = !type || memory.type === type;
      const score = similarity(memory.content, content);
      if (!sameType && score < 0.9) continue;
      if (score > bestScore) {
        bestScore = score;
        best = memory;
      }
    }
    return best ? { memory: best, score: bestScore } : null;
  }

  function isFragment(content) {
    return FRAGMENT_PREFIX_RE.test(content) || content.length < 4;
  }

  /** 返回被写入/强化的记忆行（用于补证据）；没有写入时返回 null。 */
  function handleCandidate(sessionId, candidate) {
    const content = String(candidate.content ?? '').trim();
    if (content.length < 2 || looksSecret(content)) return null;
    const source = String(candidate.source ?? 'auto');
    // 自动抽取渠道不接纳助手口径的禁用套话；用户明确要求记住的句子仍按原样保留。
    if (source !== 'user-explicit' && findForbidden(content).length > 0) return null;
    const isCandidate = candidate.status === 'candidate';

    if (candidate.kind === 'project-note') {
      if (config.projectAutoUpdate === false || isFragment(content)) return null;
      const saved = maybeRecordProjectNote(store, sessionId, content);
      if (saved) logger.info(`项目「${saved.project.name}」记录一条 ${saved.kind}：${clip(content, 60)}`);
      return null;
    }

    if (isFragment(content) && source !== 'user-explicit') return null;

    const type = candidate.type || guessMemoryType(content);
    const importance = Number(candidate.importance ?? scoreImportance(content, { source, kind: candidate.kind }));
    const nearDup = Number(config.nearDuplicateThreshold ?? 0.7);
    const conflict = Number(config.conflictThreshold ?? 0.5);
    const promoteHits = Number(config.candidateHits ?? 2);

    // 1) 用户纠正：写新版本，并把相似的旧版本标为 superseded（历史可追溯）。
    if (candidate.kind === 'correction') {
      const similar = findSimilar(content, type);
      const saved = store.rememberMemory({
        type, content, importance, status: 'active', tags: candidate.tags, source,
        confidence: Number(candidate.confidence ?? 0.85), sessionId,
        reason: '用户纠正', promoteHits,
      });
      if (similar && similar.score >= Number(config.correctionThreshold ?? 0.22)) {
        store.supersedeMemory(similar.memory.id, { newId: saved.id, reason: '用户纠正后由新版本取代' });
        logger.info(`纠正记忆：#${similar.memory.id}「${clip(similar.memory.content, 40)}」→ #${saved.id}「${clip(content, 40)}」`);
      }
      return saved;
    }

    const similar = findSimilar(content, type);

    // 2) 近似重复：强化旧条目（命中+1、取更长内容），候选重复够次数就转正。
    if (similar && similar.score >= nearDup) {
      const reinforced = store.reinforceMemory(similar.memory.id, {
        confidence: candidate.confidence,
        importance,
        content,
      });
      if (reinforced?.status === 'candidate' && reinforced.hits >= promoteHits) {
        const promoted = store.promoteCandidate(reinforced.id, '重复出现后转正');
        if (promoted) logger.info(`候选记忆 #${promoted.id} 重复出现 ${promoted.hits} 次，转为正式记忆：${clip(promoted.content, 60)}`);
      }
      return reinforced;
    }

    // 3) 与已有正式记忆冲突：以新信息为准，旧版本 superseded。
    if (!isCandidate && similar && similar.score >= conflict && similar.memory.status === 'active') {
      const saved = store.rememberMemory({
        type, content, importance, status: 'active', tags: candidate.tags, source,
        confidence: Number(candidate.confidence ?? 0.6), sessionId,
        reason: '更新已有记忆', promoteHits,
      });
      store.supersedeMemory(similar.memory.id, { newId: saved.id, reason: '新信息更新了旧版本' });
      logger.info(`记忆更新：#${similar.memory.id}「${clip(similar.memory.content, 40)}」→ #${saved.id}「${clip(content, 40)}」`);
      return saved;
    }

    // 4) 决定同时进项目记忆：决定是项目状态的一部分，只留在全局记忆里，恢复项目时就找不到了。
    if (candidate.kind === 'decision' && config.projectAutoUpdate !== false && !isFragment(content)) {
      try {
        const savedNote = maybeRecordProjectNote(store, sessionId, content);
        if (savedNote) logger.info(`项目「${savedNote.project.name}」记录一条 ${savedNote.kind}：${clip(content, 60)}`);
      } catch (error) {
        logger.warn('项目决定归档失败：', error?.message ?? error);
      }
    }

    const saved = store.rememberMemory({
      type, content, importance,
      status: isCandidate ? 'candidate' : 'active',
      tags: candidate.tags, source,
      confidence: Number(candidate.confidence ?? 0.6), sessionId,
      reason: source === 'user-explicit' ? '用户明确要求记住' : '',
      promoteHits,
    });
    logger.debug(`记下 ${saved.status === 'candidate' ? '候选' : type} #${saved.id}：${clip(content, 60)}`);
    return saved;
  }

  /**
   * 多轮讨论后的共识：只有会话里已记录过至少 consensusMinTurns 个真实回合，
   * 并且存在讨论上下文（活跃项目或未解决的问题）时，才把「就这么定」当成共识。
   * 记忆先进候选区（重复出现/再次确认/手动 approve 才转正）；项目决定条目直接可见。
   */
  function recordMultiTurnConsensus(sessionId, text) {
    const marker = detectConsensus(text);
    if (!marker) return null;
    const minTurns = Math.max(1, Number(config.consensusMinTurns ?? 2));
    const turns = store.recentTurns(20, sessionId).filter((turn) => String(turn.userText ?? '').trim() !== '');
    if (turns.length < minTurns) return null;
    const state = store.getSessionState(sessionId);
    const project = state?.activeProjectId ? store.getProject(state.activeProjectId) : null;
    const openQuestion = String(state?.openQuestion ?? '').trim();
    if (!project && openQuestion === '') return null;
    // 话题来源只用「用户自己说过的话」：未解决问题 → 用户这句拍板话 → 项目名；
    // 绝不用助手的最近一句，避免把助手措辞写成用户共识。
    const lastText = clip(String(text ?? '').replace(/\s+/g, ' ').trim(), 90);
    const topic = openQuestion || lastText || (project ? `${project.name}：${project.goal || project.stage || ''}` : '');
    if (!topic) return null;
    const content = clip(`讨论后定下：${topic}`, 120);
    const memory = store.rememberMemory({
      type: 'episodic',
      content,
      importance: scoreImportance(content, { source: 'multi-turn-consensus', kind: 'consensus' }),
      status: 'candidate',
      tags: 'consensus multi-turn',
      source: 'multi-turn-consensus',
      confidence: 0.62,
      sessionId,
      projectId: project?.id ?? null,
      reason: `多轮讨论后拍板（${marker}）`,
      promoteHits: Number(config.candidateHits ?? 2),
    });
    if (openQuestion !== '') {
      try {
        store.setSessionState(sessionId, { openQuestion: '' });
      } catch {
        /* 状态清理失败不影响记忆写入 */
      }
    }
    let projectNote = null;
    if (config.projectAutoUpdate !== false) {
      try {
        projectNote = maybeRecordProjectNote(store, sessionId, `决定：${clip(topic, 90)}`);
        if (projectNote) logger.info(`项目「${projectNote.project.name}」记录一条 ${projectNote.kind}：${clip(topic, 60)}`);
      } catch (error) {
        logger.warn('共识归档到项目失败：', error?.message ?? error);
      }
    }
    return { memory, projectNote, marker };
  }

  /**
   * v1.6 可观测：把这一轮的唤醒链路元数据落一行（只有 ID、原因码、长度、预算，不存正文）。
   * 写失败只记日志——诊断坏了不能拖累回复。
   */
  function writeWakeLog(sessionId, turn, report) {
    if (!report || typeof store.appendWakeLog !== 'function') return;
    try {
      const excludedIds = (Array.isArray(report.excluded) ? report.excluded : []).map((item) => Number(item?.id));
      const candidates = [...new Set([...(report.injectedIds ?? []), ...excludedIds])]
        .filter((id) => Number.isFinite(id) && id > 0);
      store.appendWakeLog({
        turnId: Number.isFinite(Number(turn)) ? Number(turn) : -1,
        sessionId,
        at: Date.now(),
        version: String(store.metaGet?.('plugin.version') ?? ''),
        mode: String(report.mode ?? ''),
        path: String(report.path ?? 'none'),
        cache: String(report.cache ?? 'off'),
        candidates,
        // 淘汰明细随 filtered 一起落：计数容易算，但要能查到是哪条、为什么。
        filtered: {
          ...(report.filtered ?? {}),
          excluded: (Array.isArray(report.excluded) ? report.excluded : []).slice(0, 60).map((item) => ({ id: Number(item?.id), reason: String(item?.reason ?? '') })),
          removedSections: Array.isArray(report.removedSections) ? report.removedSections : [],
        },
        injectedIds: report.renderedIds ?? report.injectedIds ?? [],
        overBudgetIds: report.overBudgetIds ?? [],
        sectionChars: report.sections ?? {},
        budgetUsed: Number(report.budgetUsed ?? 0),
        budgetTotal: Number(report.budget?.total ?? 0),
        rendered: report.rendered === true,
        degraded: String(report.degraded ?? ''),
        ms: Number(report.ms ?? 0),
      });
    } catch (error) {
      logger.warn('记忆唤醒日志写入失败：', error?.message ?? error);
    } finally {
      wakeReports.delete(sessionId);
    }
  }

  function finishTurn(session, sessionId, data) {
    const meta = turnMeta.get(sessionId) ?? {
      turn: Number(data?.turn ?? -1),
      startedAt: Date.now(),
      toolCalls: 0,
      assistantText: '',
      toolNames: [],
    };
    turnMeta.delete(sessionId);
    const turn = Number.isFinite(Number(data?.turn)) ? Number(data.turn) : meta.turn;
    const reason = String(data?.reason?.kind ?? '');
    const userText = String(meta.userText || store.getSessionState(sessionId)?.lastUserText || '');
    // 只记录原始回合事实；记忆/项目日志的抽取交给 extraction（语义管道，见上）。
    store.recordTurn({
      sessionId,
      turn,
      userText: clip(userText, MAX_CAPTURE_CHARS),
      assistantText: clip(meta.assistantText, MAX_ASSISTANT_CHARS),
      toolCalls: meta.toolCalls,
      reason,
      startedAt: meta.startedAt,
      endedAt: Date.now(),
      origin: String(sessionHeader(session).origin ?? ''),
      cwd: String(sessionHeader(session).cwd ?? ''),
    });
    writeWakeLog(sessionId, turn, wakeReports.get(sessionId));
    // 最后一道防线：只在前一步漏网时补扫（例如宿主直接写了 assistant 文本而未发消息事件）。
    const finalGuard = sanitizeAssistantOutput(meta.assistantText, { config });
    if (finalGuard.changed) {
      try { recordGuardHits(store, finalGuard.hits, { logger }); } catch { /* 忽略 */ }
      logger.debug?.(`回合收尾补清洗 ${finalGuard.hits.length} 处`);
    }
    if (metrics) {
      // 语体基线：注入块 + 我的实际输出 + 这一轮是什么类型，一行落盘，失败不影响对话。
      try {
        const origin = String(sessionHeader(session).origin ?? '');
        metrics.record({
          sessionId,
          turn,
          origin: origin === 'onebot' || sessionId.startsWith('onebot') ? 'qq' : 'gui',
          intent: classifyTurn(userText).kind,
          userText,
          injection: injectionBySession.get(sessionId) ?? '',
          reply: meta.assistantText,
        });
      } catch (error) {
        logger.warn('语体指标记录失败：', error?.message ?? error);
      }
      injectionBySession.delete(sessionId);
    }
    if (Number(meta.guardHits ?? 0) > 0) {
      store.metaSet('guard_hits.last_turn', JSON.stringify({ turn, count: meta.guardHits, at: Date.now() }));
    }
    if (Number.isFinite(turn)) {
      extraction.considerTurn(session, sessionId, turn);
    }
  }

  return combine();
}

/**
 * 字符 bigram 相似度（中文短文本够用，不引入分词器）。
 * 取「Jaccard」与「包含度（交/较短句）」的较大者：
 * 纠正句常带「不对，」之类前缀，Jaccard 会被拉低（Python→TypeScript 只剩 0.2），
 * 但旧句的 bigram 大多被新句包含，包含度约 0.45，才能可靠认出旧版本。
 */
function similarity(a, b) {
  const bigrams = (text) => {
    const normalized = normText(text);
    const out = new Set();
    for (let i = 0; i < normalized.length - 1; i += 1) out.add(normalized.slice(i, i + 2));
    return out;
  };
  const left = bigrams(a);
  const right = bigrams(b);
  if (left.size === 0 || right.size === 0) return 0;
  let intersection = 0;
  for (const gram of left) if (right.has(gram)) intersection += 1;
  const union = left.size + right.size - intersection;
  const jaccard = intersection / union;
  const containment = intersection / Math.min(left.size, right.size);
  return Math.max(jaccard, containment * 0.65);
}
