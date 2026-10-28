/**
 * tools — 给主模型的手：把「记忆 / 项目 / 任务 / 状态 / 复盘」变成可调用的工具。
 *
 * 设计取向和规格一致：绝大多数判断仍由主模型在一次请求里完成，这里只提供
 * 低成本的确定性读写；工具本身不做额外模型调用。所有工具都返回简短文本，
 * 不把整库倒进上下文。
 */
import { defineTool } from '@deepseek-ai/dsh-tools';
import { clip, formatAge, formatTime } from './util.js';
import { formatMeme, lookupMeme } from './meme.js';

/** 情绪 → knock 的闹脾气档位（knock 只认三档，soul 内部允许更细的 label）。 */
function moodLabelForKnock(valence) {
  const value = Number(valence) || 0;
  if (value <= -0.45) return '生气（会拖得更久，话也少）';
  if (value <= -0.1) return '闷（不太想主动开口）';
  return '正常（该说说）';
}
import {
  renderMemoryList,
  renderProjectList,
  renderProjectSnapshot,
  renderReview,
  renderStatus,
  typeLabel,
} from './memory/render.js';
import { MEMORY_TYPES, PROJECT_ITEM_KINDS, TASK_STATES } from './memory/store.js';
import {
  activeProject,
  addProjectEntry,
  addTask,
  resolveProject,
  switchProject,
  taskLine,
  upsertProject,
} from './core/project-manager.js';
import { guessMemoryType } from './memory/extract.js';
import { addStyleExample, penalizeStyleExamples } from './memory/style-examples.js';

export function registerTools(ctx, store, config, paths, personaInfo, version = '0.1.0', memeDb = null, emotion = null) {
  const disposers = [];
  const register = (tool) => disposers.push(ctx.tools.register(tool));

  /** 工具执行期间拿会话 id：exec.agent.session 由宿主提供，PTC/子代理可能没有。 */
  const sessionIdOf = (exec) => String(exec?.agent?.session?.id ?? exec?.agent?.session?.header?.id ?? '');

  const textOutput = (fn) => ({
    schema: { type: 'json' },
    render: (_args, value) => [{ type: 'text', text: fn(value) }],
  });

  register(defineTool({
    name: 'soul_status',
    description: '查看 dsh-soul 的状态：记忆数量与类型、项目与任务数、关系连续性（认识多久/聊过多少轮/称呼）、当前注入预算、人格文件加载情况、数据库与日志路径。不需要参数。',
    parameters: {},
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async () => ({
      text: renderStatus({ store, config, paths, personaInfo, version }),
    }),
  }));

  register(defineTool({
    name: 'soul_search',
    description: '在长期记忆里做关键词检索（中文短词效果最好）。用于确认「之前是不是定过」「上次怎么解决的」「用户喜欢什么」。返回带 #id 的列表，id 可用于 soul_forget。不要每轮都翻库；只在和当前话题相关时查。',
    parameters: {
      query: { type: 'string', required: true, description: '检索关键词，中文短词最准，例如「部署」「昵称」「写作」' },
      type: { type: 'string', description: `按类型过滤：${MEMORY_TYPES.join(' | ')}；不填=全部` },
      project: { type: 'string', description: '限定某个项目（项目名或 id）' },
      limit: { type: 'number', description: '返回条数，默认 8，最多 20' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const query = String(args.query ?? '').trim();
      if (query === '') throw new Error('soul_search: query 不能为空');
      const limit = Math.min(20, Math.max(1, Number(args.limit ?? 8)));
      const projectId = args.project ? resolveProject(store, args.project)?.id ?? 0 : 0;
      const type = MEMORY_TYPES.includes(String(args.type ?? '')) ? String(args.type) : '';
      let rows = store.searchMemories(query, limit * 2);
      if (type) rows = rows.filter((memory) => memory.type === type);
      if (projectId) rows = rows.filter((memory) => memory.projectId === projectId);
      rows = rows.slice(0, limit);
      return { count: rows.length, text: renderMemoryList(rows) };
    },
  }));

  register(defineTool({
    name: 'soul_remember',
    description: '把一条值得长期保留的信息写进长期记忆。适合：用户明确要求记住的事、稳定偏好、重要决定、项目关键结论、对关系连续性有意义的真实互动。不适合：临时情绪、一次性玩笑、猜测。重复写同一条会合并加权，不会增生。',
    parameters: {
      content: { type: 'string', required: true, description: '一句话事实，尽量短（≤80 字），自足可读（不要写「他说的那个」这种指代）' },
      type: { type: 'string', description: `记忆类型：${MEMORY_TYPES.join(' | ')}；不填则自动判断` },
      tags: { type: 'string', description: '可选标签，空格分隔' },
      project: { type: 'string', description: '关联项目（项目名或 id），可选' },
      confidence: { type: 'number', description: '置信度 0–1，默认 0.7；用户明确要求的用 0.9' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      if (exec?.signal?.aborted) throw new Error('soul_remember: 已取消');
      const content = String(args.content ?? '').trim();
      if (content === '') throw new Error('soul_remember: content 不能为空');
      const type = MEMORY_TYPES.includes(String(args.type ?? '')) ? String(args.type) : guessMemoryType(content);
      const projectId = args.project ? resolveProject(store, args.project)?.id ?? null : null;
      const saved = store.rememberMemory({
        type,
        content: clip(content, 300),
        tags: String(args.tags ?? ''),
        source: 'tool',
        confidence: Number(args.confidence ?? 0.7),
        projectId,
        sessionId: sessionIdOf(exec) || undefined,
      });
      return { id: saved.id, type: saved.type, hits: saved.hits, text: `记下了 #${saved.id} [${typeLabel(saved.type)}] ${clip(saved.content, 100)}（第 ${saved.hits} 次出现）` };
    },
  }));

  register(defineTool({
    name: 'soul_forget',
    description: '删除一条长期记忆（用户明确要求删除时用；连同历史版本彻底清掉）。参数 id 用 soul_search 或 /soul memories 查到的 #id。删除后无法恢复。',
    parameters: {
      id: { type: 'number', required: true, description: '记忆 id（# 后面的数字）' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const id = Number(args.id);
      if (!Number.isFinite(id) || id <= 0) throw new Error('soul_forget: id 无效');
      const memory = store.getMemory(id);
      if (!memory) return { deleted: false, text: `没有找到记忆 #${id}` };
      store.eraseMemory(id);
      return { deleted: true, text: `已彻底删除记忆 #${id}：${clip(memory.content, 80)}` };
    },
  }));

  register(defineTool({
    name: 'soul_projects',
    description: '长期项目档案的读写入口。action=list 列出所有项目；snapshot 看单个项目完整状态（目标/已完成/决定/待办/阻塞/下一步）；upsert 新建或更新项目；update 改阶段/状态；switch 把当前会话切到某个项目；add 往项目里记一条进展（kind 不填自动归类）；item-state/delete-item 维护单条记录。项目信息按项目隔离，不要混用。',
    parameters: {
      action: { type: 'string', required: true, description: 'list | snapshot | upsert | update | switch | add | item-state | delete-item' },
      project: { type: 'string', description: '项目名或 id（snapshot/update/switch/add 需要；add 不填则用当前活跃项目）' },
      name: { type: 'string', description: 'upsert 时的新项目名' },
      goal: { type: 'string', description: 'upsert/update 时的目标' },
      stage: { type: 'string', description: 'upsert/update 时的当前阶段' },
      status: { type: 'string', description: 'active | paused | done | archived' },
      kind: { type: 'string', description: `add 的条目类型：${PROJECT_ITEM_KINDS.join(' | ')}；不填自动归类` },
      content: { type: 'string', description: 'add 的条目内容' },
      priority: { type: 'number', description: 'add 的优先级（1 最高）' },
      acceptance: { type: 'string', description: 'add 的验证标准/验收条件' },
      itemId: { type: 'number', description: 'item-state / delete-item 的条目 id' },
      state: { type: 'string', description: 'item-state 的新状态：open | done（或其他自定义值）' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      const action = String(args.action ?? '').trim();
      switch (action) {
        case 'list': {
          const projects = store.listProjects({ status: 'any', limit: 30 });
          return { count: projects.length, text: renderProjectList(projects, store) };
        }
        case 'snapshot': {
          const project = resolveProject(store, args.project);
          if (!project) throw new Error(`找不到项目「${args.project ?? ''}」`);
          return { projectId: project.id, text: renderProjectSnapshot(store.projectSnapshot(project.id)) };
        }
        case 'upsert': {
          const name = String(args.name ?? args.project ?? '').trim();
          const project = upsertProject(store, { name, goal: args.goal, stage: args.stage, status: args.status });
          if (sessionId) store.setSessionState(sessionId, { activeProjectId: project.id });
          return { projectId: project.id, text: `项目 #${project.id}「${project.name}」已就绪（${project.status}${project.stage ? ` / ${project.stage}` : ''}）；当前会话已切到它` };
        }
        case 'update': {
          const project = resolveProject(store, args.project);
          if (!project) throw new Error(`找不到项目「${args.project ?? ''}」`);
          const updated = upsertProject(store, {
            name: project.name,
            goal: args.goal ?? project.goal,
            stage: args.stage ?? project.stage,
            status: args.status ?? project.status,
          });
          return { projectId: updated.id, text: `项目 #${updated.id}「${updated.name}」已更新：${updated.status}${updated.stage ? ` / ${updated.stage}` : ''}${updated.goal ? `；目标：${clip(updated.goal, 60)}` : ''}` };
        }
        case 'switch': {
          const project = switchProject(store, sessionId, args.project);
          return { projectId: project.id, text: `当前会话已切到项目 #${project.id}「${project.name}」（${project.status}）` };
        }
        case 'add': {
          const saved = addProjectEntry(store, sessionId, {
            project: args.project,
            kind: String(args.kind ?? ''),
            content: args.content,
            priority: args.priority,
            acceptance: args.acceptance,
          });
          return {
            projectId: saved.project.id,
            itemId: saved.item.id,
            text: `记入项目「${saved.project.name}」#${saved.item.id}（${saved.kind}）：${clip(saved.item.content, 100)}`,
          };
        }
        case 'item-state': {
          const item = store.setProjectItemState(Number(args.itemId), String(args.state ?? 'done'));
          if (!item) throw new Error(`找不到条目 #${args.itemId ?? ''}`);
          return { itemId: item.id, text: `条目 #${item.id} 状态改为 ${item.state}：${clip(item.content, 80)}` };
        }
        case 'delete-item': {
          const item = store.getProjectItem(Number(args.itemId));
          if (!item) throw new Error(`找不到条目 #${args.itemId ?? ''}`);
          store.deleteProjectItem(item.id);
          return { itemId: item.id, text: `已删除条目 #${item.id}：${clip(item.content, 80)}` };
        }
        default:
          throw new Error('soul_projects: action 必须是 list | snapshot | upsert | update | switch | add | item-state | delete-item');
      }
    },
  }));

  register(defineTool({
    name: 'soul_task',
    description: '任务列表（最小状态机 pending → in_progress → blocked/completed）。action=add 新建（可挂到项目）、update 改状态、list 看未完成任务。任务要写清目标和验收标准。',
    parameters: {
      action: { type: 'string', required: true, description: 'add | update | list' },
      id: { type: 'number', description: 'update 时的任务 id' },
      title: { type: 'string', description: 'add 时的任务标题' },
      state: { type: 'string', description: `update 时的状态：${TASK_STATES.join(' | ')}` },
      project: { type: 'string', description: 'add 时挂到的项目（项目名或 id，可选）' },
      priority: { type: 'number', description: 'add 时的优先级（1 最高）' },
      acceptance: { type: 'string', description: 'add 时的验收标准' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args.action ?? '').trim();
      if (action === 'add') {
        const project = args.project ? resolveProject(store, args.project) : null;
        const task = addTask(store, {
          projectId: project?.id ?? 0,
          title: args.title,
          state: 'pending',
          priority: args.priority,
          acceptance: args.acceptance,
        });
        return { taskId: task.id, text: `任务已建 ${taskLine(task)}` };
      }
      if (action === 'update') {
        const id = Number(args.id);
        const state = String(args.state ?? '');
        if (!TASK_STATES.includes(state)) throw new Error(`soul_task: state 必须是 ${TASK_STATES.join(' | ')}`);
        const task = store.setTaskState(id, state);
        if (!task) throw new Error(`找不到任务 #${args.id ?? ''}`);
        return { taskId: task.id, text: `任务已更新 ${taskLine(task)}` };
      }
      if (action === 'list') {
        const tasks = store.openTasks(20);
        const text = tasks.length > 0 ? tasks.map(taskLine).join('\n') : '（没有未完成任务）';
        return { count: tasks.length, text };
      }
      throw new Error('soul_task: action 必须是 add | update | list');
    },
  }));

  register(defineTool({
    name: 'soul_review',
    description: '本地复盘：最近聊过什么、各项目进展与阻塞、未完成任务、记忆规模。全部由数据库生成，不额外调模型。用户说「复盘一下」「我们做到哪了」或长会话告一段落时用；也可以用来主动提醒未解决的事。',
    parameters: {
      turns: { type: 'number', description: '看最近多少个回合，默认 15' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const turns = Math.min(50, Math.max(1, Number(args.turns ?? 15)));
      return { text: renderReview(store, { turns }) };
    },
  }));

  register(defineTool({
    name: 'soul_episodes',
    description: '读最近的原始用户回合（跨会话，新的在前），每条含当时的用户原话和你的回答摘要。用于「复盘一下」「整理记忆」：先看原始回合，再决定哪些值得沉淀；平时不用调。',
    parameters: {
      limit: { type: 'number', description: '读取条数，默认 20，最多 50' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const turns = store.recentTurns(limit);
      const lines = [];
      for (const turn of [...turns].reverse()) {
        lines.push(`[${formatTime(turn.endedAt ?? turn.startedAt)}] 用户：${clip(turn.userText ?? '', 120)}`);
        if (turn.assistantText) lines.push(`  你回：${clip(turn.assistantText, 60)}`);
      }
      return { count: turns.length, text: lines.length > 0 ? lines.join('\n') : '（还没有记录）' };
    },
  }));

  register(defineTool({
    name: 'soul_learn',
    description: '把一条可复用的做法/结论沉淀进知识库（例如「某插件的安装步骤」「某报错的根因」「某命令的正确用法」）。和 soul_remember 分工：事实记人和事，这里记怎么做。重复沉淀同一标题会合并命中次数，不会增生。',
    parameters: {
      title: { type: 'string', required: true, description: '简短标题（≤30 字），用于检索与去重' },
      body: { type: 'string', required: true, description: '结论正文：命令、路径、判据，尽量具体' },
      tags: { type: 'string', description: '空格分隔的标签，可选' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const title = String(args.title ?? '').trim();
      if (title === '') throw new Error('soul_learn: title 不能为空');
      const body = String(args.body ?? '').trim();
      if (body === '') throw new Error('soul_learn: body 不能为空');
      const saved = store.rememberMemory({
        type: 'fact',
        content: clip(`${title}｜${body}`, 500),
        tags: `knowledge ${String(args.tags ?? '')}`.trim(),
        source: 'tool',
        confidence: 0.75,
        sessionId: sessionIdOf(exec) || undefined,
      });
      return { id: saved.id, text: `沉淀 #${saved.id}：${clip(title, 60)}（第 ${saved.hits} 次命中）` };
    },
  }));

  register(defineTool({
    name: 'soul_self',
    description: '更新「我是谁」的自我认知：一段≤120 字的话，写自己这段时间的定位、语气、边界与还在学的东西。会随记忆块一起注入，所以要短、要具体，别写成口号。',
    parameters: {
      text: { type: 'string', required: true, description: '自我认知正文（≤120 字）' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const text = String(args.text ?? '').trim();
      if (text === '') throw new Error('soul_self: text 不能为空');
      store.metaSet('soul.selfModel', clip(text, 120));
      return { text: `自我认知已更新：${clip(text, 120)}` };
    },
  }));

  register(defineTool({
    name: 'soul_meme',
    description: '查网络梗 / 黑话 / 缩写的含义和用法。梗库是 cnmeme.wiki 的公开快照（6660 条）。返回「怎么用 / 怎么接」在前，出处只用于理解、别照搬；查不到就老实说不知道，别硬猜。',
    parameters: {
      query: { type: 'string', description: '要查的词，比如「大水理论」' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const query = clip(String(args.query ?? '').trim(), 40);
      if (!query) throw new Error('soul_meme: query 不能为空');
      if (!memeDb) {
        return { text: '没有梗库（memes.db 不在 dsh-soul 数据目录下）。有把握的梗照常接，没把握就老实说不知道，别硬猜。' };
      }
      const meme = lookupMeme(memeDb, query);
      if (!meme) return { text: `梗库里没有「${query}」。没有就别硬猜，也别把两个不相干的梗拼在一起。` };
      return { text: formatMeme(meme) };
    },
  }));

  register(defineTool({
    name: 'soul_mood',
    description: '看我现在的心情。情绪由 soul 在每条消息后自动判定（valence -1~1、label、一句原因），会随时间演化：开心会慢慢回到轻松，生气久了没被安抚会更深。给你自己看，别每轮都报；自然带出来就行。',
    parameters: {},
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async () => {
      if (!emotion?.current) {
        return { text: '情绪模块没启用（emotionJudge=false 或挂在别的插件上）。' };
      }
      const current = emotion.current();
      if (!current) return { text: '还没有情绪记录。第一条消息之后就会开始判。' };
      const age = formatAge(current.updatedAt);
      const reason = String(current.reason ?? '').trim();
      return {
        text: [
          `心情：${current.label}（valence ${Number(current.valence).toFixed(2)}，${age}更新）`,
          reason !== '' ? `原因：${reason}` : '原因：没记',
          `给 knock 的档位：${moodLabelForKnock(current.valence)}`,
        ].join('\n'),
      };
    },
  }));

  register(defineTool({
    name: 'soul_judge',
    description: '记录并结算你自己的判断。接话前对「这句话到底想要什么 / 该不该关心 / 这条记忆该不该留」有假设时记一条（action=guess）；之后知道猜对猜错就标结果（action=result）。记之前先问一句「这句话在干什么」（要方案、想被接住、只是在确认、在试探），把这一问写进 subject——判断错往往不是猜错答案，而是没问对问题。判断会作为下一轮素材注入（最近猜错的、悬太久没验证的），但它不是事实、不进记忆检索。不必每轮都记，只记你真的在赌的那一下。',
    parameters: {
      action: { type: 'string', description: 'guess | result | list，默认 guess' },
      kind: { type: 'string', description: 'guess 时：read（他想要什么）/ care（该不该关心）/ memory（记忆取舍）' },
      subject: { type: 'string', description: 'guess 时：这句话在干什么（一句短摘要），比如「他在问进度，但语气像在抱怨」' },
      guess: { type: 'string', description: 'guess 时：你的判断，一句话' },
      id: { type: 'number', description: 'result 时：判断 id' },
      outcome: { type: 'string', description: 'result 时：right | wrong | dropped' },
      note: { type: 'string', description: 'result 时：结果说明，比如「他其实只想被接住」' },
      limit: { type: 'number', description: 'list 时：条数，默认 10' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const action = String(args.action ?? 'guess');
      const sessionId = sessionIdOf(exec) || '';
      if (action === 'guess') {
        const guess = String(args.guess ?? '').trim();
        if (guess === '') throw new Error('soul_judge: guess 不能为空');
        const id = store.recordJudgment({
          sessionId,
          kind: String(args.kind ?? 'read'),
          subject: String(args.subject ?? ''),
          guess,
        });
        return { id, text: `判断 #${id} 已记录：${clip(guess, 80)}（open 状态；验证后回来标结果，猜错也标）` };
      }
      if (action === 'result') {
        const id = Number(args.id ?? 0);
        if (!id) throw new Error('soul_judge: result 需要 id');
        const item = store.resolveJudgment(id, { outcome: String(args.outcome ?? 'right'), note: String(args.note ?? '') });
        const mark = { right: '猜对了', wrong: '猜错了', dropped: '不再验证' }[item.outcome] ?? item.outcome;
        return { id: item.id, text: `判断 #${item.id} 标为${mark}${item.note ? `：${item.note}` : ''}` };
      }
      if (action === 'list') {
        const limit = Math.min(50, Math.max(1, Number(args.limit ?? 10)));
        const items = store.listJudgments({ limit });
        if (items.length === 0) return { count: 0, text: '（还没有判断记录）' };
        const mark = { open: '未验证', right: '对', wrong: '错', dropped: '已放弃' };
        const text = items.map((item) => `#${item.id} [${mark[item.outcome] ?? item.outcome}] ${clip(item.guess, 80)}${item.subject ? `（当时：${clip(item.subject, 30)}）` : ''}${item.note ? ` — ${clip(item.note, 40)}` : ''}`).join('\n');
        return { count: items.length, text };
      }
      throw new Error('soul_judge: action 必须是 guess | result | list');
    },
  }));

  register(defineTool({
    name: 'soul_style_feedback',
    description: '把一句好话或一个坏毛病写进语体学习库。适合：前辈明确夸某句说法、明确嫌某句生硬/像客服/太垮，或你自己决定以后沿用某种说法。good 写正向原句；bad 写负向原句并给最像的正向样本扣分；rule 直接沉淀一条正向行为规则（默认 active，下一轮注入）。不要每轮都调，只在有明确反馈时用。',
    parameters: {
      action: { type: 'string', required: true, description: 'good（好句）| bad（坏句）| rule（行为规则）' },
      text: { type: 'string', description: 'good/bad 时的原句，尽量逐字复制' },
      scene: { type: 'string', description: 'work | chat | 空（全局）' },
      rule: { type: 'string', description: 'rule 时的正向行为规则；bad 时可省略，会用默认规则' },
      category: { type: 'string', description: '规则类别，如 mechanical_tone / flat_tone / self_analysis_apology / general' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const action = String(args.action ?? '').toLowerCase();
      const scene = args.scene === 'work' || args.scene === 'chat' ? args.scene : '';
      const text = String(args.text ?? '').trim();
      if (action === 'good') {
        if (text === '') throw new Error('soul_style_feedback: good 需要 text');
        const saved = addStyleExample(store, { text, kind: 'positive', scene, source: 'tool-good', score: 0.8 });
        return { text: saved ? `好句已入库 #${saved.id}（score ${saved.score.toFixed(2)}，${scene || '全局'}）` : '这句太短或含禁用表达，没有入库。' };
      }
      if (action === 'bad') {
        if (text === '') throw new Error('soul_style_feedback: bad 需要 text');
        const saved = addStyleExample(store, { text, kind: 'negative', scene, source: 'tool-bad', score: 0.3 });
        const penalized = penalizeStyleExamples(store, { text, scene });
        const rule = String(args.rule ?? '').trim() || '直白自然接话，不端架子、不套公文腔与空洞金句';
        const category = String(args.category ?? 'flat_tone').trim() || 'flat_tone';
        const ruleRow = store.upsertBehaviorRule({ rule, scene, category, isExplicit: true, weight: 1.5, source: 'tool-bad' });
        return {
          text: `坏句已入库 #${saved?.id ?? '—'}${penalized.length > 0 ? `，扣分样本 #${penalized[0].id}→${penalized[0].score}` : ''}；规则 #${ruleRow?.id ?? '—'} ${ruleRow?.status ?? ''}`,
        };
      }
      if (action === 'rule') {
        const rule = String(args.rule ?? '').trim();
        if (rule === '') throw new Error('soul_style_feedback: rule 需要 rule');
        const saved = store.upsertBehaviorRule({
          rule,
          scene,
          category: String(args.category ?? 'general').trim() || 'general',
          isExplicit: true,
          weight: 1.5,
          source: 'tool-rule',
        });
        return { text: saved ? `规则 #${saved.id} 已 ${saved.status}，下一轮起注入：${clip(saved.rule, 120)}` : '规则太短，没有入库。' };
      }
      throw new Error('soul_style_feedback: action 必须是 good | bad | rule');
    },
  }));

  register(defineTool({
    name: 'soul_session',
    description: '维护当前会话的临时状态：互动模式（mode）、用户上次留下但还没解决的问题（openQuestion）、或把会话切到某个项目（project）。这些状态只影响当前会话的注入内容，不改变长期记忆和人格。',
    parameters: {
      mode: { type: 'string', description: '互动模式，如 chat | work | review | debug；空字符串=清空' },
      openQuestion: { type: 'string', description: '还没解决的问题摘要；空字符串=清空' },
      project: { type: 'string', description: '要切换到的项目（项目名或 id）' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const sessionId = sessionIdOf(exec);
      if (!sessionId) throw new Error('soul_session: 当前工具上下文没有会话 id');
      const patch = {};
      if (typeof args.mode === 'string') patch.mode = clip(args.mode, 40);
      if (typeof args.openQuestion === 'string') patch.openQuestion = clip(args.openQuestion, 160);
      let switched = null;
      if (args.project !== undefined && String(args.project).trim() !== '') {
        switched = switchProject(store, sessionId, args.project);
      }
      const state = store.setSessionState(sessionId, patch);
      const bits = [];
      if (state.mode) bits.push(`模式=${state.mode}`);
      if (state.openQuestion) bits.push(`未解决=${state.openQuestion}`);
      if (switched) bits.push(`项目=「${switched.name}」`);
      const project = activeProject(store, sessionId);
      if (project) bits.push(`活跃项目=「${project.name}」#${project.id}`);
      return { text: bits.length > 0 ? `会话状态已更新：${bits.join('；')}` : '会话状态未变化' };
    },
  }));

  return () => {
    for (const dispose of disposers) {
      try { dispose?.(); } catch { /* 单个工具卸载失败不影响其他 */ }
    }
    disposers.length = 0;
  };
}
