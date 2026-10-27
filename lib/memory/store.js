/**
 * dsh-soul store — 插件自己的 SQLite 记忆库。
 *
 * 为什么用独立库（而不是复用宿主 session 存储）：
 *   · 宿主 session 负责「会话历史」，本库负责「跨会话仍然成立的事实」；
 *   · 两者生命周期不同：会话可以被压缩、删除、fork，长期记忆不应跟着消失；
 *   · 记忆有去重、纠正、归档、置信度等宿主不需要的语义。
 *
 * 存储选型：node:sqlite（Node ≥ 22.13 内置，零原生编译依赖），文件放在
 * <DSH_HOME>/dsh-soul/soul.db，默认不进任何工作区。
 *
 * 迁移：PRAGMA user_version + MIGRATIONS 列表，启动时按版本顺序执行；
 * 损坏恢复：WAL 模式下崩溃不丢已提交事务；打开失败由 index.js 明确报错
 * （不静默降级），并提供 backupFile() 供手动备份。
 */
import { DatabaseSync } from 'node:sqlite';
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';
import { normText } from '../util.js';

export const SCHEMA_VERSION = 6;

/** 允许的记忆类型（与任务书 §5.1 一一对应）。 */
export const MEMORY_TYPES = Object.freeze([
  'preference',   // A. 稳定偏好
  'profile',      // A. 用户画像（称呼、身份、环境）
  'episodic',     // B. 情景记忆（共同经历、关键决定 + 背景）
  'project',      // C. 项目记忆
  'interaction',  // D. 交互经验（喜欢/不喜欢怎么被对待）
  'relationship', // E. 关系连续性（称呼、共同梗、边界）
  'fact',         // 兜底的事实
]);

/** 判断日志的类型（主动性改造 v0.7）：read=读意图，care=该不该关心，memory=记忆取舍。 */
export const JUDGMENT_KINDS = Object.freeze(['read', 'care', 'memory', 'other']);

export const PROJECT_ITEM_KINDS = Object.freeze([
  'done', 'decision', 'todo', 'issue', 'blocker', 'next', 'note', 'file', 'session',
]);

export const TASK_STATES = Object.freeze(['pending', 'in_progress', 'blocked', 'completed']);

const BASE_SCHEMA = `
CREATE TABLE IF NOT EXISTS meta (k TEXT PRIMARY KEY, v TEXT NOT NULL);

CREATE TABLE IF NOT EXISTS memories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  content TEXT NOT NULL,
  norm TEXT NOT NULL UNIQUE,
  tags TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  confidence REAL NOT NULL DEFAULT 0.6,
  importance REAL NOT NULL DEFAULT 0.5,
  status TEXT NOT NULL DEFAULT 'active',
  project_id INTEGER,
  session_id TEXT,
  created_by TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_accessed_at INTEGER,
  superseded_by INTEGER,
  FOREIGN KEY(project_id) REFERENCES projects(id) ON DELETE SET NULL
);
CREATE INDEX IF NOT EXISTS memories_status_type ON memories(status, type, updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_updated ON memories(updated_at DESC);
CREATE INDEX IF NOT EXISTS memories_project ON memories(project_id);

CREATE TABLE IF NOT EXISTS memory_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  action TEXT NOT NULL,
  before_json TEXT,
  after_json TEXT,
  reason TEXT,
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_history_mid ON memory_history(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS emotion (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  valence REAL NOT NULL DEFAULT 0,
  label TEXT NOT NULL DEFAULT '轻松',
  reason TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS projects (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  slug TEXT NOT NULL UNIQUE,
  goal TEXT NOT NULL DEFAULT '',
  stage TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  last_touched_at INTEGER
);

CREATE TABLE IF NOT EXISTS project_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  kind TEXT NOT NULL,
  content TEXT NOT NULL,
  norm TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'open',
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, kind, norm)
);
CREATE INDEX IF NOT EXISTS project_items_kind ON project_items(project_id, kind, state);

CREATE TABLE IF NOT EXISTS tasks (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL DEFAULT 0,
  title TEXT NOT NULL,
  norm TEXT NOT NULL,
  state TEXT NOT NULL DEFAULT 'pending',
  priority INTEGER NOT NULL DEFAULT 0,
  depends_on TEXT NOT NULL DEFAULT '',
  acceptance TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'auto',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  UNIQUE(project_id, norm)
);
CREATE INDEX IF NOT EXISTS tasks_state ON tasks(state, project_id);

CREATE TABLE IF NOT EXISTS sessions (
  session_id TEXT PRIMARY KEY,
  origin TEXT NOT NULL DEFAULT '',
  cwd TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  last_seen_at INTEGER NOT NULL,
  turns INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS turns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL,
  turn INTEGER NOT NULL,
  user_text TEXT NOT NULL DEFAULT '',
  assistant_text TEXT NOT NULL DEFAULT '',
  tool_calls INTEGER NOT NULL DEFAULT 0,
  reason TEXT NOT NULL DEFAULT '',
  started_at INTEGER,
  ended_at INTEGER NOT NULL,
  extracted_at INTEGER,
  UNIQUE(session_id, turn)
);
CREATE INDEX IF NOT EXISTS turns_ended ON turns(ended_at DESC);
CREATE INDEX IF NOT EXISTS turns_session ON turns(session_id, ended_at DESC);

CREATE TABLE IF NOT EXISTS session_states (
  session_id TEXT PRIMARY KEY,
  mode TEXT NOT NULL DEFAULT '',
  active_project_id INTEGER NOT NULL DEFAULT 0,
  last_user_text TEXT NOT NULL DEFAULT '',
  open_question TEXT NOT NULL DEFAULT '',
  updated_at INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS relation (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  user_alias TEXT NOT NULL DEFAULT '',
  agent_alias TEXT NOT NULL DEFAULT '',
  tone TEXT NOT NULL DEFAULT '',
  boundaries TEXT NOT NULL DEFAULT '',
  shared_terms TEXT NOT NULL DEFAULT '',
  first_seen INTEGER,
  last_seen INTEGER,
  turns INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL
);

-- v0.7 判断日志：主动性来自「每轮有自己的假设，并且能被验证/推翻」。
-- 这里存的是模型对「这句话到底想要什么」的判断，以及事后结果；
-- 它不是记忆（不参与记忆检索/注入的事实部分），只作为下一轮判断的素材。
CREATE TABLE IF NOT EXISTS judgments (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  session_id TEXT NOT NULL DEFAULT '',
  kind TEXT NOT NULL DEFAULT 'read',
  subject TEXT NOT NULL DEFAULT '',
  guess TEXT NOT NULL,
  outcome TEXT NOT NULL DEFAULT 'open',
  note TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS judgments_outcome ON judgments(outcome, updated_at DESC);
CREATE INDEX IF NOT EXISTS judgments_session ON judgments(session_id, updated_at DESC);

CREATE TABLE IF NOT EXISTS memory_evidence (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  memory_id INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  turn INTEGER,
  event_seq INTEGER,
  role TEXT NOT NULL DEFAULT '',
  quote TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS memory_evidence_mid ON memory_evidence(memory_id, created_at DESC);

CREATE TABLE IF NOT EXISTS project_journal (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  project_id INTEGER NOT NULL,
  session_id TEXT NOT NULL DEFAULT '',
  turn INTEGER,
  kind TEXT NOT NULL DEFAULT 'work',
  status TEXT NOT NULL DEFAULT 'auto',
  summary TEXT NOT NULL,
  norm TEXT NOT NULL,
  refs TEXT NOT NULL DEFAULT '',
  hits INTEGER NOT NULL DEFAULT 1,
  confidence REAL NOT NULL DEFAULT 0.6,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS project_journal_proj ON project_journal(project_id, created_at DESC);
CREATE INDEX IF NOT EXISTS project_journal_time ON project_journal(created_at DESC);

CREATE TABLE IF NOT EXISTS relation_history (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  field TEXT NOT NULL,
  old_value TEXT NOT NULL DEFAULT '',
  new_value TEXT NOT NULL DEFAULT '',
  session_id TEXT NOT NULL DEFAULT '',
  turn INTEGER,
  reason TEXT NOT NULL DEFAULT '',
  created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS relation_history_time ON relation_history(created_at DESC);

CREATE TABLE IF NOT EXISTS embeddings (
  kind TEXT NOT NULL,
  ref_id INTEGER NOT NULL,
  vector BLOB NOT NULL,
  dim INTEGER NOT NULL DEFAULT 0,
  updated_at INTEGER NOT NULL,
  PRIMARY KEY (kind, ref_id)
);
`;

/** FTS 单独建：宿主内置 SQLite 若缺 FTS5/trigram，退化为 LIKE 检索而不是拒绝启动。 */
const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS memories_fts USING fts5(content, tags, content='memories', content_rowid='id', tokenize='trigram');
CREATE TRIGGER IF NOT EXISTS memories_ai AFTER INSERT ON memories BEGIN
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_ad AFTER DELETE ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
END;
CREATE TRIGGER IF NOT EXISTS memories_au AFTER UPDATE OF content, tags ON memories BEGIN
  INSERT INTO memories_fts(memories_fts, rowid, content, tags) VALUES ('delete', old.id, old.content, old.tags);
  INSERT INTO memories_fts(rowid, content, tags) VALUES (new.id, new.content, new.tags);
END;
`;

const MIGRATIONS = [
  // v1 是初始 schema，由 BASE_SCHEMA 幂等创建。
  // v2：importance（记忆重要性）+ status='candidate'（候选记忆）——候选在重复出现、
  // 用户确认或手动 approve 后才转为 active，避免把一次性的随口信息固化成长期事实。
  { version: 2, sql: 'ALTER TABLE memories ADD COLUMN importance REAL NOT NULL DEFAULT 0.5' },
  // v3：记忆证据链（每条记忆可追溯到真实会话事件）+ 项目工作日志（今天做了什么/计划/想法）
  //     + 创建者字段（用户/助手/系统）+ 回合抽取标记（语义抽取幂等，不重复处理）。
  //     新表在 BASE_SCHEMA 里也会幂等创建；这里只补老库缺的列与索引。
  { version: 3, sql: "ALTER TABLE memories ADD COLUMN created_by TEXT NOT NULL DEFAULT ''" },
  { version: 3, sql: 'ALTER TABLE turns ADD COLUMN extracted_at INTEGER' },
  // 迁移前已存在的历史回合统一标记为已抽取：只处理 v0.6 之后的新回合，
  // 避免首次升级时把几十条旧对话一次性重新抽取、制造噪声记忆。
  { version: 3, sql: "UPDATE turns SET extracted_at = COALESCE(ended_at, CAST(strftime('%s','now') AS INTEGER) * 1000) WHERE extracted_at IS NULL" },
  { version: 3, sql: 'CREATE INDEX IF NOT EXISTS memory_evidence_mid ON memory_evidence(memory_id, created_at DESC)' },
  { version: 3, sql: 'CREATE INDEX IF NOT EXISTS project_journal_proj ON project_journal(project_id, created_at DESC)' },
  { version: 3, sql: 'CREATE INDEX IF NOT EXISTS project_journal_time ON project_journal(created_at DESC)' },
  { version: 3, sql: 'CREATE INDEX IF NOT EXISTS relation_history_time ON relation_history(created_at DESC)' },
  // v4：判断日志（主动性=每轮判断且可修正）。新库由 BASE_SCHEMA 幂等创建，这里只补老库。
  {
    version: 4,
    sql: `CREATE TABLE IF NOT EXISTS judgments (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      session_id TEXT NOT NULL DEFAULT '',
      kind TEXT NOT NULL DEFAULT 'read',
      subject TEXT NOT NULL DEFAULT '',
      guess TEXT NOT NULL,
      outcome TEXT NOT NULL DEFAULT 'open',
      note TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS judgments_outcome ON judgments(outcome, updated_at DESC);
    CREATE INDEX IF NOT EXISTS judgments_session ON judgments(session_id, updated_at DESC);`,
  },
  // v5：向量索引（语义检索）。只存向量不存原文，记忆删除/归档时对应行一并清掉；
  // 换模型要整表重建（维度会变），所以 meta 里记一个 embedding.model。
  {
    version: 5,
    sql: `CREATE TABLE IF NOT EXISTS embeddings (
      kind TEXT NOT NULL,
      ref_id INTEGER NOT NULL,
      vector BLOB NOT NULL,
      dim INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL,
      PRIMARY KEY (kind, ref_id)
    );`,
  },
  // v6：情绪（主动性的情绪层）。一条全局记录（id=1），过时/衰减由 lib/emotion.js 处理；
  // 拆掉 knock 插件后情绪照常工作，只是没有「谁在什么时候开口」的调度器。
  {
    version: 6,
    sql: `CREATE TABLE IF NOT EXISTS emotion (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      valence REAL NOT NULL DEFAULT 0,
      label TEXT NOT NULL DEFAULT '轻松',
      reason TEXT NOT NULL DEFAULT '',
      updated_at INTEGER NOT NULL DEFAULT 0
    );`,
  },
];

function escapeLike(text) {
  return String(text ?? '').replace(/[\\%_]/g, (m) => `\\${m}`);
}

function mergeTags(oldTags, newTags) {
  const set = new Set();
  for (const part of `${oldTags ?? ''} ${newTags ?? ''}`.split(/\s+/)) {
    if (part !== '') set.add(part);
  }
  return [...set].join(' ');
}

/**
 * 打开（或创建）记忆库。
 * @param {string} path
 * @returns {Store}
 */
export function openStore(path) {
  mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  try { db.exec('PRAGMA journal_mode = WAL'); } catch { /* 旧 sqlite 忽略 */ }
  try { db.exec('PRAGMA synchronous = NORMAL'); } catch { /* 同上 */ }
  try { db.exec('PRAGMA foreign_keys = ON'); } catch { /* 同上 */ }
  // 多进程安全：插件宿主进程与迁移脚本/检查脚本可能同时访问同一个库文件。
  try { db.exec('PRAGMA busy_timeout = 5000'); } catch { /* 同上 */ }
  // 关键顺序：构造函数会 prepare 引用 meta/memories 等表的语句，
  // 因此必须先建表，再 new Store（否则新库上报 "no such table: meta"）。
  ensureSchema(db, path);
  const store = new Store(db, path);
  store.migrate();
  return store;
}

/**
 * 幂等建表 + 版本迁移（先建基础表，再按 user_version 顺序迁移，最后尝试 FTS）。
 * 升级前自动备份（WAL checkpoint 后复制主文件），备份失败不阻塞启动。
 */
function ensureSchema(db, path) {
  db.exec(BASE_SCHEMA);
  let version = 0;
  try {
    version = Number(db.prepare('PRAGMA user_version').get()?.user_version ?? 0);
  } catch { version = 0; }
  if (version > 0 && version < SCHEMA_VERSION) {
    try {
      db.exec('PRAGMA wal_checkpoint(TRUNCATE)');
      copyFileSync(path, `${path}.bak-v${version}-${Date.now()}`);
    } catch { /* 备份失败不阻塞升级；调用方日志会暴露路径问题 */ }
  }
  if (version > 0) {
    for (const migration of MIGRATIONS) {
      if (version >= migration.version) continue;
      try {
        db.exec(migration.sql);
      } catch (error) {
        // 手工改过库/重复启动时列可能已存在：视为已迁移，不让插件因此挂掉。
        if (!/duplicate column|already exists/i.test(String(error?.message ?? error))) throw error;
      }
    }
  }
  try { db.exec(FTS_SCHEMA); } catch { /* 无 FTS5 环境 */ }
  try { db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`); } catch { /* 忽略 */ }
}

export class Store {
  constructor(db, path) {
    this.db = db;
    this.path = path;
    this.hasFts = false;
    this.stmt = {
      metaGet: db.prepare('SELECT v FROM meta WHERE k = ?'),
      metaSet: db.prepare('INSERT INTO meta (k, v) VALUES (?, ?) ON CONFLICT(k) DO UPDATE SET v = excluded.v'),

      memByNorm: db.prepare('SELECT * FROM memories WHERE norm = ?'),
      memById: db.prepare('SELECT * FROM memories WHERE id = ?'),
      memInsert: db.prepare(`
        INSERT INTO memories (type, content, norm, tags, source, confidence, importance, status, project_id, session_id, created_by, hits, created_at, updated_at, last_accessed_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, NULL)
        RETURNING *`),
      memBump: db.prepare(`
        UPDATE memories SET
          hits = hits + 1,
          confidence = max(confidence, ?),
          importance = max(importance, ?),
          content = CASE WHEN length(?) > length(content) THEN ? ELSE content END,
          tags = ?,
          source = ?,
          status = 'active',
          superseded_by = NULL,
          updated_at = ?,
          last_accessed_at = ?
        WHERE id = ?
        RETURNING *`),
      memCandidateBump: db.prepare(`
        UPDATE memories SET
          hits = hits + 1,
          confidence = max(confidence, ?),
          importance = max(importance, ?),
          content = CASE WHEN length(?) > length(content) THEN ? ELSE content END,
          tags = ?,
          status = CASE WHEN hits + 1 >= ? THEN 'active' ELSE status END,
          updated_at = ?,
          last_accessed_at = ?
        WHERE id = ?
        RETURNING *`),
      memReinforce: db.prepare(`
        UPDATE memories SET
          hits = hits + 1,
          confidence = max(confidence, ?),
          importance = max(importance, ?),
          content = CASE WHEN length(?) > length(content) THEN ? ELSE content END,
          tags = ?,
          updated_at = ?,
          last_accessed_at = ?
        WHERE id = ?
        RETURNING *`),
      memCandidateList: db.prepare("SELECT * FROM memories WHERE status = 'candidate' ORDER BY confidence DESC, updated_at DESC LIMIT ?"),
      memPromote: db.prepare("UPDATE memories SET status = 'active', updated_at = ?, last_accessed_at = ? WHERE id = ? RETURNING *"),
      memStatus: db.prepare('UPDATE memories SET status = ?, superseded_by = ?, updated_at = ? WHERE id = ?'),
      memTouch: db.prepare('UPDATE memories SET last_accessed_at = ?, hits = hits + 1 WHERE id = ?'),
      memDelete: db.prepare('DELETE FROM memories WHERE id = ?'),
      memList: db.prepare(`SELECT * FROM memories WHERE status = ? ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?`),
      memListType: db.prepare(`SELECT * FROM memories WHERE status = ? AND type = ? ORDER BY confidence DESC, updated_at DESC LIMIT ? OFFSET ?`),
      memLike: db.prepare(`SELECT * FROM memories WHERE status = 'active' AND (content LIKE ? ESCAPE '\\' OR tags LIKE ? ESCAPE '\\')
        ORDER BY confidence DESC, updated_at DESC LIMIT ?`),
      memFts: db.prepare(`SELECT m.* FROM memories_fts JOIN memories m ON m.id = memories_fts.rowid
        WHERE memories_fts MATCH ? AND m.status = 'active' ORDER BY m.confidence DESC, m.updated_at DESC LIMIT ?`),
      memTop: db.prepare(`SELECT * FROM memories WHERE status = 'active'
        ORDER BY (confidence * (1 + min(hits, 12) * 0.05) + (updated_at / 1e14)) DESC LIMIT ?`),
      memCounts: db.prepare('SELECT type, status, count(*) AS n FROM memories GROUP BY type, status'),
      memCountAll: db.prepare("SELECT count(*) AS n FROM memories WHERE status = 'active'"),

      histIns: db.prepare('INSERT INTO memory_history (memory_id, action, before_json, after_json, reason, created_at) VALUES (?, ?, ?, ?, ?, ?)'),
      histList: db.prepare('SELECT * FROM memory_history WHERE memory_id = ? ORDER BY created_at DESC LIMIT ?'),

      projectBySlug: db.prepare('SELECT * FROM projects WHERE slug = ?'),
      projectById: db.prepare('SELECT * FROM projects WHERE id = ?'),
      projectInsert: db.prepare(`INSERT INTO projects (name, slug, goal, stage, status, source, created_at, updated_at, last_touched_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      projectUpdate: db.prepare(`UPDATE projects SET name = ?, goal = ?, stage = ?, status = ?, source = ?, updated_at = ?, last_touched_at = ? WHERE id = ? RETURNING *`),
      projectList: db.prepare('SELECT * FROM projects WHERE status = ? ORDER BY COALESCE(last_touched_at, updated_at) DESC LIMIT ?'),
      projectAll: db.prepare("SELECT * FROM projects WHERE status != 'archived' ORDER BY COALESCE(last_touched_at, updated_at) DESC LIMIT ?"),
      projectTouch: db.prepare('UPDATE projects SET last_touched_at = ?, updated_at = ? WHERE id = ?'),
      projectDelete: db.prepare('DELETE FROM projects WHERE id = ?'),

      itemByKey: db.prepare('SELECT * FROM project_items WHERE project_id = ? AND kind = ? AND norm = ?'),
      itemById: db.prepare('SELECT * FROM project_items WHERE id = ?'),
      itemInsert: db.prepare(`INSERT INTO project_items (project_id, kind, content, norm, state, priority, depends_on, acceptance, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      itemUpdate: db.prepare(`UPDATE project_items SET content = ?, state = ?, priority = ?, depends_on = ?, acceptance = ?, updated_at = ? WHERE id = ? RETURNING *`),
      itemSetState: db.prepare('UPDATE project_items SET state = ?, updated_at = ? WHERE id = ?'),
      itemDelete: db.prepare('DELETE FROM project_items WHERE id = ?'),
      itemList: db.prepare('SELECT * FROM project_items WHERE project_id = ? ORDER BY (state = \'open\') DESC, priority DESC, updated_at DESC LIMIT ?'),
      itemListKind: db.prepare('SELECT * FROM project_items WHERE project_id = ? AND kind = ? ORDER BY priority DESC, updated_at DESC LIMIT ?'),

      taskByKey: db.prepare('SELECT * FROM tasks WHERE project_id = ? AND norm = ?'),
      taskById: db.prepare('SELECT * FROM tasks WHERE id = ?'),
      taskInsert: db.prepare(`INSERT INTO tasks (project_id, title, norm, state, priority, depends_on, acceptance, source, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?) RETURNING *`),
      taskUpdate: db.prepare('UPDATE tasks SET title = ?, state = ?, priority = ?, depends_on = ?, acceptance = ?, updated_at = ? WHERE id = ?'),
      taskSetState: db.prepare('UPDATE tasks SET state = ?, updated_at = ? WHERE id = ?'),
      taskList: db.prepare('SELECT * FROM tasks WHERE (? = 0 OR project_id = ?) AND (? = \'\' OR state = ?) ORDER BY priority DESC, updated_at DESC LIMIT ?'),
      taskOpen: db.prepare("SELECT * FROM tasks WHERE state IN ('pending','in_progress','blocked') ORDER BY priority DESC, updated_at DESC LIMIT ?"),

      sessionUpsert: db.prepare(`INSERT INTO sessions (session_id, origin, cwd, started_at, last_seen_at, turns)
        VALUES (?, ?, ?, ?, ?, 0)
        ON CONFLICT(session_id) DO UPDATE SET
          last_seen_at = excluded.last_seen_at,
          origin = CASE WHEN excluded.origin != '' THEN excluded.origin ELSE sessions.origin END,
          cwd = CASE WHEN excluded.cwd != '' THEN excluded.cwd ELSE sessions.cwd END`),
      sessionGet: db.prepare('SELECT * FROM sessions WHERE session_id = ?'),
      sessionBumpTurn: db.prepare('UPDATE sessions SET turns = turns + 1, last_seen_at = ? WHERE session_id = ?'),
      sessionCount: db.prepare('SELECT count(*) AS n FROM sessions'),

      turnExists: db.prepare('SELECT id FROM turns WHERE session_id = ? AND turn = ?'),
      turnInsert: db.prepare(`INSERT INTO turns (session_id, turn, user_text, assistant_text, tool_calls, reason, started_at, ended_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`),
      turnUpdate: db.prepare(`UPDATE turns SET
          user_text = CASE WHEN ? != '' THEN ? ELSE user_text END,
          assistant_text = CASE WHEN ? != '' THEN ? ELSE assistant_text END,
          tool_calls = max(tool_calls, ?),
          reason = CASE WHEN ? != '' THEN ? ELSE reason END,
          ended_at = ?
        WHERE id = ?`),
      turnRecent: db.prepare('SELECT * FROM turns ORDER BY ended_at DESC LIMIT ?'),
      turnRecentSession: db.prepare('SELECT * FROM turns WHERE session_id = ? ORDER BY ended_at DESC LIMIT ?'),
      turnUserRecent: db.prepare("SELECT user_text, ended_at FROM turns WHERE user_text != '' ORDER BY ended_at DESC LIMIT ?"),
      turnCount: db.prepare('SELECT count(*) AS n FROM turns'),
      turnPrune: db.prepare('DELETE FROM turns WHERE ended_at < ?'),
      turnTrim: db.prepare('DELETE FROM turns WHERE id NOT IN (SELECT id FROM turns ORDER BY id DESC LIMIT ?)'),

      embeddingSet: db.prepare(`INSERT INTO embeddings (kind, ref_id, vector, dim, updated_at)
        VALUES (?, ?, ?, ?, ?)
        ON CONFLICT(kind, ref_id) DO UPDATE SET vector = excluded.vector, dim = excluded.dim, updated_at = excluded.updated_at`),
      embeddingGet: db.prepare('SELECT * FROM embeddings WHERE kind = ? AND ref_id = ?'),
      embeddingList: db.prepare('SELECT * FROM embeddings WHERE kind = ?'),
      embeddingDelete: db.prepare('DELETE FROM embeddings WHERE kind = ? AND ref_id = ?'),
      embeddingCount: db.prepare('SELECT count(*) AS n FROM embeddings WHERE kind = ?'),

      stateGet: db.prepare('SELECT * FROM session_states WHERE session_id = ?'),
      stateInsert: db.prepare(`INSERT INTO session_states (session_id, mode, active_project_id, last_user_text, open_question, updated_at)
        VALUES (?, ?, ?, ?, ?, ?) RETURNING *`),
      stateSetLastUser: db.prepare('UPDATE session_states SET last_user_text = ?, updated_at = ? WHERE session_id = ?'),
      stateSetProject: db.prepare('UPDATE session_states SET active_project_id = ?, updated_at = ? WHERE session_id = ?'),
      stateSetMode: db.prepare('UPDATE session_states SET mode = ?, updated_at = ? WHERE session_id = ?'),
      stateSetQuestion: db.prepare('UPDATE session_states SET open_question = ?, updated_at = ? WHERE session_id = ?'),

      relGet: db.prepare('SELECT * FROM relation WHERE id = 1'),
      relInsert: db.prepare(`INSERT INTO relation (id, user_alias, agent_alias, tone, boundaries, shared_terms, first_seen, last_seen, turns, updated_at)
        VALUES (1, '', '', '', '', '', ?, ?, 0, ?) ON CONFLICT(id) DO NOTHING`),
      relUpdate: db.prepare(`UPDATE relation SET user_alias = ?, agent_alias = ?, tone = ?, boundaries = ?, shared_terms = ?, last_seen = ?, turns = ?, updated_at = ? WHERE id = 1`),

      judgeInsert: db.prepare(`INSERT INTO judgments (session_id, kind, subject, guess, outcome, note, created_at, updated_at)
        VALUES (?, ?, ?, ?, 'open', '', ?, ?)`),
      judgeById: db.prepare('SELECT * FROM judgments WHERE id = ?'),
      judgeResolve: db.prepare('UPDATE judgments SET outcome = ?, note = ?, updated_at = ? WHERE id = ? RETURNING *'),
      judgeStale: db.prepare(`SELECT * FROM judgments WHERE outcome = 'open' AND updated_at <= ? ORDER BY updated_at ASC LIMIT 1`),
    };
  }

  /** 收尾：确认 FTS 可用、记录 schema 版本、确保关系行存在；可重复执行。 */
  migrate() {
    try {
      this.db.exec(FTS_SCHEMA);
      this.hasFts = true;
    } catch {
      this.hasFts = false;
    }
    this.metaSet('schema.version', String(SCHEMA_VERSION));
    this.ensureRelation(Date.now());
  }

  /** 关闭数据库；可重复调用。 */
  close() {
    try { this.db.close(); } catch { /* 已关闭 */ }
  }

  /** 备份当前数据库（WAL 模式下先 checkpoint 再复制）。 */
  backupFile(targetPath) {
    try { this.db.exec('PRAGMA wal_checkpoint(FULL)'); } catch { /* 忽略 */ }
    copyFileSync(this.path, targetPath);
    return targetPath;
  }

  // ── meta ────────────────────────────────────────────────────────────────
  metaGet(key) {
    const row = this.stmt.metaGet.get(String(key));
    return row ? String(row.v) : '';
  }

  metaSet(key, value) {
    this.stmt.metaSet.run(String(key), String(value));
  }

  // ── 情绪（主动性 v1.3）──────────────────────────────────────────────────
  /**
   * 读当前情绪；没判过返回 null（调用方给默认「轻松」）。
   * @returns {{valence:number, label:string, reason:string, updatedAt:number}|null}
   */
  getEmotion() {
    try {
      const row = this.db.prepare('SELECT valence, label, reason, updated_at FROM emotion WHERE id = 1').get();
      if (!row) return null;
      return {
        valence: Number(row.valence ?? 0),
        label: String(row.label ?? '轻松'),
        reason: String(row.reason ?? ''),
        updatedAt: Number(row.updated_at ?? 0),
      };
    } catch {
      return null;
    }
  }

  setEmotion({ valence = 0, label = '轻松', reason = '', updatedAt = Date.now() } = {}) {
    this.db.prepare(`INSERT INTO emotion (id, valence, label, reason, updated_at) VALUES (1, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET valence = excluded.valence, label = excluded.label,
        reason = excluded.reason, updated_at = excluded.updated_at`)
      .run(Number(valence) || 0, String(label), String(reason), Number(updatedAt));
    return this.getEmotion();
  }

  // ── 向量索引（语义检索）─────────────────────────────────────────────────
  /** 写入一条向量（kind: 'memory' | 'turn'）。 */
  setEmbedding(kind, refId, vector, now = Date.now()) {
    if (!vector || vector.length === 0) return false;
    this.stmt.embeddingSet.run(
      String(kind),
      Number(refId),
      Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength),
      vector.length,
      Number(now),
    );
    return true;
  }

  getEmbedding(kind, refId) {
    try {
      const row = this.stmt.embeddingGet.get(String(kind), Number(refId));
      return row ? Buffer.from(row.vector) : null;
    } catch {
      return null;
    }
  }

  listEmbeddings(kind) {
    return this.stmt.embeddingList.all(String(kind)).map((row) => ({
      kind: String(row.kind),
      refId: Number(row.ref_id),
      vector: Buffer.from(row.vector),
      dim: Number(row.dim ?? 0),
      updatedAt: Number(row.updated_at ?? 0),
    }));
  }

  deleteEmbedding(kind, refId) {
    try {
      return Number(this.stmt.embeddingDelete.run(String(kind), Number(refId)).changes ?? 0) > 0;
    } catch {
      return false;
    }
  }

  embeddingCount(kind) {
    return Number(this.stmt.embeddingCount.get(String(kind))?.n ?? 0);
  }

  // ── 记忆 ────────────────────────────────────────────────────────────────
  /**
   * 写入一条记忆；同 norm 时合并（加权、更新内容与标签），而不是增生。
   * createdAt / updatedAt 仅给迁移脚本保留原始时间用（正常对话不传）。
   * @param {{type?: string, content: string, norm?: string, tags?: string, source?: string,
   *          confidence?: number, projectId?: number|null, sessionId?: string, reason?: string,
   *          createdBy?: 'user'|'assistant'|'system', createdAt?: number, updatedAt?: number}} input
   */
  rememberMemory(input) {
    const now = Date.now();
    const content = String(input.content ?? '').trim();
    const norm = input.norm || normalizeForNorm(content);
    if (content === '' || norm === '') throw new Error('rememberMemory: content 不能为空');
    const type = MEMORY_TYPES.includes(input.type) ? input.type : 'fact';
    const tags = normalizeTags(input.tags);
    const source = String(input.source ?? 'auto');
    const confidence = clamp01(input.confidence ?? 0.6);
    const importance = clamp01(input.importance ?? 0.5);
    const status = input.status === 'candidate' ? 'candidate' : 'active';
    const promoteHits = clampInt(input.promoteHits ?? 2, 1, 10);
    const projectId = Number.isFinite(input.projectId) && Number(input.projectId) > 0 ? Number(input.projectId) : null;
    const sessionId = input.sessionId ? String(input.sessionId) : null;
    const createdBy = ['user', 'assistant', 'system'].includes(input.createdBy) ? input.createdBy : 'system';
    const createdAt = Number.isFinite(input.createdAt) ? Number(input.createdAt) : now;
    const updatedAt = Number.isFinite(input.updatedAt) ? Number(input.updatedAt) : now;

    const existing = this.stmt.memByNorm.get(norm);
    if (existing) {
      const before = rowToMemory(existing);
      // 候选重复出现：累加命中，达到阈值自动转正；用户明确写入的则按正式记忆合并。
      if (existing.status === 'candidate' && status !== 'active') {
        const merged = this.stmt.memCandidateBump.get(
          confidence, importance, content, content,
          mergeTags(existing.tags, tags), promoteHits, updatedAt, now, existing.id,
        );
        this.addHistory(existing.id, 'dedup', before, merged ? rowToMemory(merged) : null, input.reason ?? '');
        try { this.db.prepare('UPDATE memories SET type = ? WHERE id = ?').run(type, existing.id); } catch { /* 忽略 */ }
        if (merged) merged.type = type;
        return merged ? rowToMemory(merged) : rowToMemory(existing);
      }
      const merged = this.stmt.memBump.get(
        confidence,
        importance,
        content, content,
        mergeTags(existing.tags, tags),
        pickSource(existing.source, source),
        updatedAt, now,
        existing.id,
      );
      this.addHistory(existing.id, 'dedup', before, rowToMemory(merged), input.reason ?? '');
      this.db.prepare('UPDATE memories SET type = ? WHERE id = ?').run(type, existing.id);
      merged.type = type;
      return rowToMemory(merged);
    }

    const row = this.stmt.memInsert.get(
      type, content, norm, tags, source, confidence, importance, status, projectId, sessionId, createdBy, createdAt, updatedAt,
    );
    this.addHistory(row.id, 'created', null, rowToMemory(row), input.reason ?? '');
    return rowToMemory(row);
  }

  getMemory(id) {
    const row = this.stmt.memById.get(Number(id));
    return row ? rowToMemory(row) : null;
  }

  /** 标记被新记忆取代：旧版本保留可追溯，但检索只返回新版本。 */
  supersedeMemory(id, { newId = null, reason = '' } = {}) {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return false;
    const before = rowToMemory(row);
    this.stmt.memStatus.run('superseded', newId == null ? null : Number(newId), Date.now(), Number(id));
    this.addHistory(Number(id), 'superseded', before, { status: 'superseded', supersededBy: newId }, reason);
    return true;
  }

  archiveMemory(id, reason = '') {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return false;
    const before = rowToMemory(row);
    this.stmt.memStatus.run('archived', null, Date.now(), Number(id));
    this.addHistory(Number(id), 'archived', before, { status: 'archived' }, reason);
    return true;
  }

  restoreMemory(id) {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return false;
    this.stmt.memStatus.run('active', null, Date.now(), Number(id));
    this.addHistory(Number(id), 'restored', rowToMemory(row), { status: 'active' }, '');
    return true;
  }

  /** 物理删除（用户明确要求删除时用；历史表保留删除记录）。 */
  purgeMemory(id) {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return false;
    this.addHistory(Number(id), 'purged', rowToMemory(row), null, 'user purge');
    this.stmt.memDelete.run(Number(id));
    return true;
  }

  /**
   * 彻底删除（用户明确要求「删掉这条记忆」时用）：连同历史版本一起清掉，
   * 不留内容副本；被这条取代的旧版本解除 superseded_by 引用。
   */
  eraseMemory(id) {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return false;
    try {
      this.db.prepare('UPDATE memories SET superseded_by = NULL WHERE superseded_by = ?').run(Number(id));
    } catch { /* 引用清理失败不阻塞删除 */ }
    try {
      this.db.prepare('DELETE FROM memory_history WHERE memory_id = ?').run(Number(id));
    } catch { /* 历史表清理失败不阻塞删除 */ }
    this.stmt.memDelete.run(Number(id));
    return true;
  }

  // ── 候选记忆（低置信自动抽取，等确认/重复出现再转正） ───────────────────
  /** 列出候选记忆（不进注入、不进 active 检索，单独审核）。 */
  listCandidates(limit = 20) {
    return this.stmt.memCandidateList.all(clampInt(limit, 1, 200)).map(rowToMemory);
  }

  /** 候选转正（用户确认或重复出现达到阈值）。 */
  promoteCandidate(id, reason = '') {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return null;
    const before = rowToMemory(row);
    const updated = this.stmt.memPromote.get(Date.now(), Date.now(), Number(id));
    this.addHistory(Number(id), 'promoted', before, updated ? rowToMemory(updated) : { status: 'active' }, reason);
    return updated ? rowToMemory(updated) : null;
  }

  /** 拒绝候选：归档（保留可追溯，但不再参与检索/注入）。 */
  rejectCandidate(id, reason = '') {
    return this.archiveMemory(id, reason || '候选记忆被拒绝');
  }

  /**
   * 强化一条已存在的记忆（近似重复表述、重复确认时用）：只加命中与置信度，不新增条目。
   */
  reinforceMemory(id, { confidence = null, importance = null, content = '', tags = '' } = {}) {
    const row = this.stmt.memById.get(Number(id));
    if (!row) return null;
    const before = rowToMemory(row);
    const now = Date.now();
    const nextConf = confidence == null ? Number(row.confidence) : Math.max(Number(row.confidence), clamp01(confidence));
    const nextImp = importance == null ? Number(row.importance ?? 0.5) : Math.max(Number(row.importance ?? 0.5), clamp01(importance));
    const text = String(content ?? '').trim();
    const merged = this.stmt.memReinforce.get(
      nextConf, nextImp, text, text, mergeTags(row.tags, normalizeTags(tags)), now, now, Number(id),
    );
    this.addHistory(Number(id), 'reinforced', before, merged ? rowToMemory(merged) : null, '');
    return merged ? rowToMemory(merged) : null;
  }

  /**
   * 用户明确确认后，把本会话最近的一批候选记忆转正（最多 limit 条，
   * 只挑置信度较高的，避免一句「就这样」把所有候选都放出来）。
   */
  promoteSessionCandidates({ sessionId = '', since = 0, limit = 3 } = {}) {
    const rows = this.db.prepare(`SELECT id FROM memories
      WHERE status = 'candidate' AND (? = '' OR session_id = ?) AND updated_at >= ?
      ORDER BY confidence DESC, updated_at DESC LIMIT ?`)
      .all(String(sessionId ?? ''), String(sessionId ?? ''), Number(since) || 0, clampInt(limit, 1, 20));
    const promoted = [];
    for (const row of rows) {
      const memory = this.promoteCandidate(row.id, '用户确认');
      if (memory) promoted.push(memory);
    }
    return promoted;
  }

  /** 候选数量（状态展示用）。 */
  candidateCount() {
    try {
      return Number(this.db.prepare("SELECT count(*) AS n FROM memories WHERE status = 'candidate'").get()?.n ?? 0);
    } catch {
      return 0;
    }
  }

  listMemories({ type = '', status = 'active', projectId = 0, limit = 50, offset = 0 } = {}) {
    const n = clampInt(limit, 1, 500);
    const off = Math.max(0, Number(offset) || 0);
    const rows = type
      ? this.stmt.memListType.all(status, type, n, off)
      : this.stmt.memList.all(status, n, off);
    let list = rows.map(rowToMemory);
    if (projectId) list = list.filter((m) => m.projectId === Number(projectId));
    return list;
  }

  /** 关键词检索：LIKE 召回 + FTS5（可用时）补召回；结果统一打分排序。 */
  searchMemories(query, limit = 8) {
    const q = String(query ?? '').trim();
    const n = clampInt(limit, 1, 100);
    if (q === '') return this.topMemories(n);

    const seen = new Map();
    for (const variant of queryVariants(q)) {
      const like = `%${escapeLike(variant)}%`;
      for (const row of this.stmt.memLike.all(like, like, n)) seen.set(row.id, row);
    }

    let usedFts = false;
    if (this.hasFts && [...q].length >= 3) {
      try {
        const ftsQuery = `"${q.replace(/"/g, '""')}"`;
        for (const row of this.stmt.memFts.all(ftsQuery, n)) seen.set(row.id, row);
        usedFts = true;
      } catch { /* FTS 查询失败退化为 LIKE */ }
    }

    // 整句没命中时按词进一步召回（中文短词/英文单词）
    if (seen.size === 0) {
      for (const token of tokenizeQuery(q)) {
        const pattern = `%${escapeLike(token)}%`;
        for (const row of this.stmt.memLike.all(pattern, pattern, n)) seen.set(row.id, row);
      }
    }

    const now = Date.now();
    const scored = [...seen.values()].map((row) => ({
      row: rowToMemory(row),
      score: scoreRow(row, q, now, usedFts),
    }));
    scored.sort((a, b) => b.score - a.score);
    const picked = scored.slice(0, n).map((item) => item.row);
    this.touchMemories(picked.map((m) => m.id));
    return picked;
  }

  touchMemories(ids) {
    const now = Date.now();
    for (const id of ids) {
      try { this.stmt.memTouch.run(now, Number(id)); } catch { /* 单行失败不影响整体 */ }
    }
  }

  topMemories(limit = 8, types = null) {
    const rows = this.stmt.memTop.all(clampInt(limit, 1, 100));
    const filtered = types && types.length > 0 ? rows.filter((r) => types.includes(r.type)) : rows;
    return filtered.map(rowToMemory);
  }

  memoryCounts() {
    const out = { total: 0, active: 0, superseded: 0, archived: 0, byType: {}, byStatus: {} };
    for (const row of this.stmt.memCounts.all()) {
      const n = Number(row.n);
      out.byStatus[row.status] = (out.byStatus[row.status] ?? 0) + n;
      if (row.status === 'active') {
        out.byType[row.type] = (out.byType[row.type] ?? 0) + n;
        out.total += n;
      }
    }
    out.active = out.total;
    out.superseded = out.byStatus.superseded ?? 0;
    out.archived = out.byStatus.archived ?? 0;
    out.candidates = out.byStatus.candidate ?? 0;
    return out;
  }

  memoryHistory(memoryId, limit = 10) {
    return this.stmt.histList.all(Number(memoryId), clampInt(limit, 1, 100)).map((row) => ({
      id: Number(row.id),
      action: String(row.action),
      before: row.before_json ? safeJson(row.before_json) : null,
      after: row.after_json ? safeJson(row.after_json) : null,
      reason: String(row.reason ?? ''),
      createdAt: Number(row.created_at),
    }));
  }

  addHistory(memoryId, action, before, after, reason) {
    try {
      this.stmt.histIns.run(
        Number(memoryId), String(action),
        before ? JSON.stringify(before) : null,
        after ? JSON.stringify(after) : null,
        String(reason ?? ''), Date.now(),
      );
    } catch { /* 历史写失败不影响主记录 */ }
  }

  // ── 项目 ────────────────────────────────────────────────────────────────
  upsertProject({ name, goal = '', stage = '', status = 'active', source = 'auto' }) {
    const now = Date.now();
    const cleanName = String(name ?? '').trim();
    if (cleanName === '') throw new Error('upsertProject: name 不能为空');
    const slug = slugify(cleanName);
    const existing = this.stmt.projectBySlug.get(slug);
    if (existing) {
      const nextGoal = String(goal ?? '').trim() !== '' ? String(goal).trim() : existing.goal;
      const nextStage = String(stage ?? '').trim() !== '' ? String(stage).trim() : existing.stage;
      const nextStatus = ['active', 'paused', 'done', 'archived'].includes(status) ? status : existing.status;
      const row = this.stmt.projectUpdate.get(
        cleanName, nextGoal, nextStage, nextStatus,
        pickSource(existing.source, source), now, now, existing.id,
      );
      return rowToProject(row);
    }
    const row = this.stmt.projectInsert.get(
      cleanName, slug, String(goal ?? '').trim(), String(stage ?? '').trim(),
      ['active', 'paused', 'done', 'archived'].includes(status) ? status : 'active',
      String(source ?? 'auto'), now, now, now,
    );
    return rowToProject(row);
  }

  getProject(id) {
    const row = this.stmt.projectById.get(Number(id));
    return row ? rowToProject(row) : null;
  }

  listProjects({ status = 'active', limit = 10 } = {}) {
    const rows = status === 'any'
      ? this.stmt.projectAll.all(clampInt(limit, 1, 100))
      : this.stmt.projectList.all(status, clampInt(limit, 1, 100));
    return rows.map(rowToProject);
  }

  /** 从一段话里认出项目名（最长匹配优先；不做模糊联想，避免记忆污染）。 */
  matchProject(text) {
    const haystack = String(text ?? '').toLowerCase();
    if (haystack === '') return null;
    const projects = this.stmt.projectAll.all(100).map(rowToProject);
    let best = null;
    for (const project of projects) {
      const name = project.name.toLowerCase();
      if (name.length < 2) continue;
      let hit = haystack.includes(name);
      if (!hit) {
        // 「项目名」去掉空格/标点后再匹配一次
        hit = normText(haystack).includes(normText(name));
      }
      if (hit && (best === null || name.length > best.name.length)) best = project;
    }
    return best;
  }

  touchProject(id) {
    const now = Date.now();
    this.stmt.projectTouch.run(now, now, Number(id));
  }

  setProjectStatus(id, status) {
    const project = this.getProject(id);
    if (!project) return null;
    return this.upsertProject({ name: project.name, goal: project.goal, stage: project.stage, status, source: project.source });
  }

  addProjectItem(projectId, kind, content, { state = '', priority = 0, dependsOn = '', acceptance = '', source = 'auto' } = {}) {
    const pid = Number(projectId);
    if (!Number.isFinite(pid) || pid <= 0) throw new Error('addProjectItem: projectId 无效');
    if (!PROJECT_ITEM_KINDS.includes(kind)) throw new Error(`addProjectItem: 未知 kind ${kind}`);
    const text = String(content ?? '').trim();
    if (text === '') throw new Error('addProjectItem: content 不能为空');
    const now = Date.now();
    const norm = normalizeForNorm(text);
    const existing = this.stmt.itemByKey.get(pid, kind, norm);
    this.touchProject(pid);
    if (existing) {
      const nextState = state !== '' ? String(state) : existing.state;
      const row = this.stmt.itemUpdate.get(
        text, nextState,
        Math.max(Number(priority) || 0, Number(existing.priority) || 0),
        String(dependsOn || existing.depends_on),
        String(acceptance || existing.acceptance),
        now, existing.id,
      );
      return rowToItem(row);
    }
    const row = this.stmt.itemInsert.get(
      pid, kind, text, norm,
      state !== '' ? String(state) : 'open',
      Number(priority) || 0, String(dependsOn ?? ''), String(acceptance ?? ''),
      String(source ?? 'auto'), now, now,
    );
    return rowToItem(row);
  }

  getProjectItem(id) {
    const row = this.stmt.itemById.get(Number(id));
    return row ? rowToItem(row) : null;
  }

  setProjectItemState(id, state) {
    const now = Date.now();
    this.stmt.itemSetState.run(String(state), now, Number(id));
    return this.getProjectItem(id);
  }

  deleteProjectItem(id) {
    this.stmt.itemDelete.run(Number(id));
    return true;
  }

  listProjectItems(projectId, { kind = '', limit = 200 } = {}) {
    const pid = Number(projectId);
    const rows = kind
      ? this.stmt.itemListKind.all(pid, kind, clampInt(limit, 1, 500))
      : this.stmt.itemList.all(pid, clampInt(limit, 1, 500));
    return rows.map(rowToItem);
  }

  /** 一个项目的完整快照（渲染/审阅用）。 */
  projectSnapshot(projectId) {
    const project = this.getProject(projectId);
    if (!project) return null;
    const items = this.listProjectItems(project.id);
    const byKind = {};
    for (const kind of PROJECT_ITEM_KINDS) byKind[kind] = [];
    for (const item of items) (byKind[item.kind] ??= []).push(item);
    return { project, items, byKind };
  }

  // ── 任务（最小状态机 pending → in_progress → blocked/completed） ─────────
  addTask({ projectId = 0, title, state = 'pending', priority = 0, dependsOn = '', acceptance = '', source = 'auto' } = {}) {
    const text = String(title ?? '').trim();
    if (text === '') throw new Error('addTask: title 不能为空');
    const pid = Math.max(0, Number(projectId) || 0);
    const norm = normalizeForNorm(text);
    const now = Date.now();
    const existing = this.stmt.taskByKey.get(pid, norm);
    if (existing) {
      const row = this.stmt.taskUpdate.get(
        text, TASK_STATES.includes(state) ? state : existing.state,
        Math.max(Number(priority) || 0, Number(existing.priority) || 0),
        String(dependsOn || existing.depends_on),
        String(acceptance || existing.acceptance),
        now, existing.id,
      );
      return rowToTask(row);
    }
    const row = this.stmt.taskInsert.get(
      pid, text, norm, TASK_STATES.includes(state) ? state : 'pending',
      Number(priority) || 0, String(dependsOn ?? ''), String(acceptance ?? ''),
      String(source ?? 'auto'), now, now,
    );
    return rowToTask(row);
  }

  setTaskState(id, state) {
    const now = Date.now();
    this.stmt.taskSetState.run(TASK_STATES.includes(state) ? state : 'pending', now, Number(id));
    const row = this.stmt.taskById.get(Number(id));
    return row ? rowToTask(row) : null;
  }

  getTask(id) {
    const row = this.stmt.taskById.get(Number(id));
    return row ? rowToTask(row) : null;
  }

  listTasks({ projectId = 0, state = '', limit = 100 } = {}) {
    const pid = Math.max(0, Number(projectId) || 0);
    const st = String(state ?? '');
    const rows = this.stmt.taskList.all(pid, pid, st, st, clampInt(limit, 1, 500));
    return rows.map(rowToTask);
  }

  openTasks(limit = 20) {
    return this.stmt.taskOpen.all(clampInt(limit, 1, 200)).map(rowToTask);
  }

  // ── 会话 / 回合 / 会话状态 ───────────────────────────────────────────────
  markSession(sessionId, { origin = '', cwd = '' } = {}, now = Date.now()) {
    this.stmt.sessionUpsert.run(String(sessionId), String(origin ?? ''), String(cwd ?? ''), now, now);
  }

  getSession(sessionId) {
    const row = this.stmt.sessionGet.get(String(sessionId));
    return row ? rowToSession(row) : null;
  }

  sessionCount() {
    return Number(this.stmt.sessionCount.get()?.n ?? 0);
  }

  /**
   * 记录一个完整回合（user → assistant），按 (session_id, turn) 幂等。
   * @returns {{inserted: boolean, id: number|null}}
   */
  recordTurn(input) {
    const sid = String(input.sessionId);
    const turn = Number.isFinite(input.turn) ? Number(input.turn) : -1;
    const now = Number(input.endedAt ?? Date.now());
    const existing = this.stmt.turnExists.get(sid, turn);
    if (existing) {
      this.stmt.turnUpdate.run(
        String(input.userText ?? ''), String(input.userText ?? ''),
        String(input.assistantText ?? ''), String(input.assistantText ?? ''),
        Number(input.toolCalls ?? 0),
        String(input.reason ?? ''), String(input.reason ?? ''),
        now, existing.id,
      );
      return { inserted: false, id: Number(existing.id) };
    }
    this.stmt.turnInsert.run(
      sid, turn,
      String(input.userText ?? ''), String(input.assistantText ?? ''),
      Number(input.toolCalls ?? 0), String(input.reason ?? ''),
      Number(input.startedAt ?? now), now,
    );
    const id = Number(this.db.prepare('SELECT last_insert_rowid() AS id').get()?.id ?? 0);
    this.markSession(sid, { origin: input.origin ?? '', cwd: input.cwd ?? '' }, now);
    this.stmt.sessionBumpTurn.run(now, sid);
    this.bumpRelationTurn(now);
    return { inserted: true, id };
  }

  /** 标记某回合已做过语义抽取（幂等：同一回合不重复调用模型）。 */
  markTurnExtracted(sessionId, turn, stamp = Date.now()) {
    try {
      this.db.prepare('UPDATE turns SET extracted_at = ? WHERE session_id = ? AND turn = ?')
        .run(Number(stamp), String(sessionId), Number(turn));
      return true;
    } catch {
      return false;
    }
  }

  /** 还没做过语义抽取的已结束回合（按时间倒序）；进程重启后据此后补做。 */
  unextractedTurns({ limit = 20, since = 0 } = {}) {
    const rows = this.db.prepare(`SELECT * FROM turns
      WHERE extracted_at IS NULL AND ended_at >= ? ORDER BY id DESC LIMIT ?`)
      .all(Number(since) || 0, clampInt(limit, 1, 100));
    return rows.map(rowToTurn);
  }

  /** 某回合是否已抽取过。 */
  isTurnExtracted(sessionId, turn) {
    try {
      const row = this.db.prepare('SELECT extracted_at FROM turns WHERE session_id = ? AND turn = ?')
        .get(String(sessionId), Number(turn));
      return Boolean(row && row.extracted_at);
    } catch {
      return false;
    }
  }

  recentTurns(limit = 10, sessionId = '') {
    const n = clampInt(limit, 1, 200);
    const rows = sessionId
      ? this.stmt.turnRecentSession.all(String(sessionId), n)
      : this.stmt.turnRecent.all(n);
    return rows.map(rowToTurn);
  }

  /** 用于建向量索引的回合（只取用户原话非空的，近 since 起）。 */
  turnsForIndexing({ since = 0, limit = 400 } = {}) {
    const rows = this.db.prepare(`SELECT id, user_text, ended_at FROM turns
      WHERE user_text != '' AND ended_at >= ? ORDER BY id DESC LIMIT ?`)
      .all(Number(since) || 0, clampInt(limit, 1, 2000));
    return rows.map((row) => ({
      id: Number(row.id),
      text: String(row.user_text ?? ''),
      endedAt: Number(row.ended_at ?? 0),
    }));
  }

  /**
   * 「上次聊天」素材：最近 N 回合（按时间正序返回，方便读）+ 距现在多久。
   * 只返回数据；「多久算久别」由 render/config 判断。
   * @returns {{turns: Array<{userText: string, assistantText: string, endedAt: number}>, gapMs: number}|null}
   */
  recapMaterial({ turns = 3, now = Date.now() } = {}) {
    const latest = this.recentTurns(1);
    if (latest.length === 0) return null;
    const gapMs = Math.max(0, Number(now) - Number(latest[0].endedAt ?? 0));
    const rows = this.recentTurns(clampInt(turns, 1, 6)).reverse();
    return {
      turns: rows.map((row) => ({
        userText: String(row.userText ?? ''),
        assistantText: String(row.assistantText ?? ''),
        endedAt: Number(row.endedAt ?? 0),
      })),
      gapMs,
    };
  }

  recentUserLines(limit = 3) {
    return this.stmt.turnUserRecent.all(clampInt(limit, 1, 20)).map((row) => ({
      text: String(row.user_text ?? ''),
      endedAt: Number(row.ended_at ?? 0),
    }));
  }

  turnCount() {
    return Number(this.stmt.turnCount.get()?.n ?? 0);
  }

  getSessionState(sessionId) {
    const row = this.stmt.stateGet.get(String(sessionId));
    return row ? rowToSessionState(row) : null;
  }

  getOrCreateSessionState(sessionId) {
    const existing = this.getSessionState(sessionId);
    if (existing) return existing;
    const now = Date.now();
    this.stmt.stateInsert.run(String(sessionId), '', 0, '', '', now);
    return this.getSessionState(sessionId);
  }

  setSessionState(sessionId, patch = {}) {
    const state = this.getOrCreateSessionState(sessionId);
    const now = Date.now();
    const sid = String(sessionId);
    if (typeof patch.mode === 'string') this.stmt.stateSetMode.run(patch.mode, now, sid);
    if (patch.activeProjectId !== undefined) this.stmt.stateSetProject.run(Number(patch.activeProjectId) || 0, now, sid);
    if (typeof patch.lastUserText === 'string') this.stmt.stateSetLastUser.run(patch.lastUserText, now, sid);
    if (typeof patch.openQuestion === 'string') this.stmt.stateSetQuestion.run(patch.openQuestion, now, sid);
    return { ...state, ...patch, updatedAt: now };
  }

  // ── 判断日志（主动性：每轮有自己的假设，事后能验证/推翻） ──────────────
  /**
   * 记一条判断：我当时认为这句话想要什么 / 该不该主动关心 / 这条记忆该不该留。
   * 返回自增 id；空 guess 不记。判断不是记忆，不参与检索与事实注入。
   */
  recordJudgment({ sessionId = '', kind = 'read', subject = '', guess = '', now = Date.now() } = {}) {
    const text = String(guess ?? '').trim();
    if (text === '') throw new Error('recordJudgment: guess 不能为空');
    const info = this.stmt.judgeInsert.run(
      String(sessionId),
      JUDGMENT_KINDS.includes(kind) ? kind : 'read',
      String(subject ?? '').trim().slice(0, 200),
      text.slice(0, 500),
      Number(now),
      Number(now),
    );
    return Number(info.lastInsertRowid);
  }

  getJudgment(id) {
    const row = this.stmt.judgeById.get(Number(id));
    return row ? rowToJudgment(row) : null;
  }

  /** 给判断标结果：right（猜对了）/ wrong（猜错了）/ dropped（不再需要验证）。 */
  resolveJudgment(id, { outcome = 'right', note = '', now = Date.now() } = {}) {
    const next = ['right', 'wrong', 'dropped'].includes(outcome) ? outcome : 'right';
    const row = this.stmt.judgeResolve.get(next, String(note ?? '').trim().slice(0, 300), Number(now), Number(id));
    if (!row) throw new Error(`resolveJudgment: 判断 #${id} 不存在`);
    return rowToJudgment(row);
  }

  listJudgments({ outcome = '', limit = 10, sinceDays = 0, sessionId = '' } = {}) {
    const where = [];
    const args = [];
    if (outcome !== '') { where.push('outcome = ?'); args.push(String(outcome)); }
    if (sessionId !== '') { where.push('session_id = ?'); args.push(String(sessionId)); }
    if (Number(sinceDays) > 0) { where.push('updated_at >= ?'); args.push(Date.now() - Number(sinceDays) * 86_400_000); }
    const sql = `SELECT * FROM judgments${where.length > 0 ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY updated_at DESC LIMIT ?`;
    args.push(clampInt(limit, 1, 100));
    return this.db.prepare(sql).all(...args).map(rowToJudgment);
  }

  /**
   * 下一轮注入用的判断素材：最近猜错的（提醒别再犯）+ 悬太久没验证的（该回头看一眼）。
   * 数量严格控制——这是判断的原料，不是结论。
   */
  judgmentMaterial({ wrongDays = 7, staleDays = 2, now = Date.now() } = {}) {
    const wrong = this.listJudgments({ outcome: 'wrong', sinceDays: wrongDays, limit: 2 });
    const stale = this.stmt.judgeStale.all(Number(now) - Number(staleDays) * 86_400_000).map(rowToJudgment);
    return { wrong, stale };
  }

  // ── 关系 ────────────────────────────────────────────────────────────────
  ensureRelation(now = Date.now()) {
    this.stmt.relInsert.run(now, now, now);
    return this.getRelation();
  }

  getRelation() {
    const row = this.stmt.relGet.get();
    return row ? rowToRelation(row) : null;
  }

  setRelation(patch = {}) {
    const rel = this.getRelation() ?? this.ensureRelation();
    // 兼容两种键名：内部/原有代码用 snake_case，外部调用与测试更习惯 camelCase。
    const pairs = [
      ['user_alias', 'userAlias', rel.userAlias],
      ['agent_alias', 'agentAlias', rel.agentAlias],
      ['tone', 'tone', rel.tone],
      ['boundaries', 'boundaries', rel.boundaries],
      ['shared_terms', 'sharedTerms', rel.sharedTerms],
    ];
    const next = {};
    for (const [snake, camel, current] of pairs) {
      const value = typeof patch[snake] === 'string' ? patch[snake] : patch[camel];
      next[snake] = typeof value === 'string' && value.trim() !== '' ? value.trim() : current;
    }
    this.stmt.relUpdate.run(
      next.user_alias, next.agent_alias, next.tone,
      next.boundaries, next.shared_terms,
      Date.now(), rel.turns, Date.now(),
    );
    return this.getRelation();
  }

  bumpRelationTurn(now = Date.now()) {
    const rel = this.getRelation() ?? this.ensureRelation(now);
    this.stmt.relUpdate.run(
      rel.userAlias, rel.agentAlias, rel.tone,
      rel.boundaries, rel.sharedTerms,
      now, rel.turns + 1, now,
    );
  }

  /**
   * 迁移历史关系数据用：把 first_seen/last_seen 往前推、turn 数取「已记录的最大值」，
   * 不覆盖比历史更早/更多的现有值（可重复执行）。
   */
  setRelationHistory({ firstSeen = null, lastSeen = null, turns = null } = {}) {
    const rel = this.getRelation() ?? this.ensureRelation();
    const now = Date.now();
    const fs = Number.isFinite(firstSeen) ? Math.min(rel.firstSeen || now, Number(firstSeen)) : rel.firstSeen;
    const ls = Number.isFinite(lastSeen) ? Math.max(rel.lastSeen || 0, Number(lastSeen)) : rel.lastSeen;
    const t = Number.isFinite(turns) ? Math.max(rel.turns, Number(turns)) : rel.turns;
    this.db.prepare('UPDATE relation SET first_seen = ?, last_seen = ?, turns = ?, updated_at = ? WHERE id = (SELECT id FROM relation ORDER BY id LIMIT 1)')
      .run(fs, ls, t, now);
    return this.getRelation();
  }

  // ── 整理 / 维护 ─────────────────────────────────────────────────────────
  /**
   * 本地整理：裁剪旧回合、衰减久未访问记忆的置信度、归档低置信自动记忆。
   * 不做 LLM 调用，不清除用户明确要求记住的内容。
   */
  curate({ retentionDays = 30, maxTurns = 200 } = {}) {
    const now = Date.now();
    const days = Math.max(1, Number(retentionDays) || 30);
    const cutoff = now - days * 86_400_000;
    let pruned = 0;
    try {
      const info = this.db.prepare('DELETE FROM turns WHERE ended_at < ?').run(cutoff);
      pruned = Number(info.changes ?? 0);
    } catch { /* 忽略 */ }
    try {
      this.db.prepare('DELETE FROM turns WHERE id NOT IN (SELECT id FROM turns ORDER BY id DESC LIMIT ?)').run(Math.max(50, Number(maxTurns) || 200));
    } catch { /* 忽略 */ }
    // 置信度随时间缓慢衰减：0.98/天，下限 0.2
    try {
      this.db.prepare(`UPDATE memories SET confidence = max(0.2, confidence * 0.98)
        WHERE status = 'active' AND COALESCE(last_accessed_at, updated_at) < ?`).run(now - 7 * 86_400_000);
    } catch { /* 忽略 */ }
    // 只归档「自动抽取 + 长期没被用 + 低置信」的记忆；用户明确要求记住的不动
    let archived = 0;
    try {
      const rows = this.db.prepare(`SELECT id FROM memories
        WHERE status = 'active' AND source = 'auto' AND confidence < 0.3 AND hits < 2
          AND COALESCE(last_accessed_at, updated_at) < ?`).all(now - days * 2 * 86_400_000);
      for (const row of rows) {
        this.archiveMemory(row.id, 'curation: 低置信且长期未使用');
        archived += 1;
      }
    } catch { /* 忽略 */ }
    // 候选记忆长期不确认就过期：既不进注入，也不该无限堆积。
    try {
      const stale = this.db.prepare(`SELECT id FROM memories
        WHERE status = 'candidate' AND hits < 2 AND updated_at < ?`).all(now - Math.max(7, days) * 86_400_000);
      for (const row of stale) {
        this.archiveMemory(row.id, 'curation: 候选记忆长期未确认');
        archived += 1;
      }
    } catch { /* 忽略 */ }
    // 工作日志/证据保留更久（默认 180 天），但也不能无限涨。
    let prunedJournal = 0;
    let prunedEvidence = 0;
    try {
      const journalCutoff = now - Math.max(7, days) * 6 * 86_400_000;
      prunedJournal = Number(this.db.prepare('DELETE FROM project_journal WHERE created_at < ?').run(journalCutoff).changes ?? 0);
      const evidenceCutoff = now - Math.max(30, days) * 6 * 86_400_000;
      prunedEvidence = Number(this.db.prepare('DELETE FROM memory_evidence WHERE created_at < ?').run(evidenceCutoff).changes ?? 0);
    } catch { /* 忽略 */ }
    this.metaSet('curation.last', String(now));
    return { prunedTurns: pruned, archivedMemories: archived, prunedJournal, prunedEvidence };
  }

  stats() {
    const mem = this.memoryCounts();
    const rel = this.getRelation();
    return {
      dbPath: this.path,
      schemaVersion: this.metaGet('schema.version'),
      fts: this.hasFts,
      memories: mem,
      projects: {
        active: this.listProjects({ status: 'active', limit: 100 }).length,
        paused: this.listProjects({ status: 'paused', limit: 100 }).length,
      },
      tasks: {
        open: this.listTasks({ state: '' }).filter((t) => t.state !== 'completed').length,
        blocked: this.listTasks({ state: 'blocked' }).length,
        completed: this.listTasks({ state: 'completed' }).length,
      },
      sessions: this.sessionCount(),
      turns: this.turnCount(),
      relation: rel,
      lastCurationAt: Number(this.metaGet('curation.last') ?? 0),
    };
  }
}

// ── 行 → 对象 ─────────────────────────────────────────────────────────────

function rowToMemory(row) {
  return {
    id: Number(row.id),
    type: String(row.type),
    content: String(row.content),
    norm: String(row.norm),
    tags: String(row.tags ?? ''),
    source: String(row.source ?? 'auto'),
    confidence: Number(row.confidence ?? 0.6),
    importance: Number(row.importance ?? 0.5),
    status: String(row.status ?? 'active'),
    projectId: row.project_id == null ? null : Number(row.project_id),
    sessionId: row.session_id == null ? null : String(row.session_id),
    createdBy: String(row.created_by ?? 'system'),
    hits: Number(row.hits ?? 1),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastAccessedAt: row.last_accessed_at == null ? null : Number(row.last_accessed_at),
    supersededBy: row.superseded_by == null ? null : Number(row.superseded_by),
  };
}

function rowToProject(row) {
  return {
    id: Number(row.id),
    name: String(row.name),
    slug: String(row.slug),
    goal: String(row.goal ?? ''),
    stage: String(row.stage ?? ''),
    status: String(row.status ?? 'active'),
    source: String(row.source ?? 'auto'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
    lastTouchedAt: row.last_touched_at == null ? null : Number(row.last_touched_at),
  };
}

function rowToItem(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id),
    kind: String(row.kind),
    content: String(row.content),
    state: String(row.state ?? 'open'),
    priority: Number(row.priority ?? 0),
    dependsOn: String(row.depends_on ?? ''),
    acceptance: String(row.acceptance ?? ''),
    source: String(row.source ?? 'auto'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToTask(row) {
  return {
    id: Number(row.id),
    projectId: Number(row.project_id ?? 0),
    title: String(row.title),
    state: String(row.state ?? 'pending'),
    priority: Number(row.priority ?? 0),
    dependsOn: String(row.depends_on ?? ''),
    acceptance: String(row.acceptance ?? ''),
    source: String(row.source ?? 'auto'),
    createdAt: Number(row.created_at),
    updatedAt: Number(row.updated_at),
  };
}

function rowToSession(row) {
  return {
    sessionId: String(row.session_id),
    origin: String(row.origin ?? ''),
    cwd: String(row.cwd ?? ''),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    lastSeenAt: Number(row.last_seen_at ?? 0),
    turns: Number(row.turns ?? 0),
  };
}

function rowToTurn(row) {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id),
    turn: Number(row.turn),
    userText: String(row.user_text ?? ''),
    assistantText: String(row.assistant_text ?? ''),
    toolCalls: Number(row.tool_calls ?? 0),
    reason: String(row.reason ?? ''),
    startedAt: row.started_at == null ? null : Number(row.started_at),
    endedAt: Number(row.ended_at ?? 0),
  };
}

function rowToSessionState(row) {
  return {
    sessionId: String(row.session_id),
    mode: String(row.mode ?? ''),
    activeProjectId: Number(row.active_project_id ?? 0),
    lastUserText: String(row.last_user_text ?? ''),
    openQuestion: String(row.open_question ?? ''),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function rowToJudgment(row) {
  return {
    id: Number(row.id),
    sessionId: String(row.session_id ?? ''),
    kind: String(row.kind ?? 'read'),
    subject: String(row.subject ?? ''),
    guess: String(row.guess ?? ''),
    outcome: String(row.outcome ?? 'open'),
    note: String(row.note ?? ''),
    createdAt: Number(row.created_at ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

function rowToRelation(row) {
  return {
    userAlias: String(row.user_alias ?? ''),
    agentAlias: String(row.agent_alias ?? ''),
    tone: String(row.tone ?? ''),
    boundaries: String(row.boundaries ?? ''),
    sharedTerms: String(row.shared_terms ?? ''),
    firstSeen: row.first_seen == null ? null : Number(row.first_seen),
    lastSeen: row.last_seen == null ? null : Number(row.last_seen),
    turns: Number(row.turns ?? 0),
    updatedAt: Number(row.updated_at ?? 0),
  };
}

// ── 小工具（store 内部用，同时导出给测试） ─────────────────────────────────

export function normalizeForNorm(text) {
  return String(text ?? '')
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]+/gu, '')
    .slice(0, 160);
}

export function normalizeTags(tags) {
  const list = Array.isArray(tags) ? tags : String(tags ?? '').split(/[\s,，、]+/);
  return [...new Set(list.map((t) => String(t).trim()).filter((t) => t !== ''))].join(' ');
}

export function slugify(name) {
  const slug = String(name ?? '')
    .trim()
    .toLowerCase()
    .replace(/[\s/\\]+/g, '-')
    .replace(/[^\p{L}\p{N}_-]+/gu, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 80);
  return slug !== '' ? slug : `project-${Date.now()}`;
}

function pickSource(oldSource, newSource) {
  const priority = { 'user-explicit': 3, 'user-correction': 3, 'user': 2, 'tool': 2, 'auto': 1, 'system': 1 };
  const a = priority[oldSource] ?? 0;
  const b = priority[newSource] ?? 0;
  return b > a ? String(newSource) : String(oldSource);
}

function clamp01(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return 0.6;
  return Math.min(1, Math.max(0.1, n));
}

function clampInt(value, min, max) {
  const n = Math.floor(Number(value));
  if (!Number.isFinite(n)) return min;
  return Math.min(max, Math.max(min, n));
}

function scoreRow(row, query, now, usedFts) {
  let score = Number(row.confidence ?? 0.6) * 2
    + Number(row.importance ?? 0.5) * 1.5
    + Math.min(Number(row.hits ?? 1), 10) * 0.1;
  const content = String(row.content ?? '');
  const tags = String(row.tags ?? '');
  const q = String(query ?? '').toLowerCase();
  if (q !== '' && content.toLowerCase().includes(q)) score += 3;
  if (q !== '' && tags.toLowerCase().includes(q)) score += 1.5;
  if (usedFts) score += 1;
  const ageDays = Math.max(0, (now - Number(row.updated_at ?? now)) / 86_400_000);
  score += Math.max(0, 1.2 - ageDays * 0.02); // 近两周更新的更靠前
  return score;
}

/**
 * 检索词变体：拆字写法（口也/口牙/口圭…）是同一个语体下的不同写法，
 * 用户打「口牙」时也要能召回存成「口也」的条目，反过来也一样。
 * 只对短词展开，避免长句把一次检索放大成一堆噪音。
 */
function queryVariants(query) {
  const raw = String(query ?? '').trim();
  if (raw === '') return [raw];
  const out = [raw];
  if ([...raw].length > 8) return out;
  for (const match of raw.matchAll(/口([\p{Script=Han}])/gu)) {
    const bare = match[1];
    if (!out.includes(bare)) out.push(bare);
  }
  if ([...raw].length <= 2) {
    for (const ch of raw) {
      if (/[\p{Script=Han}]/u.test(ch)) out.push(`口${ch}`);
    }
  }
  return out;
}

function tokenizeQuery(query) {
  const parts = String(query ?? '').split(/[\s,，。、；;：:!！?？/\\|()（）【】\[\]{}"'“”‘’]+/u);
  const tokens = [];
  for (const part of parts) {
    const t = part.trim();
    if (t.length < 2) continue;
    if (t.length > 16) {
      tokens.push(t.slice(0, 16));
      continue;
    }
    tokens.push(t);
  }
  return tokens.slice(0, 4);
}

function safeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}
