/** v3 学习闭环：助手自采纳/自认错、负评扣分、LLM JSON 容错、反馈工具。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';
import { installHooks } from '../lib/hooks.js';
import { extractJsonObject } from '../lib/memory/llm-client.js';
import { listStyleExamples, markStyleAnchorsUsed, selectStyleAnchors, addStyleExample } from '../lib/memory/style-examples.js';
import { replayStyleFromTurns } from '../lib/memory/style-replay.js';
import { registerTools } from '../lib/tools.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function assistantEvent(text) {
  return {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

test('语体闭环：助手自采纳只留参考措辞与候选规则；负评只扣可归责正样本、第二回合才升级', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-loop');

  store.recordTurn({
    sessionId: 's-loop', turn: 1, userText: '先聊两句', assistantText: '好，我在。',
    toolCalls: 0, reason: 'completed',
  });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } });
  ctx.emit('session/event', session, userMessageEvent('这股劲搁别人身上，三天就散。'));
  ctx.emit('session/event', session, assistantEvent('这说法我要了，往后照着来。'));
  const positives = listStyleExamples(store, { kind: 'positive' });
  const borrowed = listStyleExamples(store, { kind: 'borrowed' });
  assert.equal(positives.length, 0, '助手自采纳不能产生正向行为证据');
  assert.equal(borrowed.length, 1, '用户原话只作为 borrowed 参考留档');
  assert.equal(borrowed[0].score, 0.5);
  assert.match(borrowed[0].text, /这股劲/);
  const adopted = store.listStyleRules({ category: 'adopted_phrase' });
  assert.equal(adopted.length, 1);
  assert.equal(adopted[0].status, 'candidate', '自采纳只能提候选，等用户确认');
  assert.equal(adopted[0].evidenceCount, 1);
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } });
  ctx.emit('session/event', session, userMessageEvent('刚才那句太垮了，拉了'));
  ctx.emit('session/event', session, assistantEvent('行，拉了就是拉了，不狡辩。'));
  const disabled = listStyleExamples(store, { kind: 'disabled' });
  assert.equal(disabled.length, 0, '没有可归责正样本时，负评不能硬扣分停用');
  assert.equal(selectStyleAnchors(store, { limit: 2 }).length, 0, 'borrowed/negative 都不能进锚点');
  const afterRound2 = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(afterRound2.length, 1);
  assert.equal(afterRound2[0].status, 'candidate', '同回合的批评+自认错不能重复计证据');
  assert.equal(afterRound2[0].evidenceCount, 1);
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 4 } });
  ctx.emit('session/event', session, userMessageEvent('刚才那句又端着，太油了'));
  ctx.emit('session/event', session, assistantEvent('知道了，说人话。'));
  const active = store.listStyleRules({ status: 'active', category: 'flat_tone' });
  assert.equal(active.length, 1);
  assert.ok(active[0].evidenceCount >= 2);
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
});

test('自认错先落候选，不吞掉同一回合随后到达的用户批评', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-self-then-user');

  store.recordTurn({
    sessionId: 's-self-then-user', turn: 1, userText: '先聊两句', assistantText: '好，我在。',
    toolCalls: 0, reason: 'completed',
  });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 2 } });
  ctx.emit('session/event', session, userMessageEvent('随便聊聊'));
  ctx.emit('session/event', session, assistantEvent('知道了，不狡辩。'));
  const first = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(first.length, 1);
  assert.equal(first[0].status, 'candidate');
  assert.equal(first[0].evidenceCount, 1);
  assert.equal(first[0].lastSourceTurnId, 0, '助手自评不能占用回合证据位');
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } });
  ctx.emit('session/event', session, userMessageEvent('刚才那句太油了'));
  ctx.emit('session/event', session, assistantEvent('行，我收着点。'));
  const after = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(after.length, 1);
  assert.equal(after[0].status, 'active', '用户对同一回合的批评应该能补上第二份证据');
  assert.ok(after[0].evidenceCount >= 2);
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });
});

test('历史回放：补记漏掉的批评与规则，同一回合只扣一次、重复回放不重复计证据', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  const target = '这个说法我接住了，往后就这么办。';
  const seeded = addStyleExample(store, { text: target, scene: 'chat', score: 0.8, source: 'praise' });
  markStyleAnchorsUsed(store, [seeded.id]);
  store.recordTurn({
    sessionId: 's-replay', turn: 1, userText: '先聊两句', assistantText: target,
    toolCalls: 0, reason: 'completed', startedAt: now - 120_000, endedAt: now - 60_000,
  });
  store.recordTurn({
    sessionId: 's-replay', turn: 2, userText: '刚才那句太垮了，拉了', assistantText: '行，拉了就是拉了，不狡辩。',
    toolCalls: 0, reason: 'completed', startedAt: now - 50_000, endedAt: now - 10_000,
  });
  const first = replayStyleFromTurns(store, { sessionId: 's-replay', limit: 10, logger });
  assert.equal(first.corrections, 1);
  assert.ok(first.rules >= 1);
  assert.equal(first.penalties, 1);
  const positive = listStyleExamples(store, { kind: 'positive' }).find((row) => row.id === seeded.id);
  assert.equal(positive.score, 0.45, '回放应把上一轮被嫌的正样本扣到 0.45');
  const rulesAfterFirst = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(rulesAfterFirst.length, 1);
  assert.equal(rulesAfterFirst[0].status, 'candidate');
  assert.equal(rulesAfterFirst[0].evidenceCount, 1);

  const second = replayStyleFromTurns(store, { sessionId: 's-replay', limit: 10, logger });
  assert.equal(second.corrections, 1);
  assert.equal(second.penalties, 0, '同一个 turnId 重复回放不能重复扣分');
  const again = listStyleExamples(store, { kind: 'positive' }).find((row) => row.id === seeded.id);
  assert.equal(again.score, 0.45);
  const rulesAgain = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(rulesAgain[0].evidenceCount, 1, '重复回放不能重复计证据');
});

test('LLM JSON：think 块、markdown 围栏与数组都能解析', () => {
  const withThink = '<think>先想 {"bad": 1}</think>\n下面是要的：\n\n```json\n{"memories":[{"content":"ok"}]}\n```';
  const parsed = extractJsonObject(withThink);
  assert.deepEqual(parsed, { memories: [{ content: 'ok' }] });
  const array = extractJsonObject('```json\n[{"a":1}]\n```');
  assert.deepEqual(array, [{ a: 1 }]);
});

test('反馈工具：good / bad / rule 三种动作都真实落库', async (t) => {
  const { store } = makeTempStore(t);
  const tools = [];
  const ctx = makeCtx({ tools: { register(tool) { tools.push(tool); return () => {}; } } });
  const paths = { dbPath: 'C:/tmp/soul.db', dataDir: 'C:/tmp', logFile: '', skill: '' };
  const dispose = registerTools(ctx, store, testConfig(), paths, { sources: [], missing: [] }, '0.1.0');
  t.after(() => dispose());
  const tool = tools.find((item) => item.name === 'soul_style_feedback');
  assert.ok(tool);
  const exec = (args) => tool.execute(args, { agent: { session: { id: 's-style' } }, signal: { aborted: false } });
  const good = await exec({ action: 'good', text: '这句话有内味，往后照着来。', scene: 'chat' });
  assert.match(good.text, /好句已入库/);
  const bad = await exec({ action: 'bad', text: '这句话太像客服了，冷冰冰。', scene: 'chat' });
  assert.match(bad.text, /坏句已入库/);
  const rule = await exec({ action: 'rule', rule: '接话要像人，不背客服模板。', scene: 'chat', category: 'mechanical_tone' });
  assert.match(rule.text, /active/);
  assert.equal(store.styleRuleStats().active >= 2, true);
});
