/**
 * memory-quality 层：重要性排序、候选记忆、去重/强化、冲突取代、确认转正、
 * schema v1→v2 迁移与自动备份、/soul candidates|approve|reject|backup。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { existsSync, mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, SCHEMA_VERSION } from '../lib/memory/store.js';
import { selectMemories } from '../lib/memory/retrieval.js';
import { renderMemoryList, renderStatus } from '../lib/memory/render.js';
import { installHooks } from '../lib/hooks.js';
import { registerCommand } from '../lib/commands/soul.js';
import {
  fakeCommands, makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent,
} from './helpers.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function setupCommands(t) {
  const { store, dir } = makeTempStore(t);
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  const paths = { dbPath: 'C:/tmp/soul.db', dataDir: dir, logFile: '', skill: join(dir, 'SKILL.md') };
  const dispose = registerCommand(ctx, {
    store, config: testConfig(), paths, personaInfo: { sources: [], missing: [] }, version: '0.1.0', logger,
  });
  const command = commands.definitions[0];
  const run = (rawInput) => command.handler({ agent: { session: { id: 's-1' } }, rawInput });
  return { store, run, dispose };
}

test('重要性参与检索排序：明确要求记住的排在随口偏好前面', (t) => {
  const { store } = makeTempStore(t);
  store.rememberMemory({ type: 'preference', content: '用户好像喜欢喝咖啡', confidence: 0.55, importance: 0.3 });
  const important = store.rememberMemory({
    type: 'preference', content: '用户喜欢喝美式咖啡，不加糖', confidence: 0.6, importance: 0.9,
  });
  assert.equal(important.importance, 0.9);
  const { memories } = selectMemories(store, { query: '咖啡', limit: 2 });
  assert.ok(memories.length >= 1);
  assert.match(memories[0].content, /美式/);
});

test('候选记忆：不进 active/注入，单独计数；approve 转正、reject 归档', (t) => {
  const { store } = makeTempStore(t);
  const candidate = store.rememberMemory({ type: 'preference', content: '用户提过想学一点 Rust', status: 'candidate' });
  assert.equal(candidate.status, 'candidate');
  assert.equal(store.memoryCounts().active, 0);
  assert.equal(store.memoryCounts().candidates, 1);
  assert.equal(selectMemories(store, { query: 'Rust' }).memories.length, 0, '候选不应被注入');
  assert.match(renderStatus({
    store,
    config: testConfig(),
    paths: { dbPath: store.path, dataDir: '', logFile: '' },
    personaInfo: { sources: [], missing: [] },
    version: '0.1.0',
  }), /候选记忆/);

  const promoted = store.promoteCandidate(candidate.id, '测试确认');
  assert.equal(promoted.status, 'active');
  assert.equal(store.memoryCounts().active, 1);
  assert.equal(store.memoryCounts().candidates, 0);

  const second = store.rememberMemory({ content: '用户提过想养猫', status: 'candidate' });
  store.rejectCandidate(second.id, '测试拒绝');
  assert.equal(store.getMemory(second.id).status, 'archived');
  assert.equal(store.memoryCounts().candidates, 0);
});

test('候选重复出现达到阈值自动转正，且不新增行', (t) => {
  const { store } = makeTempStore(t);
  const first = store.rememberMemory({ content: '用户说想周末去爬山', status: 'candidate', promoteHits: 2, confidence: 0.6 });
  assert.equal(first.status, 'candidate');
  const second = store.rememberMemory({ content: '用户说想周末去爬山。', status: 'candidate', promoteHits: 2, confidence: 0.65 });
  assert.equal(second.id, first.id, '同一条不应增生');
  assert.equal(second.status, 'active');
  assert.ok(second.hits >= 2);
  assert.equal(store.memoryCounts().candidates, 0);
});

test('近似重复表述只强化旧条目（hooks 端）', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-1');

  ctx.emit('session/event', session, userMessageEvent('记住：我喜欢用 Python 写工具'));
  const before = store.listMemories({ status: 'active' });
  assert.equal(before.length, 1);

  ctx.emit('session/event', session, userMessageEvent('记住：我喜欢用 Python 写小工具'));
  const after = store.listMemories({ status: 'active' });
  assert.equal(after.length, 1, '近似重复不应新增');
  assert.ok(after[0].hits >= 2, '旧条目应被强化');
});

test('冲突：同一件事的新版本取代旧版本', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-1');

  ctx.emit('session/event', session, userMessageEvent('记住：部署时先跑测试再发布'));
  const old = store.listMemories({ status: 'active' }).find((memory) => /部署时/.test(memory.content));
  assert.ok(old);

  ctx.emit('session/event', session, userMessageEvent('记住：上线时先跑测试再发布'));
  const active = store.listMemories({ status: 'active' });
  const fresh = active.find((memory) => /上线时/.test(memory.content));
  assert.ok(fresh, '新版本应为 active');
  assert.equal(store.getMemory(old.id).status, 'superseded', '旧版本应被取代');
  assert.equal(store.getMemory(old.id).supersededBy, fresh.id, '应记录被谁取代');
});

test('用户确认语把本会话最近的候选记忆转正', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-1');

  ctx.emit('session/event', session, userMessageEvent('我更喜欢用 Vim 写代码'));
  assert.equal(store.memoryCounts().candidates, 1, '自动抽取先进入候选区');
  assert.equal(selectMemories(store, { query: 'Vim' }).memories.length, 0);

  ctx.emit('session/event', session, userMessageEvent('对，就是这样'));
  assert.equal(store.memoryCounts().candidates, 0, '确认后应转正');
  assert.ok(store.listMemories({ status: 'active' }).some((memory) => /Vim/.test(memory.content)));
});

test('助手文本不会变成用户记忆（v0.6：语义抽取关闭时只记回合摘要）', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig({ memoryExtraction: 'off' }), logger);
  const session = makeSession('s-1');

  ctx.emit('session/event', session, userMessageEvent('继续做记忆质量改造'));
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '下一步我会把候选记忆接进定时整理流程' }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  assert.equal(store.listCandidates(10).length, 0, '助手承诺不能写成用户候选记忆');
  assert.equal(store.memoryCounts().active, 0, '回合结束不应写正式记忆');
  assert.equal(store.recentTurns(5, 's-1').length, 1, '原始回合仍要记录，供以后语义抽取/复盘');
});

test('schema v1→v2 迁移：自动加列、备份、旧数据保留', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soul-migrate-'));
  const path = join(dir, 'soul.db');
  t.after(() => { try { rmSync(dir, { recursive: true, force: true, maxRetries: 3 }); } catch { /* win lock */ } });

  const old = new DatabaseSync(path);
  old.exec(`
    CREATE TABLE memories (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL DEFAULT 'fact',
      content TEXT NOT NULL,
      norm TEXT NOT NULL UNIQUE,
      tags TEXT NOT NULL DEFAULT '',
      source TEXT NOT NULL DEFAULT 'auto',
      confidence REAL NOT NULL DEFAULT 0.6,
      status TEXT NOT NULL DEFAULT 'active',
      project_id INTEGER,
      session_id TEXT,
      superseded_by INTEGER,
      hits INTEGER NOT NULL DEFAULT 1,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      last_accessed_at INTEGER
    );
    PRAGMA user_version = 1;
    INSERT INTO memories (type, content, norm, created_at, updated_at)
      VALUES ('fact', '旧库里的记忆', '旧库里的记忆', 1, 1);
  `);
  old.close();

  const store = openStore(path);
  t.after(() => { try { store.close(); } catch { /* closed */ } });
  assert.equal(store.stats().schemaVersion, String(SCHEMA_VERSION), `版本应升到 ${SCHEMA_VERSION}`);
  assert.equal(store.getMemory(1).content, '旧库里的记忆');
  assert.equal(store.getMemory(1).importance, 0.5, '迁移后 importance 用默认值');
  assert.ok(readdirSync(dir).some((name) => /\.bak-v1-/.test(name)), '升级前应自动备份');
  store.close();
});

test('/soul candidates|approve|reject|backup 真实执行', (t) => {
  const { store, run } = setupCommands(t);
  const candidate = store.rememberMemory({ content: '用户想把插件发布到 npm', status: 'candidate' });

  const list = run('candidates');
  assert.equal(list.kind, 'success');
  assert.match(list.text, /候选记忆/);

  const approved = run(`approve ${candidate.id}`);
  assert.equal(approved.kind, 'success');
  assert.match(approved.text, /已确认/);
  assert.equal(store.getMemory(candidate.id).status, 'active');

  const second = store.rememberMemory({ content: '用户想换掉整套存储方案', status: 'candidate' });
  const rejected = run(`reject ${second.id}`);
  assert.match(rejected.text, /已拒绝/);
  assert.equal(store.getMemory(second.id).status, 'archived');

  const backup = run('backup');
  assert.equal(backup.kind, 'success');
  assert.match(backup.text, /已备份/);
  const target = backup.text.replace('已备份记忆库到 ', '').trim();
  assert.ok(existsSync(target), `备份文件应存在：${target}`);
});

test('renderMemoryList 标出候选与重要记忆', (t) => {
  const { store } = makeTempStore(t);
  const important = store.rememberMemory({ type: 'preference', content: '用户喜欢先给结论', importance: 0.9 });
  const candidate = store.rememberMemory({ type: 'preference', content: '用户好像想学摄影', status: 'candidate' });
  const text = renderMemoryList([important, candidate]);
  assert.match(text, /重要/);
  assert.match(text, /候选/);
});
