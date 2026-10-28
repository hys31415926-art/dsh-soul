/** v3 学习闭环：助手自采纳/自认错、负评扣分、LLM JSON 容错、反馈工具。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';
import { installHooks } from '../lib/hooks.js';
import { extractJsonObject } from '../lib/memory/llm-client.js';
import { listStyleExamples, selectStyleAnchors } from '../lib/memory/style-examples.js';
import { registerTools } from '../lib/tools.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

function assistantEvent(text) {
  return {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text }] } },
  };
}

test('语体闭环：助手自采纳写正向样本与 active 规则；连续负评扣分到停用、规则第二回合升级', (t) => {
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
  assert.equal(positives.length, 1, '自采纳应写一条正向样本');
  assert.equal(positives[0].score, 0.8);
  assert.match(positives[0].text, /这股劲/);
  assert.ok(store.listStyleRules({ status: 'active' }).some((rule) => rule.category === 'adopted_phrase'));
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 2, reason: { kind: 'completed' } } });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 3 } });
  ctx.emit('session/event', session, userMessageEvent('刚才那句太垮了，拉了'));
  ctx.emit('session/event', session, assistantEvent('行，拉了就是拉了，不狡辩。'));
  const disabled = listStyleExamples(store, { kind: 'disabled' });
  assert.equal(disabled.length, 1, '连续两次负评应把正向样本停用');
  assert.equal(disabled[0].score, -1);
  assert.equal(selectStyleAnchors(store, { limit: 2 }).length, 0, '停用样本不能再进锚点');
  const afterRound2 = store.listStyleRules({ category: 'flat_tone' });
  assert.equal(afterRound2.length, 1);
  assert.equal(afterRound2[0].status, 'candidate', '同回合的批评+自认错不能重复计证据');
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 3, reason: { kind: 'completed' } } });

  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 4 } });
  ctx.emit('session/event', session, userMessageEvent('刚才那句又端着，太油了'));
  ctx.emit('session/event', session, assistantEvent('知道了，说人话。'));
  const active = store.listStyleRules({ status: 'active', category: 'flat_tone' });
  assert.equal(active.length, 1);
  assert.ok(active[0].evidenceCount >= 2);
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'completed' } } });
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
