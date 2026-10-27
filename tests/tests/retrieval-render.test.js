/** retrieval/render 层：检索相关性、预算上限、注入块内容与空库行为。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore, testConfig } from './helpers.js';
import { buildQuery, selectMemories, selectRelationshipMaterial } from '../lib/memory/retrieval.js';
import { renderContextBlock, renderMemoryList, renderProjectSnapshot, renderReview, renderStatus, budgetPlan } from '../lib/memory/render.js';

function seed(store) {
  const project = store.upsertProject({ name: 'dsh-soul', goal: '长期伙伴插件', stage: '阶段二' });
  store.addProjectItem(project.id, 'decision', '记忆用 SQLite 存，不引入向量库');
  store.addProjectItem(project.id, 'todo', '完成管理命令与自动测试');
  store.addProjectItem(project.id, 'blocker', '宿主工具会话 id 拿不到');
  store.rememberMemory({ type: 'episodic', content: '决定用 SQLite 存长期记忆，不引入向量库', projectId: project.id });
  store.rememberMemory({ type: 'preference', content: '用户喜欢先看结论，再听分析过程', projectId: project.id });
  store.rememberMemory({ type: 'project', content: 'dsh-soul 第一阶段要能真实挂载', projectId: project.id });
  store.rememberMemory({ type: 'relationship', content: '用户叫我鱼，我叫用户主人' });
  store.setRelation({ userAlias: '主人', agentAlias: '鱼', sharedTerms: '噢耶耶' });
  store.setSessionState('s-1', { activeProjectId: project.id, lastUserText: 'SQLite 记忆怎么迁移' });
  return project;
}

test('检索：按查询词召回相关记忆，且遵守条数上限', (t) => {
  const { store } = makeTempStore(t);
  seed(store);

  const { memories } = selectMemories(store, { query: 'SQLite', limit: 3, budgetChars: 500 });
  assert.ok(memories.length > 0);
  assert.ok(memories.length <= 3);
  assert.ok(memories.some((memory) => /SQLite/.test(memory.content)));

  const query = buildQuery('SQLite 怎么迁移', { openQuestion: '旧版本要不要保留' });
  assert.match(query, /SQLite/);
});

test('检索：预算很小时宁可少给，也不超预算', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const { memories, chars } = selectMemories(store, { query: 'SQLite', limit: 10, budgetChars: 80 });
  assert.ok(chars <= 80 * 2, '预算应被硬性约束');
  assert.ok(memories.length <= 2);
});

test('检索：关系连续性素材取关系与交互类记忆', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  store.rememberMemory({ type: 'interaction', content: '用户不喜欢被反复追问' });
  const rows = selectRelationshipMaterial(store, 4);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((row) => row.status === 'active'));
});

test('注入块：空库不注入；有数据时含关系/项目/记忆且不超预算', (t) => {
  const { store } = makeTempStore(t);
  const config = testConfig();

  assert.equal(renderContextBlock({ store, config, sessionId: 'empty' }), '', '空库不应注入');

  seed(store);
  const text = renderContextBlock({ store, config, sessionId: 's-1', query: '帮我把 dsh-soul 的 SQLite 迁移改一下' });
  assert.ok(text.length > 0);
  assert.match(text, /我记着的/);
  assert.match(text, /关系背景/);
  assert.match(text, /项目背景/);
  const plan = budgetPlan(config);
  assert.ok(text.length <= plan.total * 1.2, `注入块 ${text.length} 字应受预算 ${plan.total} 控制`);
});

test('注入块：关掉 relationMemory/projectInject 后对应段落消失', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const config = testConfig({ relationMemory: false, projectInject: false });
  const text = renderContextBlock({ store, config, sessionId: 's-1', query: 'SQLite' });
  assert.ok(!/关系背景/.test(text));
  assert.ok(!/项目背景/.test(text));
});

test('给用户看的渲染：记忆列表/项目快照/复盘/状态都有稳定输出', (t) => {
  const { store } = makeTempStore(t);
  const project = seed(store);
  const memoryText = renderMemoryList(store.listMemories({ limit: 5 }));
  assert.match(memoryText, /#\d+/);
  assert.match(memoryText, /偏好|项目|关系/);

  const snapshotText = renderProjectSnapshot(store.projectSnapshot(project.id));
  assert.match(snapshotText, /dsh-soul/);
  assert.match(snapshotText, /SQLite/);

  const reviewText = renderReview(store, { turns: 5 });
  assert.ok(reviewText.length > 0);

  const statusText = renderStatus({ store, config: testConfig(), paths: { dbPath: 'C:/tmp/soul.db', dataDir: 'C:/tmp', logFile: '', skill: '' }, personaInfo: { sources: [], missing: [] }, version: '0.1.0' });
  assert.match(statusText, /0\.1\.0/);
});

test('默认注入预算 2000 字：关系/项目/记忆分配 + 上下限 clamp', () => {
  const plan = budgetPlan({});
  assert.equal(plan.total, 2000);
  assert.equal(plan.relation, 300);
  assert.equal(plan.project, 800);
  assert.equal(plan.memories, 720);

  const tiny = budgetPlan({ injectBudget: 100 });
  assert.equal(tiny.total, 300, '预算下限保留 300，避免完全关掉记忆');
  assert.ok(tiny.memories >= 160);

  const big = budgetPlan({ injectBudget: 99_999 });
  assert.equal(big.total, 8000, '预算上限 8000，防止单轮上下文失控');
});


test('注入：讨论类不再附回复方式提示，空库闲聊仍返回空', (t) => {
  const { store } = makeTempStore(t);
  const text = renderContextBlock({
    store,
    config: testConfig(),
    sessionId: 's-hint',
    query: '你觉得我们该不该把记忆库换成 SQLite？',
  });
  assert.ok(!/本轮回复方式|先给结论/.test(text), '工作与常态合并后不该再发格式指令');

  const casual = renderContextBlock({ store, config: testConfig(), sessionId: 's-hint', query: '在吗' });
  assert.equal(casual, '', '轻闲聊不注入任何东西');
});

test('注入：做事场景不再标场景，称呼/尺度/梗一视同仁', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  store.setRelation({ tone: '允许更亲密/暧昧一些', boundaries: '别叫我宝贝', sharedTerms: '噢耶耶' });
  const text = renderContextBlock({
    store,
    config: testConfig(),
    sessionId: 's-1',
    query: '帮我把 dsh-soul 的 SQLite 迁移改一下',
  });
  assert.ok(!/当前是做事\/讨论场景/.test(text), '不该再标场景');
  assert.match(text, /允许更亲密\/暧昧一些/, '尺度不再因为是在干活就藏起来');
  assert.match(text, /别叫我宝贝/, '边界照带');
  assert.match(text, /噢耶耶/, '梗照带');
});

test('注入：暧昧/闲聊场景保留尺度，不再加「不主动升级」的压制', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  store.setRelation({ tone: '允许更亲密/暧昧一些' });
  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '今天有点想你。' });
  assert.match(text, /当前表达尺度：允许更亲密/);
  assert.ok(!/不主动升级/.test(text), '尺度说明不再附带压制');
});

test('注入：回忆类问题给关系细节，普通做事不给', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '你记得我们上次聊到哪了吗？' });
  assert.match(text, /关系细节/);
});

test('注入：判断素材只给「猜错的/久悬未验」的，且明确不是事实', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  const id = store.recordJudgment({ sessionId: 's-1', guess: '他想听方案', now: now - 3_600_000 });
  store.resolveJudgment(id, { outcome: 'wrong', note: '他其实想被接住', now: now - 3_000_000 });

  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '这个方案你觉得怎么样' });
  assert.match(text, /我自己的判断记录/);
  assert.match(text, /他其实想被接住/);
  assert.match(text, /不是事实/);

  const off = renderContextBlock({
    store,
    config: testConfig({ judgmentInject: false }),
    sessionId: 's-1',
    query: '这个方案你觉得怎么样',
  });
  assert.ok(!/我自己的判断记录/.test(off), '关掉 judgmentInject 后不应注入判断素材');

  // 轻闲聊且无实质内容时不塞判断素材（没有在对话/做事，塞了像念日记）。
  const casual = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '嗯嗯' });
  assert.ok(!/我自己的判断记录/.test(casual));
});

test('注入：记忆行带时效，让模型自己判断这条还成不成立', (t) => {
  const { store } = makeTempStore(t);
  const old = Date.now() - 3 * 86_400_000;
  store.rememberMemory({ type: 'preference', content: '用户怕冷，空调别开太低', createdAt: old, updatedAt: old });
  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '空调别开太低，对吧？' });
  assert.match(text, /天前记的/);
});
