/** conversation-policy：对话类型判断、项目相关性门控、闲聊少注入的行为验证。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore, testConfig } from './helpers.js';
import { buildStyleHint, classifyTurn, hasSubstantiveQuery, projectRelevance, containmentScore, normalize } from '../lib/core/conversation-policy.js';
import { renderContextBlock } from '../lib/memory/render.js';

test('意图：问候/拒绝工作/情绪/工作/测试/回忆分别归类', () => {
  assert.equal(classifyTurn('在吗？').kind, 'casual');
  assert.equal(classifyTurn('今天不想聊工作，就想随便说两句。').kind, 'casual');
  assert.equal(classifyTurn('今天不想聊工作，就想随便说两句。').refuseWork, true);
  assert.equal(classifyTurn('今天被领导说了，有点烦。').kind, 'emotional');
  assert.equal(classifyTurn('帮我把 README 里测试数量改成 64。').kind, 'work');
  assert.equal(classifyTurn('你是不是特别想证明自己有性格？').kind, 'test');
  assert.equal(classifyTurn('你记得我们上次聊到哪了吗？').kind, 'memory-ask');
  assert.equal(classifyTurn('今天天气不错，晒了会儿太阳。').kind, 'casual');
  assert.equal(classifyTurn('在吗？').light, true);
  assert.equal(classifyTurn('帮我把 README 改一下').light, false);
});

test('实质内容判断：短问候不算，带信息量的算', () => {
  assert.equal(hasSubstantiveQuery('在吗'), false);
  assert.equal(hasSubstantiveQuery('晚安'), false);
  assert.equal(hasSubstantiveQuery('今天天气不错，晒了会儿太阳。'), true);
  assert.equal(hasSubstantiveQuery('SQLite 迁移怎么弄'), true);
});

test('项目相关性：active 状态本身不算相关；提到项目名/工作请求才算', () => {
  const snapshot = {
    project: { name: 'dsh-soul', goal: '交付长期伙伴插件', stage: '阶段二', status: 'active' },
    byKind: { todo: [{ content: '完成管理命令与自动测试' }], blocker: [], next: [] },
  };
  const casual = projectRelevance('在吗？', snapshot, {});
  assert.equal(casual.relevant, false);
  const unrelated = projectRelevance('今天中午吃什么', snapshot, {});
  assert.equal(unrelated.relevant, false);
  const byName = projectRelevance('dsh-soul 现在到哪一步了', snapshot, {});
  assert.equal(byName.relevant, true);
  const work = projectRelevance('帮我看看这个项目的进度', snapshot, {});
  assert.equal(work.relevant, true);
  const refuse = projectRelevance('今天不想聊工作', snapshot, {});
  assert.equal(refuse.relevant, false);
});

test('相关性计算：短句对较长语料用包含度', () => {
  assert.ok(containmentScore('自动测试做到哪了', '完成管理命令与自动测试') > 0.2);
  assert.equal(containmentScore('在吗', '完成管理命令与自动测试'), 0);
  assert.equal(normalize(' Hello，世界！ '), 'hello世界');
});

function seedContext(store) {
  const project = store.upsertProject({ name: 'dsh-soul', goal: '交付长期伙伴插件', stage: '阶段二' });
  store.addProjectItem(project.id, 'decision', '记忆用 SQLite 存，不引入向量库');
  store.addProjectItem(project.id, 'todo', '完成管理命令与自动测试');
  store.rememberMemory({ type: 'preference', content: '用户喜欢先看结论，再听分析过程' });
  store.rememberMemory({ type: 'episodic', content: '决定用 SQLite 存长期记忆，不引入向量库' });
  store.rememberMemory({ type: 'relationship', content: '用户叫我鱼，我叫用户主人' });
  store.setRelation({ userAlias: '主人', agentAlias: '鱼', sharedTerms: '噢耶耶' });
  store.setSessionState('s-1', { activeProjectId: project.id, lastUserText: '在吗？', openQuestion: '旧版本记忆要不要保留' });
  return project;
}

test('注入取舍：闲聊不塞项目档案/旧记忆/关系细节', (t) => {
  const { store } = makeTempStore(t);
  seedContext(store);
  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '在吗？' });
  // 关系称呼可以保留（用于语气），但项目档案、旧记忆、未解决问题、关系细节都不该被硬塞。
  assert.ok(!/项目背景/.test(text), '闲聊不应注入项目档案');
  assert.ok(!/可能相关的旧信息/.test(text), '闲聊不应注入旧记忆');
  assert.ok(!/关系细节/.test(text), '闲聊不应注入关系细节');
  assert.ok(!/之前留下/.test(text), '闲聊不应注入未解决问题');
});

test('注入取舍：工作请求且与项目相关时才给项目档案', (t) => {
  const { store } = makeTempStore(t);
  seedContext(store);
  const text = renderContextBlock({
    store,
    config: testConfig(),
    sessionId: 's-1',
    query: '帮我把 dsh-soul 的 README 改一下',
  });
  assert.match(text, /项目背景/);
  assert.match(text, /关系背景/);
});

test('注入取舍：projectInjectRelevance=false 时回到每轮注入', (t) => {
  const { store } = makeTempStore(t);
  seedContext(store);
  const text = renderContextBlock({
    store,
    config: testConfig({ projectInjectRelevance: false }),
    sessionId: 's-1',
    query: '在吗？',
  });
  assert.match(text, /项目背景/);
});

test('注入取舍：带实质问题的讨论会取相关旧记忆', (t) => {
  const { store } = makeTempStore(t);
  seedContext(store);
  const text = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: 'SQLite 迁移这种老记忆应该怎么处理' });
  assert.match(text, /可能相关的旧信息/);
});

test('注入取舍：未解决问题只在工作/讨论或相关时才提', (t) => {
  const { store } = makeTempStore(t);
  seedContext(store);
  const casual = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '在吗？' });
  assert.ok(!/旧版本记忆要不要保留/.test(casual));
  const work = renderContextBlock({ store, config: testConfig(), sessionId: 's-1', query: '继续把项目做完' });
  assert.match(work, /之前留下、还没解决的事/);
});


test('回复方式提示：v0.8.0 起不再按意图分档（工作与常态已合并）', () => {
  for (const text of ['你觉得我们该不该把记忆库换成 SQLite？', '在吗', '你说话怎么又像说明书了', '今天被领导说了一顿，有点烦']) {
    const hint = buildStyleHint(classifyTurn(text, {}), text, {});
    assert.equal(hint, '', `不该再给格式指令：${text}`);
  }
});
