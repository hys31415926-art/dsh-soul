/** tools 层：15 个 soul_* 工具真实读写数据库（不经过模型）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { fakeTools, makeCtx, makeTempStore, testConfig } from './helpers.js';
import { registerTools } from '../lib/tools.js';
import { openMemeDb } from '../lib/meme.js';

function setup(t, memeDb = null) {
  const { store } = makeTempStore(t);
  const tools = fakeTools();
  const ctx = makeCtx({ tools });
  const paths = { dbPath: 'C:/tmp/soul.db', dataDir: 'C:/tmp', logFile: '', skill: '' };
  const personaInfo = { sources: [], missing: [] };
  const dispose = registerTools(ctx, store, testConfig(), paths, personaInfo, '0.1.0', memeDb);
  const get = (name) => tools.tools.find((tool) => tool.name === name);
  const exec = (name, args, sessionId = 's-1') => get(name).execute(args, { agent: { session: { id: sessionId } }, signal: { aborted: false } });
  return { store, tools, dispose, get, exec };
}

test('注册：15 个工具全部注册，且卸载后清空', (t) => {
  const { tools, dispose } = setup(t);
  const names = tools.tools.map((tool) => tool.name).sort();
  assert.deepEqual(names, [
    'soul_episodes', 'soul_forget', 'soul_judge', 'soul_learn', 'soul_meme', 'soul_mood', 'soul_projects',
    'soul_remember', 'soul_review', 'soul_search', 'soul_self', 'soul_session', 'soul_status',
    'soul_style_feedback', 'soul_task',
  ]);
  dispose();
  assert.equal(tools.tools.length, 0);
});

test('soul_remember / search / forget 闭环', async (t) => {
  const { exec, store } = setup(t);
  const saved = await exec('soul_remember', { content: '用户喜欢先看结论，再听分析', type: 'preference', confidence: 0.9 });
  assert.match(saved.text, /记下了 #\d+/);

  const found = await exec('soul_search', { query: '结论' });
  assert.equal(found.count, 1);
  assert.match(found.text, /先看结论/);

  const memoryId = store.listMemories()[0].id;
  const deleted = await exec('soul_forget', { id: memoryId });
  assert.equal(deleted.deleted, true);
  assert.equal(store.getMemory(memoryId), null);
});

test('soul_remember：空内容报错，不会静默成功', async (t) => {
  const { exec } = setup(t);
  await assert.rejects(() => exec('soul_remember', { content: '   ' }), /content 不能为空/);
});

test('soul_projects：upsert / add / snapshot / item-state / delete-item', async (t) => {
  const { exec, store } = setup(t);
  const project = await exec('soul_projects', { action: 'upsert', name: 'dsh-soul', goal: '长期伙伴插件' });
  assert.match(project.text, /已就绪/);

  await exec('soul_projects', { action: 'add', content: '决定用 SQLite 存长期记忆' });
  const snapshot = await exec('soul_projects', { action: 'snapshot', project: 'dsh-soul' });
  assert.match(snapshot.text, /SQLite/);

  const items = store.listProjectItems(store.matchProject('dsh-soul').id, { kind: 'decision' });
  const updated = await exec('soul_projects', { action: 'item-state', itemId: items[0].id, state: 'done' });
  assert.match(updated.text, /done/);

  await exec('soul_projects', { action: 'delete-item', itemId: items[0].id });
  assert.equal(store.listProjectItems(store.matchProject('dsh-soul').id, { kind: 'decision' }).length, 0);

  const list = await exec('soul_projects', { action: 'list' });
  assert.match(list.text, /dsh-soul/);
});

test('soul_task：add / update / list', async (t) => {
  const { exec } = setup(t);
  const added = await exec('soul_task', { action: 'add', title: '写自动化测试', acceptance: 'node --test 全绿' });
  assert.match(added.text, /写自动化测试/);

  const list = await exec('soul_task', { action: 'list' });
  assert.equal(list.count, 1);

  const taskId = /#(\d+)/.exec(list.text)?.[1];
  assert.ok(taskId, '列表里应带任务 id');
  const updated = await exec('soul_task', { action: 'update', id: Number(taskId), state: 'completed' });
  assert.match(updated.text, /completed/);
  assert.equal((await exec('soul_task', { action: 'list' })).count, 0);
});

test('soul_session：写入会话状态并可切项目', async (t) => {
  const { exec, store } = setup(t);
  await exec('soul_projects', { action: 'upsert', name: '记忆系统', goal: '让记忆跨会话' });
  const state = await exec('soul_session', { mode: 'work', openQuestion: '旧版本记忆要不要迁移', project: '记忆系统' });
  assert.match(state.text, /模式=work/);

  const sessionState = store.getSessionState('s-1');
  assert.equal(sessionState.mode, 'work');
  assert.ok(sessionState.activeProjectId > 0);
});

test('soul_status / soul_review 返回可读摘要', async (t) => {
  const { exec } = setup(t);
  const status = await exec('soul_status', {});
  assert.match(status.text, /记忆|项目|0\.1\.0/);
  const review = await exec('soul_review', { turns: 5 });
  assert.ok(review.text.length > 0);
});

test('soul_learn / soul_self / soul_episodes 闭环', async (t) => {
  const { exec, store } = setup(t);
  const learned = await exec('soul_learn', { title: '部署 dsh-soul', body: '复制到 profile node_modules 后重启宿主' });
  assert.match(learned.text, /沉淀 #\d+/);
  const found = await exec('soul_search', { query: '部署' });
  assert.equal(found.count, 1);

  const self = await exec('soul_self', { text: '我是后辈搭子，先给结论' });
  assert.match(self.text, /自我认知已更新/);
  assert.equal(store.metaGet('soul.selfModel'), '我是后辈搭子，先给结论');

  const episodes = await exec('soul_episodes', { limit: 5 });
  assert.equal(episodes.count, 0);
  assert.match(episodes.text, /还没有记录/);
});

test('soul_judge：guess / result / list 闭环，且不进记忆库', async (t) => {
  const { exec, store } = setup(t);
  const guess = await exec('soul_judge', { action: 'guess', kind: 'read', subject: '他问「在吗」', guess: '他其实想让我先别追问，直接聊' });
  assert.match(guess.text, /判断 #\d+ 已记录/);

  const id = /#(\d+)/.exec(guess.text)?.[1];
  assert.ok(id, '记录应返回判断 id');
  const resolved = await exec('soul_judge', { action: 'result', id: Number(id), outcome: 'right', note: '他直接聊起来了' });
  assert.match(resolved.text, /猜对了/);

  const listed = await exec('soul_judge', { action: 'list', limit: 5 });
  assert.equal(listed.count, 1);
  assert.match(listed.text, /\[对\]/);

  // 判断不是记忆：记忆库必须仍然是空的。
  assert.equal(store.listMemories().length, 0);
  await assert.rejects(() => exec('soul_judge', { action: 'guess', guess: '  ' }), /guess 不能为空/);
});

test('soul_meme：没有梗库时降级提示，不抛错', async (t) => {
  const { exec } = setup(t);
  const res = await exec('soul_meme', { query: '大水理论' });
  assert.match(res.text, /没有梗库/);
});

test('soul_meme：真实梗库命中词条、查不到给明确提示', async (t) => {
  const memes = 'C:\\Users\\HP\\.dsh\\dsh-soul\\memes.db';
  if (!existsSync(memes)) return t.skip('memes.db 未部署');
  const db = openMemeDb(memes);
  assert.ok(db, '梗库应能打开');
  const { exec } = setup(t, db);
  const hit = await exec('soul_meme', { query: '大水理论' });
  assert.match(hit.text, /【怎么用/);
  const miss = await exec('soul_meme', { query: 'zzz不存在zzz' });
  assert.match(miss.text, /梗库里没有/);
  db.close();
});
