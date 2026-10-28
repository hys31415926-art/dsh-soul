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
} from '../memory/render.js';
import { PROJECT_ITEM_KINDS } from '../memory/store.js';
import {
  addProjectEntry,
  resolveProject,
  switchProject,
  upsertProject,
} from '../core/project-manager.js';
import { guessMemoryType } from '../memory/extract.js';
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
  '  mood                        看我当前的心情（valence / 原因 / 给 knock 的档位）',
  '  review                      本地复盘（最近对话/项目/任务/记忆）',
  '  config                      查看生效配置与存储路径',
  '  backup                      手动备份记忆库到数据目录',
  '  export [路径]               导出记忆/项目/任务为 JSON',
  '  help                        本帮助',
].join('\n');

export function registerCommand(ctx, { store, config, paths, personaInfo, version, logger, emotion = null, extraction = null }) {
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
        return ok(renderStatus({ store, config, paths, personaInfo, version }));

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
    input: { hint: '[status|memories|search|remember|forget|candidates|approve|reject|projects|project|switch|add|done|rules|reextract|review|config|backup|export|help]' },
    handler,
  });
}
