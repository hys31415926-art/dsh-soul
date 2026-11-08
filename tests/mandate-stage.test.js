/**
 * v1.8 的两处借鉴：写入凭据（mandate）与项目条目的「在等谁」（stage/report）。
 * 这两个都是读侧可解释性：没记凭据的旧记忆不猜，没标 stage 的条目不假装在等人。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  describeMandate, normalizeMandate, strongerMandate, parseMandate, serializeMandate,
} from '../lib/memory/mandate.js';
import { renderProjectList, renderProjectSnapshot } from '../lib/memory/render.js';
import { registerCommand } from '../lib/commands/soul.js';
import { addEvidence } from '../lib/memory/evidence.js';
import { reportToStage } from '../lib/core/project-manager.js';
import {
  fakeCommands, makeCtx, makeTempStore, testConfig,
} from './helpers.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function setupCommands(t) {
  const { store, dir } = makeTempStore(t);
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  const paths = {
    dbPath: 'C:/tmp/soul.db', dataDir: dir, logFile: '', skill: join(dir, 'SKILL.md'),
  };
  registerCommand(ctx, {
    store,
    config: testConfig(),
    paths,
    personaInfo: { sources: [], missing: [] },
    version: '0.1.0',
    logger,
  });
  const run = (rawInput) => {
    // 宿主的命令注册表把 /soul 前缀剥掉了，这里保持同样的形状；handler 返回 { kind, text }。
    const result = commands.definitions[0].handler({
      agent: { session: { id: 's-1' } },
      rawInput: String(rawInput).replace(/^\/soul\s*/u, ''),
    });
    return String(result?.text ?? result ?? '');
  };
  return { store, run };
}

test('mandate：明确写入记成 explicit，推断写入记成 inferred', () => {
  const explicit = normalizeMandate({ strength: 'explicit', basis: 'assistant-tool', rule: 'soul_remember' }, { source: 'auto' });
  assert.equal(explicit.strength, 'explicit');
  assert.equal(explicit.basis, 'assistant-tool');
  const inferred = normalizeMandate(undefined, { source: 'auto', by: 'assistant' });
  assert.equal(inferred.strength, 'inferred');
  // tool / user-explicit 这类来源没显式给强度时按明确算
  const fromTool = normalizeMandate(undefined, { source: 'user-explicit' });
  assert.equal(fromTool.strength, 'explicit');
});

test('mandate：explicit 不会被后来的推断合并降级', () => {
  const strong = serializeMandate(normalizeMandate({ strength: 'explicit', basis: 'a', ts: 100 }, {}));
  const weak = serializeMandate(normalizeMandate({ strength: 'inferred', basis: 'b', ts: 200 }, {}));
  const merged = strongerMandate(parseMandate(strong), parseMandate(weak));
  assert.equal(merged.strength, 'explicit');
  assert.match(describeMandate(serializeMandate(merged)), /明确/);
});

test('mandate：坏 JSON 不抛，当没记录', () => {
  assert.equal(parseMandate('{不是 json'), null);
  assert.match(describeMandate(''), /没有记录写入凭据/);
});

test('/soul why #id 能答「这条凭什么被写」', (t) => {
  const { store, run } = setupCommands(t);
  const saved = store.rememberMemory({
    type: 'fact',
    content: '前辈的机器上没装 git 命令',
    source: 'tool',
    mandate: { strength: 'explicit', basis: 'assistant-tool', rule: 'soul_remember' },
  });
  const out = run(`/soul why #${saved.id}`);
  assert.match(out, new RegExp(`#${saved.id}`));
  assert.match(out, /写入凭据/);
  assert.match(out, /明确/);
  // 不带 id 时仍走原来的唤醒历史
  assert.match(run('/soul why'), /最近一次真实注入/);
});

test('/soul why 与 diagnose 显示最近一条证据原文', (t) => {
  const { store, run } = setupCommands(t);
  const saved = store.rememberMemory({ type: 'fact', content: '我喜欢喝乌龙茶', source: 'user-explicit' });
  addEvidence(store, saved.id, [{ sessionId: 's-1', turn: 2, role: 'user', quote: '我喜欢喝乌龙茶' }]);
  const why = run(`/soul why #${saved.id}`);
  assert.match(why, /最近证据/);
  assert.match(why, /第2轮·用户「我喜欢喝乌龙茶」/);
  const diagnosis = run(`/soul diagnose memory:#${saved.id}`);
  assert.match(diagnosis, /最近证据/);
  assert.match(diagnosis, /第2轮·用户「我喜欢喝乌龙茶」/);
});

test('stage/report：有等人项才展开，清掉标记就压回健康行', (t) => {
  const { store } = setupCommands(t);
  const project = store.upsertProject({ name: 'soul 改造' });
  const item = store.addProjectItem(project.id, 'todo', '等你确认改动 1 的文案', {
    stage: 'person', report: 'waiting',
  });
  const waiting = renderProjectList(store.listProjects({ status: 'any' }), store);
  assert.match(waiting, /等你 1/);
  assert.match(waiting, /等你确认改动 1 的文案/);

  store.setProjectItemReport(item.id, reportToStage('clear'));
  const healthy = renderProjectList(store.listProjects({ status: 'any' }), store);
  assert.match(healthy, /健康/);
  assert.doesNotMatch(healthy, /等你 1/);
});

test('stage/report：快照里带出「在等谁」，done 的项不带', (t) => {
  const { store } = setupCommands(t);
  const project = store.upsertProject({ name: 'p' });
  const todo = store.addProjectItem(project.id, 'todo', '跑一轮回归');
  store.setProjectItemReport(todo.id, reportToStage('agent'));
  const done = store.addProjectItem(project.id, 'done', '改造 1 落地');
  store.setProjectItemReport(done.id, reportToStage('agent'));
  store.setProjectItemState(done.id, 'done');
  const text = renderProjectSnapshot(store.projectSnapshot(project.id));
  assert.match(text, /跑一轮回归（在跑）/);
  assert.doesNotMatch(text, /改造 1 落地（在跑）/);
});

test('/soul item 认词表，认不出时明确报错', (t) => {
  const { store, run } = setupCommands(t);
  const project = store.upsertProject({ name: 'p' });
  const item = store.addProjectItem(project.id, 'todo', '核对 schema 版本');
  assert.match(run(`/soul item ${item.id} person`), /标记为「person」/);
  assert.equal(store.getProjectItem(item.id).stage, 'person');
  assert.match(run(`/soul item ${item.id} 瞎写`), /认不出/);
  assert.match(run(`/soul item ${item.id} clear`), /已清掉/);
  assert.equal(store.getProjectItem(item.id).stage, '');
  assert.match(run('/soul item 999999 person'), /找不到条目/);
});

test('/soul next 按「在等谁」分组：我在推的、卡住的、等你的', (t) => {
  const { store, run } = setupCommands(t);
  const project = store.upsertProject({ name: 'soul 改造' });
  const mine = store.addProjectItem(project.id, 'todo', '把 knock 的内容价值也接上');
  store.setProjectItemReport(mine.id, reportToStage('agent'));
  const stuck = store.addProjectItem(project.id, 'issue', '依赖的 QQ 接口还没起来');
  store.setProjectItemReport(stuck.id, reportToStage('blocked'));
  const waiting = store.addProjectItem(project.id, 'todo', '等你确认文案');
  store.setProjectItemReport(waiting.id, reportToStage('person'));
  const finished = store.addProjectItem(project.id, 'done', '改造 1 已落地');
  store.setProjectItemReport(finished.id, reportToStage('agent'));
  store.setProjectItemState(finished.id, 'done');

  const out = run('/soul next');
  assert.match(out, /我这边该推的（1）/);
  assert.match(out, /把 knock 的内容价值也接上/);
  assert.match(out, /卡住的（1）/);
  assert.match(out, /在等你（1）/);
  assert.doesNotMatch(out, /改造 1 已落地/);
  // 什么都没挂时给的是下一步用法，不是空白
  const empty = setupCommands(t);
  assert.match(empty.run('/soul next'), /没有挂着的事|该推/);
});
