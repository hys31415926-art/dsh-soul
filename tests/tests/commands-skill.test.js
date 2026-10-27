/** commands/skill 层：/soul 子命令真实读写；技能注册读文件。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fakeCommands, fakeSkills, makeCtx, makeTempStore, testConfig } from './helpers.js';
import { registerCommand } from '../lib/commands/soul.js';
import { registerSkill } from '../lib/skill.js';
import { recordJournal } from '../lib/memory/journal.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function setup(t) {
  const { store } = makeTempStore(t);
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  const tempDir = mkdtempSync(join(tmpdir(), 'dsh-soul-cmd-'));
  t.after(() => { try { rmSync(tempDir, { recursive: true, force: true }); } catch { /* ignore */ } });
  const paths = { dbPath: 'C:/tmp/soul.db', dataDir: tempDir, logFile: '', skill: join(tempDir, 'SKILL.md') };
  const personaInfo = { sources: [], missing: [] };
  const dispose = registerCommand(ctx, { store, config: testConfig(), paths, personaInfo, version: '0.1.0', logger });
  const command = commands.definitions[0];
  const run = (rawInput) => command.handler({ agent: { session: { id: 's-1' } }, rawInput });
  return { store, commands, ctx, paths, dispose, command, run };
}

test('注册：/soul 定义齐全（name/description/handler/input）', (t) => {
  const { command, dispose } = setup(t);
  assert.equal(command.name, 'soul');
  assert.ok(command.description.length > 10);
  assert.equal(typeof command.handler, 'function');
  assert.equal(typeof command.input?.hint, 'string');
  dispose();
});

test('status / help / config 返回可用信息', (t) => {
  const { run } = setup(t);
  const status = run('status');
  assert.equal(status.kind, 'success');
  assert.match(status.text, /0\.1\.0/);

  const help = run('help');
  assert.match(help.text, /soul/);

  const config = run('config');
  assert.match(config.text, /soul\.db|dbPath|注入/);
});

test('remember → search → forget 闭环（真实读写）', (t) => {
  const { run, store } = setup(t);
  const remembered = run('remember 用户喜欢先看结论再听分析');
  assert.equal(remembered.kind, 'success');
  assert.match(remembered.text, /#\d+/);

  const found = run('search 结论');
  assert.match(found.text, /先看结论/);

  const id = store.listMemories()[0].id;
  const forgotten = run(`forget ${id}`);
  assert.match(forgotten.text, /已彻底删除/);
  assert.equal(store.getMemory(id), null);
});

test('projects / project / switch / add / done 维护项目', (t) => {
  const { run, store } = setup(t);
  assert.match(run('projects').text, /没有|项目/);

  store.upsertProject({ name: 'dsh-soul', goal: '长期伙伴插件' });
  run('switch dsh-soul');
  assert.ok(store.getSessionState('s-1').activeProjectId > 0);

  const added = run('add 决定用 SQLite 存长期记忆');
  assert.match(added.text, /记入项目/);

  const snapshot = run('project dsh-soul');
  assert.match(snapshot.text, /SQLite/);

  const projectId = store.matchProject('dsh-soul').id;
  const item = store.listProjectItems(projectId)[0];
  const done = run(`done ${item.id}`);
  assert.match(done.text, /状态/);
});

test('review 生成复盘；export 真实写出 JSON 文件', (t) => {
  const { run, store, paths } = setup(t);
  store.rememberMemory({ type: 'preference', content: '用户喜欢直接结论' });
  assert.ok(run('review').text.length > 0);

  const exportPath = join(paths.dataDir, 'export.json');
  const exported = run(`export ${exportPath}`);
  assert.equal(exported.kind, 'success');
  assert.equal(existsSync(exportPath), true);
  const payload = JSON.parse(readFileSync(exportPath, 'utf8'));
  assert.ok(Array.isArray(payload.memories));
  assert.ok(payload.memories.some((memory) => /直接结论/.test(memory.content)));
});

test('未知子命令给帮助而不是假装执行', (t) => {
  const { run } = setup(t);
  const result = run('definitely-not-a-command');
  assert.equal(result.kind, 'error');
  assert.match(result.text, /用法|help/i);
});

test('skill：读取 SKILL.md 并注册 soul-workflow', (t) => {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soul-skill-'));
  t.after(() => { try { rmSync(dir, { recursive: true, force: true }); } catch { /* ignore */ } });
  mkdirSync(join(dir, 'skills'), { recursive: true });
  const skillPath = join(dir, 'SKILL.md');
  writeFileSync(skillPath, '# 测试技能\n\n先查记忆再动手。', 'utf8');

  const skills = fakeSkills();
  const ctx = makeCtx({ skills });
  const dispose = registerSkill(ctx, { paths: { skill: skillPath }, logger });
  assert.equal(skills.skills.length, 1);
  assert.equal(skills.skills[0].name, 'soul-workflow');
  assert.match(skills.skills[0].content, /先查记忆/);
  assert.deepEqual(skills.skills[0].invocation, { modelInvocable: true, userInvocable: true });
  dispose();

  const empty = fakeSkills();
  const ctxEmpty = makeCtx({ skills: empty });
  registerSkill(ctxEmpty, { paths: { skill: join(dir, 'missing.md') }, logger });
  assert.equal(empty.skills.length, 0, '缺文件时降级为不注册');
});

test('today / journal：项目工作日志真实读写', (t) => {
  const { run, store } = setup(t);
  const project = store.upsertProject({ name: 'dsh-soul', stage: '阶段二' });
  const projectId = Number(project?.id ?? 0);
  assert.ok(projectId > 0);
  store.setSessionState('s-1', { activeProjectId: projectId });
  recordJournal(store, { projectId, sessionId: 's-1', turn: 1, kind: 'progress', summary: '写完语义抽取模块并通过 96 项单测' });
  recordJournal(store, { projectId, sessionId: 's-1', turn: 1, kind: 'plan', summary: '接下来做真实宿主 E2E' });

  const today = run('today');
  assert.equal(today.kind, 'success');
  assert.match(today.text, /dsh-soul/);
  assert.match(today.text, /写完语义抽取模块/u);

  const journal = run('journal');
  assert.equal(journal.kind, 'success');
  assert.match(journal.text, /写完语义抽取模块/u);
  assert.match(journal.text, /真实宿主 E2E/u);

  // 没有活跃项目时也要能正常返回，而不是报错。
  const fresh = setup(t);
  assert.equal(fresh.run('today').kind, 'success');
  assert.equal(fresh.run('journal').kind, 'success');
});
