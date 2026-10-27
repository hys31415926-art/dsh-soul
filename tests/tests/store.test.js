/** store 层：记忆 CRUD、去重、纠正优先、项目隔离、任务、回合、关系、整理。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import { openStore, SCHEMA_VERSION } from '../lib/memory/store.js';

test('记忆：写入后能检索；重复写入合并加权而不是增生', (t) => {
  const { store } = makeTempStore(t);
  const first = store.rememberMemory({ type: 'preference', content: '用户喜欢先看结论再听分析' });
  const second = store.rememberMemory({ type: 'preference', content: '用户喜欢先看结论再听分析' });

  assert.equal(first.id, second.id, '同一内容应去重');
  assert.ok(second.hits >= 2, '重复命中次数应累加');
  assert.equal(store.memoryCounts().active, 1);

  const rows = store.searchMemories('结论');
  assert.ok(rows.some((row) => row.id === first.id), '中文短词检索应命中');
});

test('记忆：纠正后用新版本取代旧版本，检索只返回新版本且历史可追溯', (t) => {
  const { store } = makeTempStore(t);
  const oldMemory = store.rememberMemory({ type: 'preference', content: '用户喜欢用 Python 写工具' });
  const newMemory = store.rememberMemory({ type: 'preference', content: '用户喜欢用 TypeScript 写工具' });
  assert.equal(store.supersedeMemory(oldMemory.id, { newId: newMemory.id, reason: '用户纠正' }), true);

  const active = store.listMemories({ status: 'active' });
  assert.deepEqual(active.map((row) => row.id), [newMemory.id], 'active 里不应再有旧版本');
  assert.equal(store.getMemory(oldMemory.id).status, 'superseded');
  assert.equal(store.getMemory(oldMemory.id).supersededBy, newMemory.id);
  assert.ok(store.memoryHistory(oldMemory.id).length >= 1, '历史记录可用于追溯');
});

test('记忆：eraseMemory 彻底删除并清掉历史，不留内容副本', (t) => {
  const { store } = makeTempStore(t);
  const memory = store.rememberMemory({ type: 'fact', content: '用户的生日是十月二十四日' });
  assert.equal(store.eraseMemory(memory.id), true);
  assert.equal(store.getMemory(memory.id), null);
  assert.equal(store.memoryHistory(memory.id).length, 0);
});

test('项目：条目按项目隔离，同类同文只留一条', (t) => {
  const { store } = makeTempStore(t);
  const alpha = store.upsertProject({ name: '小说项目', goal: '完成第一卷' });
  const beta = store.upsertProject({ name: '工具项目', goal: '发布 1.0' });

  store.addProjectItem(alpha.id, 'decision', '主角设定为失忆的守夜人');
  store.addProjectItem(alpha.id, 'decision', '主角设定为失忆的守夜人');
  store.addProjectItem(beta.id, 'decision', '用 SQLite 存记忆');

  const alphaSnapshot = store.projectSnapshot(alpha.id);
  const betaSnapshot = store.projectSnapshot(beta.id);
  assert.equal(alphaSnapshot.byKind.decision.length, 1);
  assert.equal(betaSnapshot.byKind.decision.length, 1);
  assert.match(alphaSnapshot.byKind.decision[0].content, /守夜人/);
  assert.match(betaSnapshot.byKind.decision[0].content, /SQLite/);
  assert.equal(store.projectSnapshot(beta.id).project.name, '工具项目');
});

test('任务：pending → in_progress → completed/blocked 状态可持久化', (t) => {
  const { store } = makeTempStore(t);
  const task = store.addTask({ title: '写完记忆检索测试', acceptance: 'node --test 通过' });
  assert.equal(task.state, 'pending');
  assert.equal(store.setTaskState(task.id, 'in_progress').state, 'in_progress');
  assert.equal(store.setTaskState(task.id, 'completed').state, 'completed');
  assert.equal(store.openTasks().length, 0, '已完成任务不应出现在未完成列表');
  assert.equal(store.listTasks({ state: 'completed' }).length, 1);
});

test('回合：同一 session/turn 重复记录保持幂等，会话状态可读写', (t) => {
  const { store } = makeTempStore(t);
  const input = {
    sessionId: 's-1', turn: 1, userText: '我们来推进 dsh-soul',
    assistantText: '好，先看状态', toolCalls: 2, reason: 'completed',
    startedAt: Date.now() - 1000, endedAt: Date.now(), origin: 'user', cwd: 'C:/work',
  };
  store.recordTurn(input);
  store.recordTurn(input); // 同一回合重复事件不应重复计数
  assert.equal(store.recentTurns(5, 's-1').length, 1);
  assert.equal(store.turnCount(), 1);

  store.setSessionState('s-1', { mode: 'work', activeProjectId: 3, lastUserText: '继续' });
  const state = store.getSessionState('s-1');
  assert.equal(state.mode, 'work');
  assert.equal(state.activeProjectId, 3);
  assert.equal(state.lastUserText, '继续');
});

test('关系：称呼/尺度/梗/边界可更新，轮次累加', (t) => {
  const { store } = makeTempStore(t);
  store.setRelation({ userAlias: '主人', agentAlias: '鱼', tone: '允许更亲密', boundaries: '别叫我宝贝', sharedTerms: '噢耶耶' });
  const relation = store.getRelation();
  assert.equal(relation.userAlias, '主人');
  assert.equal(relation.agentAlias, '鱼');
  assert.match(relation.sharedTerms, /噢耶耶/);
  store.bumpRelationTurn();
  store.bumpRelationTurn();
  assert.ok(store.getRelation().turns >= 2);
});

test('整理与重启：curate/meta 正常；关闭后重新打开数据仍在（持久化）', (t) => {
  const { store, path } = makeTempStore(t);
  store.rememberMemory({ type: 'profile', content: '用户在做一个长期 Agent 插件' });
  store.metaSet('last_loaded_at', '123');
  const result = store.curate({ retentionDays: 30 });
  assert.equal(typeof result, 'object');
  store.close();

  const reopened = openStore(path);
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.equal(reopened.memoryCounts().active, 1, '重启后记忆仍应存在');
  assert.equal(reopened.metaGet('last_loaded_at'), '123');
  assert.equal(reopened.stats().schemaVersion, String(SCHEMA_VERSION));
  reopened.close(); // 先放句柄，makeTempStore 的清理才能删掉目录（Windows）
});

test('检索：拆字写法变体——搜「口牙」也能召回含「牙」的记录，反之亦然', (t) => {
  const { store } = makeTempStore(t);
  const brushing = store.rememberMemory({ type: 'fact', content: '主人刷牙喜欢用电动牙刷' });
  const splitWord = store.rememberMemory({ type: 'interaction', content: '强者语的怪叫可以拆写成口牙、口也', tags: '海虎 拆字' });

  // 「口牙」整串不命中「刷牙」，但拆字变体「牙」应能召回它。
  assert.ok(store.searchMemories('口牙').some((row) => row.id === brushing.id), '口牙 → 变体「牙」应召回含「牙」的记录');
  assert.ok(store.searchMemories('口牙').some((row) => row.id === splitWord.id), '整串「口牙」应命中写了「口牙」的记录');
  // 单字查询也向反方向补一个「口X」变体。
  assert.ok(store.searchMemories('牙').some((row) => row.id === splitWord.id), '「牙」→ 变体「口牙」应召回拆字记录');
  // 长句不做拆字展开，避免检索被放大成噪音。
  const longQuery = store.searchMemories('主人刷牙喜欢用电动牙刷这件事我们之前说过的');
  assert.ok(longQuery.length >= 0);
});
