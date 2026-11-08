/**
 * v1.9 第 5 步：会话订阅项目 → 抽取出的记忆自动挂靠。
 * 关键约束：只有一个订阅时才挂；多个订阅是歧义，宁可不挂。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { registerCommand } from '../lib/commands/soul.js';
import {
  fakeCommands, makeCtx, makeTempStore, testConfig,
} from './helpers.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function setup(t) {
  const { store, dir } = makeTempStore(t);
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  registerCommand(ctx, {
    store,
    config: testConfig(),
    paths: {
      dbPath: 'C:/tmp/soul.db', dataDir: dir, logFile: '', skill: join(dir, 'SKILL.md'),
    },
    personaInfo: { sources: [], missing: [] },
    version: '0.1.0',
    logger,
  });
  const run = (rawInput) => String(commands.definitions[0].handler({
    agent: { session: { id: 's-1' } },
    rawInput: String(rawInput).replace(/^\/soul\s*/u, ''),
  })?.text ?? '');
  return { store, run };
}

test('订阅一个项目后，抽取的记忆自动挂到它名下', (t) => {
  const { store } = setup(t);
  const project = store.upsertProject({ name: 'dsh-soul' });
  assert.equal(store.subscribeSession('s-1', project.id), true);
  const saved = store.rememberMemory({
    type: 'project',
    content: 'v1.9 的双层裁决走的是 eval.js',
    source: 'auto',
    sessionId: 's-1',
  });
  assert.equal(Number(saved.projectId ?? 0), Number(project.id));
});

test('订阅多个项目时不自动挂靠（歧义不猜）', (t) => {
  const { store } = setup(t);
  const a = store.upsertProject({ name: 'a' });
  const b = store.upsertProject({ name: 'b' });
  store.subscribeSession('s-1', a.id);
  store.subscribeSession('s-1', b.id);
  assert.equal(store.singleSubscriptionProject('s-1'), 0);
  const saved = store.rememberMemory({
    type: 'fact', content: '没订阅唯一项目时不挂靠', source: 'auto', sessionId: 's-1',
  });
  assert.ok(!saved.projectId, `projectId=${saved.projectId}`);
});

test('显式给了 projectId 时听显式的，不被订阅覆盖', (t) => {
  const { store } = setup(t);
  const a = store.upsertProject({ name: 'a' });
  const b = store.upsertProject({ name: 'b' });
  store.subscribeSession('s-1', a.id);
  const saved = store.rememberMemory({
    type: 'fact', content: '这条明确写着属于 b', source: 'auto', sessionId: 's-1', projectId: b.id,
  });
  assert.equal(Number(saved.projectId), Number(b.id));
});

test('/soul subscribe 能订阅、能看、能关掉', (t) => {
  const { store, run } = setup(t);
  const project = store.upsertProject({ name: 'dsh-soul' });
  assert.match(run('/soul subscribe'), /还没订阅/);
  assert.match(run('/soul subscribe dsh-soul'), /订阅了「dsh-soul」/);
  assert.equal(store.listSessionSubscriptions('s-1').length, 1);
  assert.match(run('/soul subscribe'), /抽取出的记忆会自动挂到它下面/);
  assert.match(run('/soul subscribe off'), /清掉了 1 个订阅/);
  assert.equal(store.listSessionSubscriptions('s-1').length, 0);
  assert.match(run('/soul subscribe 不存在的项目'), /没有叫/);
  assert.equal(project.id > 0, true);
});
