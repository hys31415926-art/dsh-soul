/**
 * project-manager — 项目/任务状态的薄封装。
 *
 * 把「当前会话 → 活跃项目」的解析、项目条目归类、自动进展记录集中在这里，
 * 让 hooks（自动）、tools（主模型主动）、commands（用户手动）三条入口共用同一套
 * 规则，避免各写一份造成项目串味。
 */
import { clip, normText } from '../util.js';
import { classifyProjectNote } from '../memory/extract.js';
import { PROJECT_ITEM_KINDS, TASK_STATES } from '../memory/store.js';

export const PROJECT_STATUSES = ['active', 'paused', 'done', 'archived'];

/** 按 id / 精确项目名 / 文本匹配 找到项目。 */
export function resolveProject(store, ident) {
  const raw = String(ident ?? '').trim();
  if (raw === '') return null;
  if (/^\d+$/.test(raw)) return store.getProject(Number(raw));
  const wanted = normText(raw);
  const byName = store.listProjects({ status: 'any', limit: 100 })
    .find((project) => normText(project.name) === wanted);
  if (byName) return byName;
  return store.matchProject(raw);
}

/** 当前会话的活跃项目（已归档的不算）。 */
export function activeProject(store, sessionId) {
  if (!sessionId) return null;
  const state = store.getSessionState(sessionId);
  if (!state?.activeProjectId) return null;
  const project = store.getProject(state.activeProjectId);
  if (!project || project.status === 'archived') return null;
  return project;
}

/** 把当前会话切到某个项目；找不到抛错（给工具/命令直接回报）。 */
export function switchProject(store, sessionId, ident) {
  const project = resolveProject(store, ident);
  if (!project) throw new Error(`找不到项目「${ident}」；可先 soul_project(action="list") 看看现有项目`);
  store.touchProject(project.id);
  if (sessionId) store.setSessionState(sessionId, { activeProjectId: project.id });
  return project;
}

/** 新建/更新项目（同名合并，不会重复建）。 */
export function upsertProject(store, { name, goal, stage, status } = {}) {
  const cleanName = String(name ?? '').trim();
  if (cleanName === '') throw new Error('项目名不能为空');
  return store.upsertProject({
    name: cleanName,
    goal: goal ?? '',
    stage: stage ?? '',
    status: PROJECT_STATUSES.includes(status) ? status : 'active',
    source: 'tool',
  });
}

/** 往项目里记一条（默认记到会话活跃项目；没有活跃项目则按内容匹配项目名）。 */
export function addProjectEntry(store, sessionId, {
  project: ident = '',
  kind = '',
  content,
  priority = 0,
  acceptance = '',
  dependsOn = '',
} = {}) {
  const text = String(content ?? '').trim();
  if (text === '') throw new Error('内容不能为空');
  const target = ident
    ? resolveProject(store, ident)
    : (activeProject(store, sessionId) ?? store.matchProject(text));
  if (!target) {
    throw new Error('没有活跃项目：请先用 soul_project(action="upsert") 建项目，或传 project 参数');
  }
  const resolvedKind = PROJECT_ITEM_KINDS.includes(kind) ? kind : classifyProjectNote(text);
  const item = store.addProjectItem(target.id, resolvedKind, text, {
    priority: Number(priority) || 0,
    acceptance: acceptance ?? '',
    dependsOn: dependsOn ?? '',
    source: 'tool',
  });
  return { project: target, item, kind: resolvedKind };
}

/**
 * 自动保存一条项目进展（hooks 用）：只在有活跃项目或能明确匹配到项目时才落地，
 * 不抛错、不打扰对话。返回 null 表示这条与项目无关。
 */
export function maybeRecordProjectNote(store, sessionId, content, { source = 'auto' } = {}) {
  const text = String(content ?? '').trim();
  if (text.length < 4) return null;
  const target = activeProject(store, sessionId) ?? store.matchProject(text);
  if (!target) return null;
  const kind = classifyProjectNote(text);
  const item = store.addProjectItem(target.id, kind, clip(text, 160), { source });
  return { project: target, item, kind };
}

/** 新建任务（最小状态机 pending → in_progress → blocked/completed）。 */
export function addTask(store, { projectId = 0, title, state = 'pending', priority = 0, acceptance = '', dependsOn = '' } = {}) {
  return store.addTask({
    projectId: Math.max(0, Number(projectId) || 0),
    title,
    state: TASK_STATES.includes(state) ? state : 'pending',
    priority: Number(priority) || 0,
    acceptance: acceptance ?? '',
    dependsOn: dependsOn ?? '',
    source: 'tool',
  });
}

/** 一句话任务行（给工具/命令渲染）。 */
export function taskLine(task) {
  const bits = [`#${task.id}`, `[${task.state}]`, clip(task.title, 90)];
  if (task.priority) bits.push(`P${task.priority}`);
  if (task.dependsOn) bits.push(`依赖 ${clip(task.dependsOn, 30)}`);
  if (task.acceptance) bits.push(`验收 ${clip(task.acceptance, 40)}`);
  return bits.join(' ');
}
