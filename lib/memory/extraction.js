/**
 * extraction — 回合结束后的语义记忆抽取控制器（v0.6）。
 *
 * 与旧版的关键区别：
 *   · 旧版在 user/message 上用正则把用户消息切成片段直接落库（容易写出「待办事项」这类碎片）；
 *   · 新版在 turn/end 后，把最近几轮真实对话（用户原话 + 助手做了什么 + 工具调用）交给模型做
 *     语义抽取，得到「候选记忆 / 项目工作记录」的结构化 JSON，再由程序侧校验后才落库；
 *   · 程序侧校验（见 semantic.js）才是最终裁判：模型给出的 user 事实必须能在用户原话里找到
 *     证据句，项目更新必须能在助手文本里找到依据，碎片前缀直接拒绝；
 *   · 模型不可用、调用失败、超时、JSON 不合法时一律降级：不写任何记忆、只按工具调用记录
 *     程序侧项目工作日志（recordTurnWorkJournal），绝不在失败时猜测写入。
 *
 * 成本控制：
 *   · 每回合结束 debounce（默认 2.5s），连续回合只跑一次；
 *   · 同一会话两次抽取之间至少间隔 extractMinIntervalMs（默认 15s）；
 *   · 全局串行（同一时间最多一个抽取请求），避免并发时 token 峰值；
 *   · 单回合窗口固定提取最近 extractWindowTurns（默认 3）轮，prompt 有硬上限；
 *   · 已被抽取过的回合（turns.extracted_at）不重复抽取。
 *
 * 失败与关闭：所有异常只记日志/统计，不抛出到宿主事件循环；dispose() 清空定时器与队列。
 */
import {
  SEMANTIC_SYSTEM_PROMPT,
  buildExtractionInput,
  validateSemanticResult,
  applySemanticResult,
  recordTurnWorkJournal,
} from './semantic.js';
import { projectAttribution } from './journal.js';
import { clip } from '../util.js';

const FALLBACK = {
  windowTurns: 3,
  debounceMs: 2500,
  minIntervalMs: 15000,
  maxTokens: 900,
  timeoutMs: 30000,
  maxCallsPerHour: 12,
  recoverBatch: 3,
  recoverCooldownMs: 600000,
  maxAttempts: 5,
};

function numberOr(value, fallback) {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

export function createExtractionController({ store, config = {}, logger = null, llm = null } = {}) {
  const buffers = new Map(); // sessionId -> { timer }
  const queue = []; // { sessionId, session, turn }
  const pending = new Set(); // `sessionId#turn`：同一回合只入队一次，避免补做日志/模型调用重复
  const state = {
    runs: 0,
    ok: 0,
    failed: 0,
    skipped: 0,
    journalFallbacks: 0,
    backoff: 0,
    deferred: 0,
    lastAt: 0,
    lastError: '',
    lastTurn: null,
  };
  let disposed = false;
  let pumping = false;
  let lastLlmAt = 0;
  let callTimes = []; // 最近一小时内的模型调用时刻，用来数「每小时预算」
  let lastRecoverAt = 0; // 上次补做遗留回合的时刻（冷却用）
  let lastBudgetLogAt = 0;
  let resumeTimer = null;

  function log(level, ...args) {
    try {
      logger?.[level]?.(...args);
    } catch {
      /* 日志失败不影响主流程 */
    }
  }

  function settings() {
    return {
      windowTurns: Math.max(1, numberOr(config.extractWindowTurns, FALLBACK.windowTurns)),
      debounceMs: Math.max(0, numberOr(config.extractDebounceMs, FALLBACK.debounceMs)),
      minIntervalMs: Math.max(0, numberOr(config.extractMinIntervalMs, FALLBACK.minIntervalMs)),
      maxTokens: Math.max(200, numberOr(config.extractMaxTokens, FALLBACK.maxTokens)),
      timeoutMs: Math.max(5000, numberOr(config.extractTimeoutMs, FALLBACK.timeoutMs)),
      // v1.4 预算与退避：把「一次抽取占多少模型调用」这件事写死成可数的上限。
      maxCallsPerHour: Math.max(1, numberOr(config.extractMaxCallsPerHour, FALLBACK.maxCallsPerHour)),
      recoverBatch: Math.max(1, numberOr(config.extractRecoverBatch, FALLBACK.recoverBatch)),
      recoverCooldownMs: Math.max(0, numberOr(config.extractRecoverCooldownMs, FALLBACK.recoverCooldownMs)),
      maxAttempts: Math.max(1, numberOr(config.extractMaxAttempts, FALLBACK.maxAttempts)),
    };
  }

  /** 剪掉一小时之前的调用记录，返回当前小时的调用次数。 */
  function callsLastHour(now = Date.now()) {
    const cutoff = now - 3_600_000;
    callTimes = callTimes.filter((stamp) => stamp > cutoff);
    return callTimes.length;
  }

  function budgetLeft(now = Date.now()) {
    return settings().maxCallsPerHour - callsLastHour(now);
  }

  function formatDelay(ms) {
    if (ms >= 3_600_000) return `${Math.round(ms / 3_600_000)} 小时`;
    if (ms >= 60_000) return `${Math.round(ms / 60_000)} 分钟`;
    return `${Math.round(ms / 1000)} 秒`;
  }

  /**
   * 失败退避阶梯：30s → 2min → 10min → 30min → 1h；到达 maxAttempts 之后推到 24h，
   * 让一条抽不出东西的回合一天最多再试一次，而不是每个路由事件都打一次模型。
   */
  function backoffFor(attempts) {
    const { maxAttempts } = settings();
    if (attempts >= maxAttempts) return 24 * 3_600_000;
    const ladder = [30_000, 120_000, 600_000, 1_800_000, 3_600_000];
    return ladder[Math.min(attempts, ladder.length) - 1] ?? 3_600_000;
  }

  /** 预算用尽时留一个定时器回来：队列不丢、也不靠宿主事件触发。 */
  function scheduleResume() {
    if (resumeTimer || disposed) return;
    resumeTimer = setTimeout(() => {
      resumeTimer = null;
      pump().catch((error) => log('warn', `语义抽取队列恢复异常：${error?.message ?? error}`));
    }, 60_000);
    resumeTimer.unref?.();
  }

  function enabled() {
    if (config.capture === false) return false;
    return String(config.memoryExtraction ?? 'llm') !== 'off';
  }

  function persistStats() {
    try {
      store.metaSet('extraction.stats', JSON.stringify({ ...state }));
    } catch {
      /* 统计写入失败不影响抽取本身 */
    }
  }

  function bufferFor(sessionId) {
    let buffer = buffers.get(sessionId);
    if (!buffer) {
      buffer = { timer: null };
      buffers.set(sessionId, buffer);
    }
    return buffer;
  }

  function clearBufferTimer(sessionId) {
    const buffer = buffers.get(sessionId);
    if (buffer?.timer) {
      clearTimeout(buffer.timer);
      buffer.timer = null;
    }
  }

  function sleep(ms) {
    return new Promise((resolve) => {
      const timer = setTimeout(resolve, Math.max(0, ms));
      timer.unref?.();
    });
  }

  /** 回合结束：debounce 后入队；返回 false 表示这次不抽（关闭/已抽取/被吞）。 */
  function considerTurn(session, sessionId, turn) {
    if (disposed || !enabled() || !sessionId || !Number.isFinite(Number(turn))) return false;
    if (store.isTurnExtracted(sessionId, turn)) {
      state.skipped += 1;
      return false;
    }
    clearBufferTimer(sessionId);
    const { debounceMs } = settings();
    if (debounceMs <= 0) {
      enqueue(session, sessionId, turn);
      return true;
    }
    const buffer = bufferFor(sessionId);
    buffer.timer = setTimeout(() => {
      buffer.timer = null;
      enqueue(session, sessionId, turn);
    }, debounceMs);
    buffer.timer.unref?.();
    return true;
  }

  function enqueue(session, sessionId, turn) {
    if (disposed) return;
    const key = `${sessionId}#${Number(turn)}`;
    if (pending.has(key)) return;
    pending.add(key);
    queue.push({ key, session, sessionId, turn: Number(turn) });
    pump().catch((error) => log('warn', `语义抽取队列异常：${error?.message ?? error}`));
  }

  async function pump() {
    if (pumping || disposed) return;
    pumping = true;
    try {
      while (queue.length > 0 && !disposed) {
        // 每小时调用预算用尽就先停手：队列留着，一分钟后自己回来，不丢活也不空转。
        if (budgetLeft() <= 0) {
          state.deferred += queue.length;
          const now = Date.now();
          if (now - lastBudgetLogAt > 60_000) {
            lastBudgetLogAt = now;
            log('info', `语义抽取本小时调用已达上限（${settings().maxCallsPerHour} 次），剩余 ${queue.length} 个回合排队等待`);
          }
          scheduleResume();
          break;
        }
        const job = queue.shift();
        let spent = false;
        try {
          spent = await processJob(job);
        } finally {
          pending.delete(job.key ?? `${job.sessionId}#${job.turn}`);
        }
        if (spent) {
          const { minIntervalMs } = settings();
          const wait = lastLlmAt + minIntervalMs - Date.now();
          if (wait > 0) await sleep(wait);
        }
      }
    } finally {
      pumping = false;
      persistStats();
    }
  }

  function skipReason(turns, turn) {
    const current = (turns ?? []).find((row) => Number(row.turn) === Number(turn));
    if (!current) return 'no-turn';
    const userText = String(current.userText ?? '').trim();
    const assistantText = String(current.assistantText ?? '').trim();
    const toolCalls = Number(current.toolCalls ?? 0);
    if (userText === '' && assistantText === '') return 'empty';
    if (
      userText.length < 6
      && toolCalls === 0
      && !/记住|记一下|记着|以后|别再|我喜欢|我讨厌|我计划|我习惯|叫我/.test(userText)
    ) {
      return 'trivial';
    }
    return '';
  }

  /** 失败也要留下可追的痕迹：写 meta，不标 extracted_at，下一轮/重启还能补。 */
  function recordFailure(sessionId, turn, reason, detail = '') {
    try {
      store.metaSet('extraction.last_error', JSON.stringify({
        at: Date.now(),
        sessionId,
        turn,
        reason: String(reason ?? 'unknown'),
        detail: clip(String(detail ?? ''), 300),
      }));
    } catch { /* 记录失败不影响主流程 */ }

    // v1.4：失败必须落一个退避点。以前只写 meta、不标记回合，
    // 于是下一个 llm.onRoute 事件又把同一条回合捞回来重试，没有上限。
    try {
      const current = typeof store.turnExtractState === 'function'
        ? store.turnExtractState(sessionId, turn)
        : { attempts: 0 };
      const attempts = Math.max(1, Number(current?.attempts ?? 0) + 1);
      const delay = backoffFor(attempts);
      const nextAt = Date.now() + delay;
      if (typeof store.recordTurnExtractFailure === 'function') {
        store.recordTurnExtractFailure(sessionId, turn, { attempts, nextAt });
      }
      state.backoff += 1;
      const giveUp = attempts >= settings().maxAttempts;
      log('info', `语义抽取退避：session=${sessionId} turn=${turn} 第 ${attempts} 次失败，${formatDelay(delay)}后再试${giveUp ? '（已达上限，改为每天一次）' : ''}`);
      return { attempts, nextAt };
    } catch (error) {
      log('warn', `写入抽取退避点失败：${error?.message ?? error}`);
      return null;
    }
  }

  function fallbackJournal(sessionId, turn, turns, project = null) {
    try {
      const row = (turns ?? []).find((item) => Number(item.turn) === Number(turn)) ?? turns?.[0] ?? {};
      recordTurnWorkJournal(store, {
        project: project ?? (row.projectId ? store.getProject(Number(row.projectId)) : null),
        sessionId,
        turn,
        userText: String(row.userText ?? ''),
        assistantText: String(row.assistantText ?? ''),
        toolCalls: Number(row.toolCalls ?? 0),
      });
      state.journalFallbacks += 1;
      log('debug', `语义抽取降级：仅记录程序侧项目工作日志（session=${sessionId} turn=${turn}）`);
    } catch (error) {
      log('warn', `程序侧项目日志记录失败：${error?.message ?? error}`);
    }
  }

  /** 处理一个回合；返回是否真的调用过模型（用于全局节流）。 */
  async function processJob(job) {
    const { sessionId, turn } = job;
    const { windowTurns, maxTokens, timeoutMs } = settings();
    if (disposed) return false;
    if (store.isTurnExtracted(sessionId, turn)) {
      state.skipped += 1;
      return false;
    }

    let turns = [];
    try {
      // 以目标回合结尾取窗口：历史回填时 recentTurns 会拿到最新回合，证据会对不上。
      turns = typeof store.turnsWindowAt === 'function'
        ? store.turnsWindowAt({ sessionId, turn, limit: windowTurns }) ?? []
        : store.recentTurns(windowTurns, sessionId) ?? [];
    } catch (error) {
      log('warn', `读取最近回合失败：${error?.message ?? error}`);
      return false;
    }
    const reason = skipReason(turns, turn);
    if (reason !== '') {
      state.skipped += 1;
      if (reason !== 'trivial') log('debug', `语义抽取跳过（${reason}）：session=${sessionId} turn=${turn}`);
      try {
        store.markTurnExtracted(sessionId, turn, Date.now());
      } catch { /* 标记失败不阻塞 */ }
      return false;
    }

    const stat = (() => {
      try {
        return store.getSessionState(sessionId);
      } catch {
        return null;
      }
    })();
    let projectId = Number(stat?.activeProjectId ?? 0) || 0;
    if (!projectId) {
      try {
        const texts = turns.map((row) => String(row.userText ?? ''));
        projectId = Number(projectAttribution(store, { sessionId, texts })?.id ?? 0) || 0;
      } catch {
        projectId = 0;
      }
    }
    const project = projectId ? store.getProject(projectId) : null;
    let related = [];
    try {
      const latestUser = turns.find((row) => Number(row.turn) === Number(turn))?.userText ?? '';
      related = store.searchMemories(String(latestUser ?? ''), 6) ?? [];
    } catch {
      related = [];
    }
    let openTasks = [];
    try {
      openTasks = store.openTasks(6) ?? [];
    } catch {
      openTasks = [];
    }

    if (llm?.available !== true) {
      fallbackJournal(sessionId, turn, turns, project);
      state.failed += 1;
      state.lastError = 'llm-unavailable';
      recordFailure(sessionId, turn, state.lastError);
      return false;
    }

    state.runs += 1;
    lastLlmAt = Date.now();
    state.lastAt = Date.now();
    state.lastTurn = { sessionId, turn };
    let call;
    try {
      const input = buildExtractionInput({ turns, project, openTasks, related, sessionId, turn });
      callTimes.push(Date.now()); // 先记账再调用：抛异常也算用掉一次预算
      call = await llm.callJson({
        sessionId,
        purpose: 'memory-extraction',
        system: SEMANTIC_SYSTEM_PROMPT,
        input,
        maxTokens,
        timeoutMs,
      });
    } catch (error) {
      call = { ok: false, reason: `call-error：${error?.message ?? error}` };
    }

    if (!call?.ok) {
      state.failed += 1;
      state.lastError = String(call?.reason ?? 'unknown');
      const detail = call?.detail ? `：${call.detail}` : (call?.text ? `：${clip(String(call.text), 300)}` : '');
      log('warn', `语义抽取失败（${state.lastError}${detail}），本回合保留未抽取，等待下一轮或 /soul reextract`);
      fallbackJournal(sessionId, turn, turns, project);
      recordFailure(sessionId, turn, state.lastError, detail);
      return true;
    }

    const validated = validateSemanticResult(call.json, { sessionId, turn, turns, project, related, config });
    let applied;
    try {
      applied = applySemanticResult(store, {
        sessionId,
        turn,
        result: validated,
        window: { turns, project, eventRefs: {} },
        config,
        logger,
      });
    } catch (error) {
      state.failed += 1;
      state.lastError = `apply-error：${error?.message ?? error}`;
      log('warn', `语义抽取落库失败：${error?.message ?? error}`);
      fallbackJournal(sessionId, turn, turns, project);
      recordFailure(sessionId, turn, state.lastError);
      return true;
    }

    state.ok += 1;
    state.lastError = '';
    try {
      store.markTurnExtracted(sessionId, turn, Date.now());
      store.metaSet('extraction.last', JSON.stringify({
        at: Date.now(),
        sessionId,
        turn,
        memories: applied?.created?.length ?? 0,
        journal: applied?.journal ?? 0,
        projectItems: applied?.projectItems ?? 0,
        rejected: validated.rejected?.length ?? 0,
      }));
    } catch { /* meta 写入失败不影响抽取结果 */ }
    log('info', `语义抽取完成：记忆 ${applied?.created?.length ?? 0} 条、工作日志 ${applied?.journal ?? 0} 条、项目条目 ${applied?.projectItems ?? 0} 条、拒绝 ${validated.rejected?.length ?? 0} 条`);
    return true;
  }

  /**
   * 补做「进程启动前遗留的未抽取回合」。
   * 场景：宿主重启、上次进程在回合结束前退出、headless 一次性运行等。
   * 只在已经有可用路由（配置指定，或本进程捕获到真实请求路由）时才入队，
   * 避免在 no-route 时把回合误标为「已抽取」而永久丢失语义抽取机会。
   */
  function recoverPending({ requireRoute = true } = {}) {
    if (disposed || !enabled()) return 0;
    if (requireRoute && typeof llm?.hasRoute === 'function' && !llm.hasRoute()) return 0;
    // v1.4：补做带冷却。这个函数被包在 llm.onRoute 上，以前每个路由事件都会跑一遍，
    // 失败回合又不会被标记，启动阶段能刷上百条「补做 1 个遗留回合」并和用户首条请求抢路由。
    const { recoverCooldownMs, recoverBatch } = settings();
    const now = Date.now();
    if (now - lastRecoverAt < recoverCooldownMs) return 0;
    lastRecoverAt = now;
    let rows = [];
    try {
      const hours = Math.max(1, numberOr(config.extractRecoverHours, 72));
      rows = typeof store.unextractedTurns === 'function'
        ? store.unextractedTurns({ limit: 20, since: Date.now() - hours * 3_600_000 })
        : [];
    } catch (error) {
      log('warn', `读取遗留未抽取回合失败：${error?.message ?? error}`);
      return 0;
    }
    let count = 0;
    for (const row of [...rows].reverse()) {
      if (count >= recoverBatch) break; // 一批最多补做 recoverBatch 个，剩下的下次冷却结束后再说
      if (!row?.sessionId || !Number.isFinite(Number(row.turn))) continue;
      if (store.isTurnExtracted(row.sessionId, row.turn)) continue;
      if (Number(row.nextExtractAt ?? 0) > now) continue; // 还在退避期
      enqueue(null, row.sessionId, row.turn);
      count += 1;
    }
    if (count > 0) log('info', `补做 ${count} 个遗留回合的语义抽取（本批上限 ${recoverBatch}）`);
    return count;
  }

  /** 等待队列清空（测试/卸载时用；普通运行不需要）。 */
  async function drain(timeoutMs = 10000) {
    const started = Date.now();
    while ((pumping || queue.length > 0) && Date.now() - started < timeoutMs) {
      await sleep(20);
    }
  }

  /** 回填历史：把最近 N 个回合重置为未抽取并重新入队。 */
  function reextract({ limit = 20, sessionId = '' } = {}) {
    if (disposed || !enabled()) return 0;
    let rows = [];
    try {
      rows = store.resetExtractedTurns({ limit, sessionId });
    } catch (error) {
      log('warn', `重置已抽取回合失败：${error?.message ?? error}`);
      return 0;
    }
    for (const row of rows) enqueue(null, row.sessionId, row.turn);
    if (rows.length > 0) log('info', `历史回填：重置 ${rows.length} 个回合并重新抽取`);
    return rows.length;
  }

  function stats() {
    return {
      ...state,
      queued: queue.length,
      pumping,
      disposed,
      callsLastHour: callsLastHour(),
      maxCallsPerHour: settings().maxCallsPerHour,
    };
  }

  function dispose() {
    if (disposed) return;
    disposed = true;
    if (resumeTimer) {
      clearTimeout(resumeTimer);
      resumeTimer = null;
    }
    for (const sessionId of buffers.keys()) clearBufferTimer(sessionId);
    buffers.clear();
    queue.length = 0;
    pending.clear();
    persistStats();
  }

  return { considerTurn, recoverPending, reextract, drain, stats, dispose };
}
