/**
 * 双层裁决：外层闸门确定「归谁」，内层打分决定「急不急」。
 * 这里只测函数本身，不连库。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  assessItem, evaluateItem, gateItem, rankItems,
} from '../lib/core/eval.js';

const DAY = 24 * 3_600_000;

test('闸门：标了我在推 → explicit 放行；在等你/卡住/做完 → 不放行', () => {
  assert.equal(gateItem({ state: 'open', stage: 'agent' }).strength, 'explicit');
  assert.equal(gateItem({ state: 'open', stage: 'person' }).pass, false);
  assert.match(gateItem({ state: 'open', stage: 'blocked' }).reason, /卡住/);
  assert.equal(gateItem({ state: 'done', stage: 'agent' }).pass, false);
  assert.match(gateItem({ state: 'open', report: 'failed' }).reason, /卡住|失败/);
});

test('闸门：没标状态但有优先级的 todo 算推断；没有标记也没优先级就自己别加活', () => {
  const inferred = gateItem({ state: 'open', kind: 'todo', priority: 2 });
  assert.equal(inferred.strength, 'inferred');
  assert.equal(inferred.pass, true);
  const bare = gateItem({ state: 'open', kind: 'todo', priority: 0 });
  assert.equal(bare.pass, false);
});

test('打分：优先级 + 挂的天数 + 验收条件会加分，有前置会扣一点', () => {
  const now = 100 * DAY;
  const aged = assessItem({ priority: 2, createdAt: now - 9 * DAY, acceptance: '跑通 271 条' }, { now });
  assert.ok(aged.score >= 0.7, `score=${aged.score}`);
  assert.ok(aged.matched.some((m) => m.includes('7 天')));
  const withDep = assessItem({ priority: 2, createdAt: now - 9 * DAY, dependsOn: '3' }, { now });
  assert.ok(withDep.score < aged.score);
  assert.ok(withDep.matched.includes('有前置'));
});

test('裁决：observe 模式下推断出来的事只记「本来会做」，auto 且过线才动手', () => {
  const item = { state: 'open', kind: 'todo', priority: 3, createdAt: Date.now() - 10 * DAY };
  const observed = evaluateItem(item, { mode: 'observe' });
  assert.equal(observed.decision, 'observe');
  assert.equal(observed.strength, 'inferred');
  const auto = evaluateItem(item, { mode: 'auto' });
  assert.equal(auto.decision, 'accept');
  // explicit 不需要过线，永远算数
  const explicit = evaluateItem({ state: 'open', stage: 'agent', priority: 1 }, { mode: 'observe' });
  assert.equal(explicit.decision, 'accept');
});

test('排序：accept 在前，其次 observe，卡住的垫底', () => {
  const now = Date.now();
  const items = [
    { id: 1, state: 'open', kind: 'todo', priority: 1, createdAt: now - 1 * DAY, stage: 'blocked' },
    { id: 2, state: 'open', kind: 'todo', priority: 2, createdAt: now - 5 * DAY },
    { id: 3, state: 'open', stage: 'agent', priority: 1 },
  ];
  const ranked = rankItems(items, { mode: 'observe', now });
  assert.deepEqual(ranked.map((r) => r.item.id), [3, 2, 1]);
  assert.equal(ranked[0].verdict.decision, 'accept');
  assert.equal(ranked[1].verdict.decision, 'observe');
  assert.equal(ranked[2].verdict.decision, 'wait');
});

test('/soul accept 能查能改，乱词不动设置', async () => {
  const { join } = await import('node:path');
  const { registerCommand } = await import('../lib/commands/soul.js');
  const { fakeCommands, makeCtx, makeTempStore, testConfig } = await import('./helpers.js');
  const { store, dir } = makeTempStore({ after() {} });
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  registerCommand(ctx, {
    store,
    config: testConfig(),
    paths: { dbPath: 'C:/tmp/soul.db', dataDir: dir, logFile: '', skill: join(dir, 'SKILL.md') },
    personaInfo: { sources: [], missing: [] },
    version: '0.1.0',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
  });
  const run = (rawInput) => String(commands.definitions[0].handler({
    agent: { session: { id: 's-1' } },
    rawInput: String(rawInput).replace(/^\/soul\s*/u, ''),
  })?.text ?? '');
  assert.match(run('/soul accept'), /当前裁决模式：observe/);
  assert.match(run('/soul accept auto'), /已设为 auto/);
  assert.equal(store.metaGet('soul.acceptMode'), 'auto');
  assert.match(run('/soul accept 乱写'), /认不出/);
  assert.equal(store.metaGet('soul.acceptMode'), 'auto');
});
