/**
 * commands — `/soul` 管理命令（宿主命令注册表可用时）。
 *
 * 命令直接操作插件自己的数据库：查看状态、检索/删除记忆、查看与切换项目、
 * 维护项目条目、手动复盘、导出、查看配置。它不经过模型，也不假装执行——
 * 每一步都是真实的本地读写，失败会明确报错。
 */
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { clip, formatAge } from '../util.js';
import {
  renderMemoryList,
  renderProjectList,
  renderProjectSnapshot,
  renderReview,
  renderStatus,
  renderContextBlock,
} from '../memory/render.js';
import { classifyTurn } from '../core/conversation-policy.js';
import { planRetrieval } from '../memory/retrieval.js';
import { PROJECT_ITEM_KINDS } from '../memory/store.js';
import {
  addProjectEntry,
  resolveProject,
  switchProject,
  upsertProject,
} from '../core/project-manager.js';
import { guessMemoryType } from '../memory/extract.js';
import { replayStyleFromTurns } from '../memory/style-replay.js';
import {
  formatJournalEntries,
  formatTodayDigest,
  listJournal,
  todayDigest,
} from '../memory/journal.js';

const HELP = [
  '/soul — dsh-soul 管理命令',
  '  status                      插件状态（记忆/项目/关系/预算/路径）',
  '  memories [关键词]           列出最近记忆；带关键词则检索',
  '  search <关键词>             检索长期记忆',
  '  remember <文本>             手动写入一条记忆（等价于明确要求记住）',
  '  forget <id>                 彻底删除一条记忆（#id）',
  '  candidates                  查看待确认的候选记忆（低置信自动抽取）',
  '  approve <id>                确认一条候选记忆，转为正式记忆',
  '  reject <id>                 拒绝一条候选记忆（归档，不再注入）',
  '  today                       今天这个项目都做了什么（项目工作日志）',
  '  journal [条数]              最近的对话/工作日志（可按项目过滤）',
  '  projects                    列出所有项目',
  '  project <项目名|id>         查看项目完整状态',
  '  switch <项目名|id>          把当前会话切到该项目',
  '  add <kind> <内容>           往当前项目记一条（kind 可省略，自动归类）',
  `  done <itemId>               把项目条目标记完成`,
  '  rules [list|all|active|candidate|superseded|disabled]  查看从反馈沉淀的行为规则',
  '  rules promote <id>          把一条候选/停用规则提升为 active（下一轮生效）',
  '  rules disable <id>          停用一条规则（下一轮不再注入）',
  '  rules rollback <id>         回滚一条 active 规则，恢复同场景上一条 superseded',
  '  reextract [条数]             重置最近 N 个回合的抽取标记并后台重跑（默认 20）',
  '  replay [条数]                回放最近 N 个回合的语体反馈（补记漏掉的规则/样本）',
  '  mood                        看我当前的心情（valence / 原因 / 给 knock 的档位）',
  '  sleep                       手动跑一次睡眠维护（近重复合并/低价值聚合/衰减/归档）',
  '  why                         最近一次真实注入用了什么（历史记录）',
  '  plan [这句话]               预览：现在回复会怎么检索、预算怎么分（不落库）',
  '  diagnose [turn:<id>|memory:<id>] [--text]  完整唤醒链路（默认只打 ID/原因码/长度）',
  '  check                       只读一致性检查（库/schema/索引/向量/状态自洽）',
  '  review                      本地复盘（最近对话/项目/任务/记忆）',
  '  config                      查看生效配置与存储路径',
  '  backup                      手动备份记忆库到数据目录',
  '  export [路径]               导出记忆/项目/任务为 JSON',
  '  help                        本帮助',
].join('\n');

/** 把一行唤醒日志/预览渲染成给人看的分段文本（--text 才显示记忆正文）。 */
function renderWakeLog(log, { showText = false, store = null } = {}) {
  if (!log || typeof log !== 'object') return '（没有记录）';
  const pick = (value, fallback) => (value === undefined || value === null || value === '' ? fallback : value);
  const at = Number(log.at ?? 0);
  const injected = Array.isArray(log.injectedIds) ? log.injectedIds : (Array.isArray(log.renderedIds) ? log.renderedIds : []);
  const overBudget = Array.isArray(log.overBudgetIds) ? log.overBudgetIds : [];
  const candidates = Array.isArray(log.candidates) ? log.candidates : [];
  const filtered = log.filtered && typeof log.filtered === 'object' ? log.filtered : {};
  const excluded = Array.isArray(filtered.excluded) ? filtered.excluded : (Array.isArray(log.excluded) ? log.excluded : []);
  const removed = Array.isArray(filtered.removedSections) ? filtered.removedSections : (Array.isArray(log.removedSections) ? log.removedSections : []);
  const sections = log.sectionChars && typeof log.sectionChars === 'object' ? log.sectionChars : (log.sections ?? {});
  const counts = Object.entries(filtered)
    .filter(([, n]) => typeof n === 'number' && n > 0)
    .map(([key, n]) => key + '=' + n);
  const lines = [];
  lines.push('回合 ' + pick(log.turnId, '?') + (at > 0 ? '（' + formatAge(at) + '）' : '') + '｜模式 ' + pick(log.mode, '?') + '｜路径 ' + pick(log.path, '?') + '｜缓存 ' + pick(log.cache, '?'));
  lines.push('渲染：' + (log.rendered === false ? '没有产出注入块' : '已渲染并交给宿主') + (log.degraded ? '｜降级 ' + log.degraded : '') + '｜耗时 ' + Number(log.ms ?? 0) + 'ms');
  if (log.skipped || log.skipReason) lines.push('跳过原因：' + pick(log.skipReason, '这一轮没检索'));
  lines.push('候选池 ' + candidates.length + ' 条 → 注入 ' + injected.length + ' 条｜预算 ' + Number(log.budgetUsed ?? 0) + '/' + Number(log.budgetTotal ?? 0) + ' 字');
  if (counts.length > 0) lines.push('过滤计数：' + counts.join(' '));
  if (overBudget.length > 0) lines.push('单条超预算：' + overBudget.slice(0, 20).map((id) => '#' + id).join(' '));
  if (excluded.length > 0) {
    const byReason = {};
    for (const item of excluded) {
      const reason = String(item?.reason ?? '?');
      byReason[reason] = (byReason[reason] ?? 0) + 1;
    }
    const summary = Object.entries(byReason).map(([reason, n]) => reason + ' ' + n).join('，');
    lines.push('淘汰明细（' + summary + '）：' + excluded.slice(0, 20).map((item) => '#' + item?.id + '(' + String(item?.reason ?? '?') + ')').join(' '));
  }
  if (removed.length > 0) lines.push('整段移除：' + removed.join('、'));
  const sectionBits = Object.entries(sections).filter(([, n]) => Number(n) > 0).map(([key, n]) => key + ' ' + n + '字');
  if (sectionBits.length > 0) lines.push('段落字数：' + sectionBits.join('，'));
  lines.push('注入 ID：' + (injected.length > 0 ? injected.map((id) => '#' + id).join(' ') : '没有'));
  if (showText && store && injected.length > 0) {
    for (const id of injected.slice(0, 10)) {
      const memory = store.getMemory(Number(id));
      if (memory) lines.push('  #' + memory.id + ' ' + clip(String(memory.content ?? ''), 160));
    }
  }
  return lines.join('\n');
}

export function registerCommand(ctx, { store, config, paths, personaInfo, version, logger, emotion = null, extraction = null, embedding = null }) {
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined;
  if (!commands || typeof commands.register !== 'function') {
    logger?.warn?.('commands 服务不可用：/soul 未注册（宿主未挂载 dsh-commands）');
    return () => {};
  }

  const handler = (invocation) => {
    try {
      return executeCommand(invocation);
    } catch (error) {
      return { kind: 'error', text: `/soul 执行失败：${clip(error?.message ?? error, 300)}` };
    }
  };

  function sessionIdOf(invocation) {
    return String(invocation?.agent?.session?.id ?? invocation?.agent?.session?.header?.id ?? '');
  }

  /** 当前会话的活跃项目 id（没有则为 0）。 */
  function currentProjectId(store, sessionId) {
    try {
      return Number(store.getSessionState(sessionId)?.activeProjectId ?? 0) || 0;
    } catch {
      return 0;
    }
  }

  function executeCommand(invocation) {
    const raw = String(invocation?.rawInput ?? '').trim();
    const [head = 'help', ...rest] = raw === '' ? [] : raw.split(/\s+/u);
    const arg = rest.join(' ').trim();
    const sessionId = sessionIdOf(invocation);
    const ok = (text) => ({ kind: 'success', text });

    switch (head.toLowerCase()) {
      case 'help':
      case '':
        return ok(HELP);

      case 'status':
        return ok(renderStatus({ store, config, paths, personaInfo, version, embedding }));

      case 'rules': {
        const [action = 'list', ...args] = arg === '' ? [] : arg.split(/\s+/u);
        const ruleId = Number(args[0] ?? action);
        const renderRules = (rows) => (rows.length === 0
          ? '（没有匹配的行为规则）'
          : rows.map((rule) => `#${rule.id} [${rule.status}] ${rule.scene || '全局'}/${rule.category}（证据 ${Number(rule.evidenceCount).toFixed(1)}）— ${clip(rule.rule, 160)}`).join('\n'));
        const summarize = () => {
          const stats = store.styleRuleStats();
          return `行为规则：active ${stats.active}，candidate ${stats.candidate}，superseded ${stats.superseded}，disabled ${stats.disabled}`;
        };
        const key = action.toLowerCase();
        if (key === 'list' || key === 'all') {
          const rows = store.listStyleRules({ limit: 50 });
          return ok(`${summarize()}\n${renderRules(rows)}\n（/soul rules promote <id> / disable <id> / rollback <id>）`);
        }
        if (['active', 'candidate', 'superseded', 'disabled'].includes(key)) {
          return ok(renderRules(store.listStyleRules({ status: key, limit: 50 })));
        }
        if (!Number.isFinite(ruleId) || ruleId <= 0) return ok('用法：/soul rules [list|all] 或 /soul rules promote|disable|rollback <id>');
        if (!store.findStyleRule(ruleId)) return ok(`没有找到规则 #${ruleId}`);
        if (key === 'promote' || key === 'enable') {
          const rule = store.setStyleRuleStatus(ruleId, 'active');
          return ok(`规则 #${rule.id} 已 ${rule.status}，下一轮起生效：${clip(rule.rule, 120)}`);
        }
        if (key === 'disable') {
          const rule = store.setStyleRuleStatus(ruleId, 'disabled');
          return ok(`规则 #${rule.id} 已停用（下一轮不再注入）：${clip(rule.rule, 120)}`);
        }
        if (key === 'rollback') {
          const result = store.rollbackStyleRule(ruleId);
          if (!result) return ok(`规则 #${ruleId} 没有可回滚的历史`);
          return ok(`已回滚规则 #${ruleId}${result.restored ? `，恢复 #${result.restored.id}：${clip(result.restored.rule, 100)}` : ''}`);
        }
        return ok('用法：/soul rules [list|all|active|candidate|superseded|disabled] 或 promote|disable|rollback <id>');
      }

      case 'reextract': {
        if (!extraction || typeof extraction.reextract !== 'function') {
          return ok('抽取控制器未挂载，/soul reextract 不可用（capture 关闭或插件未完成初始化）。');
        }
        const limit = Math.min(200, Math.max(1, Number(arg) || 20));
        const count = extraction.reextract({ limit });
        return ok(count > 0
          ? `已重置最近 ${count} 个回合的抽取标记，后台重新抽取中；失败会写 extraction.last_error，不标已抽取。`
          : '没有可重置的回合（可能全部为空回合，或抽取已关闭）。');
      }

      case 'replay': {
        const limit = Math.min(200, Math.max(1, Number(arg) || 20));
        const result = replayStyleFromTurns(store, {
          sessionId,
          limit,
          config,
          logger,
        });
        return ok(
          `回放 ${result.turns} 个回合：夸奖 ${result.praise}，批评 ${result.corrections}，规则 ${result.rules}，样本 ${result.samples}，扣分 ${result.penalties}，跳过 ${result.skipped}。`,
        );
      }

      case 'mood': {
        if (!emotion?.current) return ok('情绪模块没启用（emotionJudge=false）。');
        const current = emotion.current();
        if (!current) return ok('还没有情绪记录。第一条消息之后就会开始判。');
        const reason = String(current.reason ?? '').trim();
        return ok(
          [
            `心情：${current.label}（valence ${Number(current.valence).toFixed(2)}，${formatAge(current.updatedAt)}更新）`,
            reason !== '' ? `原因：${reason}` : '原因：没记',
          ].join('\n'),
        );
      }

      case 'memories':
      case 'list': {
        const rows = arg !== '' ? store.searchMemories(arg, 12) : store.listMemories({ limit: 15 });
        return ok(renderMemoryList(rows));
      }

      case 'search': {
        if (arg === '') return ok('用法：/soul search <关键词>');
        const rows = store.searchMemories(arg, 12);
        return ok(rows.length > 0 ? renderMemoryList(rows) : `（没有和「${arg}」相关的记忆）`);
      }

      case 'remember': {
        if (arg === '') return ok('用法：/soul remember <要记住的内容>');
        const saved = store.rememberMemory({
          type: guessMemoryType(arg),
          content: clip(arg, 300),
          source: 'user-explicit',
          confidence: 0.9,
          sessionId: sessionId || undefined,
          reason: '/soul remember',
        });
        return ok(`记下了 #${saved.id}：${clip(saved.content, 120)}`);
      }

      case 'forget':
      case 'delete': {
        const id = Number(arg);
        if (!Number.isFinite(id) || id <= 0) return ok('用法：/soul forget <记忆id>');
        const memory = store.getMemory(id);
        if (!memory) return ok(`没有找到记忆 #${id}`);
        store.eraseMemory(id);
        return ok(`已彻底删除记忆 #${id}：${clip(memory.content, 100)}`);
      }

      case 'candidates': {
        const rows = store.listCandidates(30);
        return ok(rows.length > 0
          ? `待确认的候选记忆（${rows.length} 条）：\n${renderMemoryList(rows)}\n确认：/soul approve <id>；拒绝：/soul reject <id>`
          : '（没有待确认的候选记忆）');
      }

      case 'approve': {
        const id = Number(arg);
        if (!Number.isFinite(id) || id <= 0) return ok('用法：/soul approve <候选记忆id>');
        const memory = store.getMemory(id);
        if (!memory) return ok(`没有找到记忆 #${id}`);
        if (memory.status !== 'candidate') return ok(`#${id} 不是候选记忆（当前状态 ${memory.status}）`);
        const promoted = store.promoteCandidate(id, '/soul approve');
        return ok(`已确认 #${promoted.id}：${clip(promoted.content, 120)}`);
      }

      case 'reject': {
        const id = Number(arg);
        if (!Number.isFinite(id) || id <= 0) return ok('用法：/soul reject <候选记忆id>');
        const memory = store.getMemory(id);
        if (!memory) return ok(`没有找到记忆 #${id}`);
        if (memory.status !== 'candidate') return ok(`#${id} 不是候选记忆（当前状态 ${memory.status}）`);
        store.rejectCandidate(id, '/soul reject');
        return ok(`已拒绝候选 #${id}：${clip(memory.content, 120)}`);
      }

      case 'backup': {
        const target = join(paths.dataDir, `soul-${Date.now()}.db.bak`);
        store.backupFile(target);
        return ok(`已备份记忆库到 ${target}`);
      }

      case 'today': {
        const projectId = currentProjectId(store, sessionId);
        const digest = todayDigest(store, { projectId });
        const projectName = projectId > 0 ? (store.getProject(projectId)?.name ?? '') : '';
        return ok(formatTodayDigest(digest, { projectName }));
      }

      case 'journal': {
        const projectId = currentProjectId(store, sessionId);
        const limit = Number.parseInt(arg, 10);
        const entries = listJournal(store, {
          projectId,
          limit: Number.isFinite(limit) && limit > 0 ? Math.min(limit, 100) : 20,
        });
        const projectName = projectId > 0 ? (store.getProject(projectId)?.name ?? '') : '';
        return ok(formatJournalEntries(entries, { projectName }));
      }

      case 'projects':
        return ok(renderProjectList(store.listProjects({ status: 'any', limit: 50 }), store));

      case 'project': {
        if (arg === '') return ok('用法：/soul project <项目名|id>');
        const project = resolveProject(store, arg);
        if (!project) return ok(`找不到项目「${arg}」`);
        return ok(renderProjectSnapshot(store.projectSnapshot(project.id)));
      }

      case 'switch': {
        if (arg === '') return ok('用法：/soul switch <项目名|id>');
        const project = switchProject(store, sessionId, arg);
        return ok(`当前会话已切到项目 #${project.id}「${project.name}」`);
      }

      case 'add': {
        if (arg === '') return ok('用法：/soul add [kind] <内容>');
        const [first, ...tail] = arg.split(/\s+/u);
        const kind = PROJECT_ITEM_KINDS.includes(first) ? first : '';
        const content = kind === '' ? arg : tail.join(' ').trim();
        if (content === '') return ok('用法：/soul add [kind] <内容>');
        const saved = addProjectEntry(store, sessionId, { kind, content });
        return ok(`记入项目「${saved.project.name}」#${saved.item.id}（${saved.kind}）：${clip(saved.item.content, 120)}`);
      }

      case 'done': {
        const id = Number(arg);
        if (!Number.isFinite(id) || id <= 0) return ok('用法：/soul done <条目id>');
        const item = store.setProjectItemState(id, 'done');
        if (!item) return ok(`找不到条目 #${id}`);
        return ok(`条目 #${item.id} 已标记完成，当前状态 ${item.state}：${clip(item.content, 120)}`);
      }

      case 'sleep': {
        const report = store.curate({ retentionDays: Number(config.retentionDays) || 30 });
        return ok([
          '睡眠维护跑完了：',
          `  裁剪回合 ${report.prunedTurns} 条`,
          `  近重复合并 ${report.deduped} 条、低价值聚合 ${report.consolidated} 组`,
          `  衰减 ${report.decayed} 条、归档 ${report.archivedMemories} 条`,
          `  工作日志 ${report.prunedJournal} 条、证据 ${report.prunedEvidence} 条`,
        ].join('\n'));
      }

      case 'why': {
        // v1.6：why 只说历史。它读的是上一轮真实落库的唤醒记录，不做预算预览。
        const lines = ['最近一次真实注入（历史记录，不是预览）：'];
        const logs = typeof store.recentWakeLogs === 'function' ? store.recentWakeLogs({ sessionId, limit: 1 }) : [];
        const legacy = String(store.metaGet('retrieval.last') ?? '');
        if (logs.length > 0) lines.push(renderWakeLog(logs[0]));
        else if (legacy !== '') lines.push(legacy);
        else lines.push('（还没有记录：这一轮还没跑过注入，或日志被清过）');
        lines.push('', '想看「现在这句话会怎么检索」用 /soul plan <这句话>；想看某一回合的完整链路用 /soul diagnose turn:<id>。');
        return ok(lines.join('\n'));
      }

      case 'plan': {
        // 纯预览：dryRun 不写 meta、不记语体锚点、不落 wake_log。
        const state = store.getSessionState(sessionId);
        const text = arg !== '' ? arg : String(state?.lastUserText ?? '');
        if (text.trim() === '') return ok('没有可预览的话。用法：/soul plan 这句话…');
        const report = {};
        renderContextBlock({ store, config, sessionId, query: text, queryVector: null, logger, report, dryRun: true });
        return ok([
          '预算预览（只算不写：不改 retrieval.last、不记锚点、不落 wake_log）：',
          renderWakeLog(report),
          '注：预览不跑向量检索，真实回合会多一路语义召回。',
        ].join('\n'));
      }

      case 'diagnose': {
        const showText = rest.includes('--text');
        const target = rest.filter((piece) => piece !== '--text').join(' ').trim();
        if (typeof store.recentWakeLogs !== 'function') return ok('这个版本没有唤醒日志（store.recentWakeLogs 缺失）。');
        if (target === '') {
          const logs = store.recentWakeLogs({ sessionId, limit: 3 });
          if (logs.length === 0) return ok('还没有唤醒记录（v1.6 起每轮写一行；刚升级时是空的）。');
          return ok(['最近 ' + logs.length + ' 轮唤醒链路（加 --text 才显示记忆正文）：', ...logs.map((log) => renderWakeLog(log, { showText, store }))].join('\n\n'));
        }
        const turnMatch = /^turn:(\d+)$/u.exec(target);
        if (turnMatch) {
          const turnId = Number(turnMatch[1]);
          const logs = store.wakeLogsForTurn(turnId, 5);
          if (logs.length === 0) return ok('回合 ' + turnId + ' 没有唤醒记录（可能日志已被裁剪，或那一轮没走注入）。');
          return ok(logs.map((log) => renderWakeLog(log, { showText, store })).join('\n\n'));
        }
        const memMatch = /^memory:#?(\d+)$/u.exec(target);
        if (memMatch) {
          const memoryId = Number(memMatch[1]);
          const memory = store.getMemory(memoryId);
          const head = memory
            ? '#' + memory.id + ' [' + memory.type + '/' + memory.status + '] 置信 ' + Number(memory.confidence ?? 0).toFixed(2) + '、重要度 ' + Number(memory.importance ?? 0).toFixed(2) + '、命中 ' + Number(memory.hits ?? 0) + (showText ? '：' + clip(String(memory.content ?? ''), 200) : '')
            : '#' + memoryId + '：库里没有这条（可能已彻底删除）';
          const logs = store.recentWakeLogs({ limit: 100 });
          const appeared = logs.filter((log) => (log.candidates ?? []).includes(memoryId));
          const injectedIn = appeared.filter((log) => (log.injectedIds ?? []).includes(memoryId));
          const lines = [head, '最近 ' + logs.length + ' 条唤醒记录：进过候选池 ' + appeared.length + ' 次，真正注入 ' + injectedIn.length + ' 次。'];
          for (const log of appeared.slice(0, 5)) {
            const reasons = (log.filtered?.excluded ?? []).filter((item) => Number(item?.id) === memoryId).map((item) => String(item.reason));
            lines.push('- 回合 ' + log.turnId + '：' + ((log.injectedIds ?? []).includes(memoryId) ? '已注入' : '未注入（' + (reasons.join('/') || '原因未记录') + '）'));
          }
          if (appeared.length === 0 && memory && (memory.status === 'active' || memory.status === 'candidate')) {
            lines.push('最近没有被检索到：可能查询词不匹配、时间窗口外、类型白名单外，或被同类配额/预算挤掉。');
          }
          return ok(lines.join('\n'));
        }
        return ok('用法：/soul diagnose [turn:<id>|memory:#id] [--text]');
      }

      case 'check': {
        if (typeof store.integrityCheck !== 'function') return ok('这个版本没有一致性检查（store.integrityCheck 缺失）。');
        const result = store.integrityCheck();
        const icon = { ok: '✓', warn: '!', fail: '✗' };
        const lines = ['一致性检查（只读，不修复）：', ...result.checks.map((check) => (icon[check.status] ?? '?') + ' ' + check.name + '：' + check.detail)];
        lines.push('', result.ok
          ? (result.warned > 0 ? '结论：没有硬错误，' + result.warned + ' 项提示。' : '结论：一致。')
          : '结论：' + result.failed + ' 项失败——先修这些，再看别的。');
        return ok(lines.join('\n'));
      }
      case 'review':
        return ok(renderReview(store, { turns: 20 }));

      case 'config': {
        const info = {
          version,
          dbPath: store.path,
          dataDir: paths.dataDir,
          logFile: paths.logFile,
          config,
          persona: {
            loaded: (personaInfo?.sources ?? []).filter((source) => source.ok).length,
            sources: personaInfo?.sources ?? [],
          },
          skill: paths.skill,
        };
        return ok(JSON.stringify(info, null, 2));
      }

      case 'export': {
        const target = arg !== '' ? arg : join(paths.dataDir, `soul-export-${Date.now()}.json`);
        const payload = {
          exportedAt: new Date().toISOString(),
          version,
          memories: store.listMemories({ limit: 500 }),
          projects: store.listProjects({ status: 'any', limit: 100 }).map((project) => ({
            ...project,
            snapshot: store.projectSnapshot(project.id),
          })),
          tasks: store.listTasks({ limit: 500 }),
          relation: store.getRelation(),
        };
        writeFileSync(target, JSON.stringify(payload, null, 2), 'utf8');
        return ok(`已导出到 ${target}（记忆 ${payload.memories.length} 条，项目 ${payload.projects.length} 个）`);
      }

      default:
        return { kind: 'error', text: `未知子命令「${head}」。\n${HELP}` };
    }
  }

  return commands.register({
    name: 'soul',
    description: 'dsh-soul 管理：状态、长期记忆、项目、复盘、配置',
    input: { hint: '[status|memories|search|remember|forget|candidates|approve|reject|projects|project|switch|add|done|rules|why|plan|diagnose|check|reextract|review|config|backup|export|help]' },
    handler,
  });
}
