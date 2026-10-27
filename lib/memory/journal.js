/**
 * journal — 项目工作日志（「今天做了什么 / 计划 / 想法」）。
 *
 * 为什么需要它（用户原话：希望不用自己提醒，也能看到项目进度和记录）：
 *   · project_items 存的是「稳定的项目档案」（已完成/决定/待办…），
 *     不适合放每一轮的过程性记录，否则会很快变成噪音；
 *   · turns 存的是原始对话，不方便人看；
 *   · journal 存「按天、按项目、带类型的短条目」，是给人和检索用的中间层：
 *     - progress/work：这轮实际推进了什么（有工具调用/文件改动时记）
 *     - plan/idea：想做什么 / 冒出的想法
 *     - decision：拍板
 *     - issue：发现的问题、卡点
 *     全部带来源（session/turn/refs/evidence），状态 auto → 用户确认后可置 confirmed。
 *
 * 所有函数不调用模型，纯数据库操作；语义抽取（semantic.js）负责给出高质量条目，
 * 本模块负责落库、去重、按天聚合与格式化。
 */
import { clip, normText } from '../util.js';

/** 允许的日志类型（与自然语言里的「做了什么/计划/想法」对应）。 */
export const JOURNAL_KINDS = Object.freeze(['progress', 'work', 'plan', 'idea', 'decision', 'issue', 'done', 'note']);

/** 语义抽取的 projectUpdates.kind 映射到 journal kind。 */
export function normalizeJournalKind(kind) {
  const text = String(kind ?? '').trim().toLowerCase();
  if (JOURNAL_KINDS.includes(text)) return text;
  if (/done|完成|结束/.test(text)) return 'done';
  if (/plan|next|计划|下一步/.test(text)) return 'plan';
  if (/idea|想法|灵感/.test(text)) return 'idea';
  if (/decision|决定|拍板/.test(text)) return 'decision';
  if (/issue|problem|问题|bug|阻塞|卡/.test(text)) return 'issue';
  if (/progress|进展|推进|完成/.test(text)) return 'progress';
  if (/note|备注/.test(text)) return 'note';
  return 'work';
}

/**
 * 写入一条工作日志。同一项目、同类型、24 小时内内容重复时只累加 hits（不增生）。
 * @returns {{id:number, inserted:boolean, projectId:number, kind:string, summary:string}}
 */
export function recordJournal(store, {
  projectId,
  sessionId = '',
  turn = null,
  kind = 'work',
  summary = '',
  refs = '',
  status = 'auto',
  confidence = 0.6,
} = {}) {
  const pid = Number(projectId);
  const text = clip(String(summary ?? '').replace(/\s+/g, ' ').trim(), 220);
  if (!Number.isFinite(pid) || pid <= 0 || text === '') return null;
  const jkind = normalizeJournalKind(kind);
  const norm = normText(text).slice(0, 160);
  const now = Date.now();
  const db = store.db;
  const existing = db.prepare(`SELECT * FROM project_journal
    WHERE project_id = ? AND norm = ? AND created_at >= ? ORDER BY id DESC LIMIT 1`)
    .get(pid, norm, now - 86_400_000);
  if (existing) {
    db.prepare('UPDATE project_journal SET hits = hits + 1, updated_at = ? WHERE id = ?').run(now, existing.id);
    return { id: Number(existing.id), inserted: false, projectId: pid, kind: String(existing.kind), summary: String(existing.summary) };
  }
  const info = db.prepare(`INSERT INTO project_journal
    (project_id, session_id, turn, kind, status, summary, norm, refs, hits, confidence, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`)
    .run(pid, String(sessionId ?? ''), turn == null ? null : Number(turn), jkind, String(status), text, norm, String(refs ?? ''), Number(confidence) || 0.6, now, now);
  return { id: Number(info.lastInsertRowid ?? 0), inserted: true, projectId: pid, kind: jkind, summary: text };
}

/** 列日志（按项目/时间过滤）。 */
export function listJournal(store, { projectId = 0, limit = 50, since = 0 } = {}) {
  const pid = Number(projectId);
  const n = Math.min(200, Math.max(1, Number(limit) || 50));
  const rows = pid > 0
    ? store.db.prepare('SELECT * FROM project_journal WHERE project_id = ? AND created_at >= ? ORDER BY created_at DESC LIMIT ?').all(pid, Number(since) || 0, n)
    : store.db.prepare('SELECT * FROM project_journal WHERE created_at >= ? ORDER BY created_at DESC LIMIT ?').all(Number(since) || 0, n);
  return rows.map(rowToJournal);
}

/** 一条项目最近的工作日志。 */
export function recentJournal(store, projectId, limit = 5) {
  return listJournal(store, { projectId, limit });
}

function rowToJournal(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    sessionId: String(row.session_id ?? ''),
    turn: row.turn == null ? null : Number(row.turn),
    kind: String(row.kind ?? ''),
    status: String(row.status ?? 'auto'),
    summary: String(row.summary ?? ''),
    refs: String(row.refs ?? ''),
    hits: Number(row.hits ?? 1),
    confidence: Number(row.confidence ?? 0.6),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

/**
 * 判断本轮对话属于哪个项目（不强建项目）：
 *   1) 会话状态里显式选中的活跃项目；
 *   2) 文本里命中已有项目名（含部分词）；
 *   3) 都没有则返回 null（不把闲聊硬塞进项目）。
 */
export function projectAttribution(store, { sessionId = '', texts = [] } = {}) {
  try {
    const state = sessionId ? store.getSessionState(sessionId) : null;
    const activeId = Number(state?.activeProjectId ?? 0);
    if (activeId > 0) {
      const project = store.getProject(activeId);
      if (project && project.status === 'active') return project;
    }
    const joined = texts.filter(Boolean).join('\n');
    if (joined.trim() === '') return null;
    const matched = store.matchProject ? store.matchProject(joined) : null;
    if (matched) return matched;
  } catch {
    // 归类失败不影响日志主流程。
  }
  return null;
}

/**
 * 今日摘要：今天各项目的工作日志按类型分组 + 今日回合统计。
 * @returns {{dayStart:number, dayEnd:number, totalEntries:number, turns:number, projects:{project:object|null, entries:Record<string, object[]>}[]}}
 */
export function todayDigest(store, { projectId = 0, now = Date.now() } = {}) {
  const start = startOfLocalDay(now);
  const end = start + 86_400_000;
  const entries = listJournal(store, { projectId, limit: 200, since: start }).filter((e) => e.createdAt < end);
  const groups = new Map();
  for (const entry of entries) {
    const key = entry.projectId;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(entry);
  }
  const projects = [];
  for (const [pid, list] of groups) {
    const project = store.getProject(pid) ?? null;
    const grouped = { progress: [], work: [], plan: [], idea: [], decision: [], issue: [], done: [], note: [] };
    for (const entry of list) {
      if (!grouped[entry.kind]) grouped[entry.kind] = [];
      grouped[entry.kind].push(entry);
    }
    const count = Object.values(grouped).reduce((sum, arr) => sum + arr.length, 0);
    projects.push({ project, entries: grouped, count });
  }
  projects.sort((a, b) => b.count - a.count);
  let turns = 0;
  try {
    turns = Number(store.db.prepare('SELECT COUNT(*) AS n FROM turns WHERE ended_at >= ? AND ended_at < ?').get(start, end)?.n ?? 0);
  } catch { turns = 0; }
  return { dayStart: start, dayEnd: end, totalEntries: entries.length, turns, projects };
}

function startOfLocalDay(now) {
  const date = new Date(Number(now) || Date.now());
  date.setHours(0, 0, 0, 0);
  return date.getTime();
}

/** 今日摘要 → 给命令/工具展示的短文本。 */
export function formatTodayDigest(digest, { projectName = '' } = {}) {
  const date = new Date(digest.dayStart);
  const label = `${date.getMonth() + 1} 月 ${date.getDate()} 日`;
  const head = projectName ? `📅 ${label} · 项目「${projectName}」` : `📅 ${label} · 今日记录`;
  const lines = [head, `今日回合：${digest.turns} · 记录 ${digest.totalEntries} 条`];
  const kindLabels = { progress: '进展', work: '工作', plan: '计划', idea: '想法', decision: '决定', issue: '问题', done: '完成', note: '备注' };
  for (const group of digest.projects) {
    if (group.project) lines.push(`\n【${group.project.name}】阶段：${group.project.stage || '—'}`);
    for (const [kind, list] of Object.entries(group.entries)) {
      if (!list || list.length === 0) continue;
      lines.push(`${kindLabels[kind] ?? kind}：`);
      for (const entry of list.slice(0, 5)) lines.push(`  · ${entry.summary}`);
    }
  }
  if (digest.totalEntries === 0) lines.push('（今天还没记录到工作日志；有进展时会自动写入。）');
  return lines.join('\n');
}

/** 项目日志 → 单项目短文本（命令 /soul journal 用）。 */
export function formatJournalEntries(entries, { projectName = '', limit = 20 } = {}) {
  const lines = [];
  const kindLabels = { progress: '进展', work: '工作', plan: '计划', idea: '想法', decision: '决定', issue: '问题', done: '完成', note: '备注' };
  for (const entry of entries.slice(0, limit)) {
    const date = new Date(entry.createdAt);
    const stamp = `${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
    const status = entry.status === 'confirmed' ? '✓' : '';
    lines.push(`${stamp} [${kindLabels[entry.kind] ?? entry.kind}]${status} ${entry.summary}${entry.turn != null ? `（第${entry.turn}轮）` : ''}`);
  }
  if (projectName) return `【${projectName}】最近 ${lines.length} 条工作日志：\n${lines.join('\n')}`;
  return lines.join('\n');
}
