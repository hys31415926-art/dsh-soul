/** hooks 层：会话事件捕获、注入块、子代理/转述过滤、回合摘要、纠正取代。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';
import { installHooks } from '../lib/hooks.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

test('user/message：显式记忆落库；重复消息不重复增生', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('记住：我每周三晚上要做项目复盘'));
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('记住：我每周三晚上要做项目复盘'));

  const memories = store.listMemories();
  assert.equal(memories.length, 1);
  assert.match(memories[0].content, /每周三/);
  assert.ok(memories[0].hits >= 2);
});

test('不记录子代理会话与团队转述消息', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  ctx.emit('session/event', makeSession('sub-1', { origin: 'subagent' }), userMessageEvent('记住：子代理里的内容不算用户偏好'));
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('记住：转述内容也不算', { kind: 'user', form: 'relay' }));
  assert.equal(store.listMemories().length, 0);
});

test('纠正：新版本取代旧版本，检索优先返回新版本', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('记住：我喜欢用 Python 写工具'));
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('不对，我喜欢用 TypeScript 写工具'));

  const active = store.listMemories({ status: 'active' });
  assert.ok(active.some((memory) => /TypeScript/.test(memory.content)), '新版本应为 active');
  assert.ok(!active.some((memory) => /Python/.test(memory.content)), '旧版本应被取代');
  const all = store.listMemories({ status: 'superseded' });
  assert.ok(all.some((memory) => /Python/.test(memory.content)), '旧版本保留可追溯');
});

test('项目信号自动挂到活跃项目；projectAutoUpdate=false 时不写', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('我们来推进 dsh-soul 这个项目'));
  const project = store.matchProject('dsh-soul');
  assert.ok(project, '应识别并创建当前项目');
  store.setSessionState('s-1', { activeProjectId: project.id });

  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('决定用 SQLite 存长期记忆'));
  const items = store.listProjectItems(project.id, { kind: 'decision' });
  assert.ok(items.some((item) => /SQLite/.test(item.content)), '决策应记入项目档案');

  const ctxOff = makeCtx();
  installHooks(ctxOff, store, testConfig({ projectAutoUpdate: false }), logger);
  ctxOff.emit('session/event', makeSession('s-1'), userMessageEvent('决定改用 JSONL 存长期记忆'));
  const after = store.listProjectItems(project.id, { kind: 'decision' });
  assert.ok(!after.some((item) => /JSONL/.test(item.content)));
});

test('关系设定：称呼/尺度/梗写入关系状态', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('以后叫我主人，叫你鱼；可以再亲密一点；咱们的暗号是噢耶耶'));
  const relation = store.getRelation();
  assert.equal(relation.userAlias, '主人');
  assert.equal(relation.agentAlias, '鱼');
  assert.match(relation.sharedTerms, /噢耶耶/);
  assert.match(relation.tone, /亲密/);
});

test('注入：assemble 时追加上下文块（interpolate=false），且调用 next()', async (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  const session = makeSession('s-1');
  ctx.emit('session/event', session, userMessageEvent('记住：用户喜欢先看结论'));
  const handlers = ctx.listeners.get('system-prompt/assemble') ?? [];
  assert.equal(handlers.length, 1);

  const assembly = { contexts: [] };
  let nextCalled = 0;
  const result = await handlers[0](assembly, { agent: { session } }, () => { nextCalled += 1; return 'next-result'; });
  assert.equal(nextCalled, 1);
  assert.equal(result, 'next-result');
  assert.equal(assembly.contexts.length, 1);
  assert.equal(assembly.contexts[0].name, 'dsh-soul:context');
  assert.equal(assembly.contexts[0].interpolate, false);
  assert.match(assembly.contexts[0].text, /我记着的/);
});

test('注入：子代理会话不注入', async (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('sub-1', { origin: 'subagent' });
  const assembly = { contexts: [] };
  await ctx.listeners.get('system-prompt/assemble')[0](assembly, { agent: { session } }, () => undefined);
  assert.equal(assembly.contexts.length, 0);
});

test('回合：turn/start → assistant/tool → turn/end 记录回合摘要', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-1');

  ctx.emit('session/event', session, userMessageEvent('帮我修一下插件'));
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'tool/call', data: { callId: 'c1', name: 'bash', arguments: '{}' } });
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '修好了，测试通过' }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'completed' } } });

  const turns = store.recentTurns(5, 's-1');
  assert.equal(turns.length, 1);
  assert.equal(turns[0].turn, 1);
  assert.equal(turns[0].reason, 'completed');
  assert.equal(turns[0].toolCalls, 1);
  assert.match(turns[0].assistantText, /测试通过/);
});

test('判断结果：用户纠正/确认时自动结算本会话最近一条悬着的判断', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);

  const wrongId = store.recordJudgment({ sessionId: 's-1', guess: '他想要方案' });
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('不是，我的意思是先别做，聊两句'));
  assert.equal(store.getJudgment(wrongId).outcome, 'wrong');
  assert.match(store.getJudgment(wrongId).note, /纠正/);

  const rightId = store.recordJudgment({ sessionId: 's-1', guess: '他想先看结论' });
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('对，就这样'));
  assert.equal(store.getJudgment(rightId).outcome, 'right');

  // 超过 2 小时的旧判断不被误结算（避免上一轮的话把很久以前的事标错）。
  const staleId = store.recordJudgment({ sessionId: 's-1', guess: '他今天会问部署' });
  store.db.prepare('UPDATE judgments SET updated_at = ? WHERE id = ?').run(Date.now() - 3 * 3_600_000, staleId);
  ctx.emit('session/event', makeSession('s-1'), userMessageEvent('不对，重来'));
  assert.equal(store.getJudgment(staleId).outcome, 'open');
});

test('异常不抛出：store 已关闭时钩子只吞错不崩宿主', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  const dispose = installHooks(ctx, store, testConfig(), logger);
  store.close();
  assert.doesNotThrow(() => {
    ctx.emit('session/event', makeSession('s-1'), userMessageEvent('记住：关闭后的事件'));
  });
  assert.doesNotThrow(() => dispose());
});
