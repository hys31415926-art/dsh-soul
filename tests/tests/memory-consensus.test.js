/**
 * tests/memory-consensus.test.js — 第二阶段记忆质量：长期偏好识别与多轮共识抽取。
 *
 * 覆盖：
 * - detectConsensus 只认明确的拍板标记，不把普通应答当共识；
 * - 长期习惯/长期目标先进入候选区（不直接当事实）；
 * - 只有「会话里确实讨论过几轮 + 有讨论上下文（活跃项目/未解决问题）」时，
 *   一句「就这么定」才写成候选记忆 + 项目决定条目；
 * - 回合不足、没有讨论上下文、或配置关闭时都不记录。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { installHooks } from '../lib/hooks.js';
import { detectConsensus, extractCandidates } from '../lib/memory/extract.js';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';

const logger = { debug() {}, info() {}, warn() {}, error() {} };

/** 模拟一次完整回合：用户消息 → turn/start → 助手消息 → turn/end。 */
function runTurn(ctx, session, turn, userText, assistantText) {
  ctx.emit('session/event', session, userMessageEvent(userText));
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn } });
  ctx.emit('session/event', session, {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: assistantText }] } },
  });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn, reason: { kind: 'completed' } } });
}

test('detectConsensus：只认明确的拍板，不认普通应答', () => {
  assert.ok(detectConsensus('好，那就这么定，先做注入门控'));
  assert.ok(detectConsensus('行，就按这个来'));
  assert.ok(detectConsensus('我们达成共识了'));
  assert.equal(detectConsensus('好，我知道了'), '');
  assert.equal(detectConsensus('那就先试试吧'), '');
  assert.equal(detectConsensus(''), '');
  assert.equal(detectConsensus('就这么定'.repeat(30)), '', '超长句不当作共识');
});

test('长期习惯与长期目标先进入候选区，而不是直接成为事实', () => {
  const habits = extractCandidates('我一般晚上十点以后不看代码');
  const habit = habits.find((candidate) => candidate.tags?.includes('habit'));
  assert.ok(habit, '应识别出习惯');
  assert.equal(habit.type, 'preference');

  const goals = extractCandidates('我计划下个月把插件文档补齐');
  const goal = goals.find((candidate) => candidate.tags?.includes('long-term-goal'));
  assert.ok(goal, '应识别出长期计划');
  assert.equal(goal.type, 'profile');
});

test('多轮讨论后拍板：写候选记忆 + 项目决定条目', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-consensus');

  // 第 1、2 轮：建立项目并讨论方向
  runTurn(ctx, session, 1, '我们来推进 dsh-soul 这个项目', '好，先梳理现状再定方向。');
  runTurn(ctx, session, 2, '现在先修注入还是先修记忆，你判断', '我建议先做注入门控，代价小、收益直接。');
  const project = store.listProjects({ limit: 5 })[0];
  assert.ok(project, '应自动建出项目');
  store.setSessionState('s-consensus', { openQuestion: '先做注入门控这个方向' });

  // 第 3 轮：用户拍板
  ctx.emit('session/event', session, userMessageEvent('好，那就这么定，先做注入门控'));

  const candidates = store.listCandidates(20);
  const consensus = candidates.find((memory) => memory.source === 'multi-turn-consensus');
  assert.ok(consensus, '应写入一条多轮共识候选记忆');
  assert.match(consensus.content, /讨论后定下/);
  assert.equal(consensus.status, 'candidate');

  const snapshot = store.projectSnapshot(project.id);
  const decisions = snapshot?.byKind?.decision ?? [];
  assert.ok(decisions.some((item) => /注入门控/.test(item.content)), '项目里应出现决定条目');
  assert.equal(store.getSessionState('s-consensus')?.openQuestion ?? '', '', '拍板后应清掉未解决问题');
});

test('回合不足时不记录：一句「就这么定」可能只是随口答应', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-short');

  runTurn(ctx, session, 1, '我们来推进 dsh-soul 这个项目', '好。');
  ctx.emit('session/event', session, userMessageEvent('那就这么定'));

  assert.equal(store.listCandidates(20).filter((memory) => memory.source === 'multi-turn-consensus').length, 0);
});

test('没有讨论上下文（无项目、无未解决问题）时不记录', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), logger);
  const session = makeSession('s-nocontext');

  runTurn(ctx, session, 1, '今天随便聊聊', '好。');
  runTurn(ctx, session, 2, '刚才那个问题你怎么看', '还行。');
  ctx.emit('session/event', session, userMessageEvent('那就这么定，先这样'));

  assert.equal(store.listCandidates(20).filter((memory) => memory.source === 'multi-turn-consensus').length, 0);
});

test('consensusExtraction 关闭时完全不记录', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig({ consensusExtraction: false }), logger);
  const session = makeSession('s-off');

  runTurn(ctx, session, 1, '我们来推进 dsh-soul 这个项目', '好。');
  runTurn(ctx, session, 2, '先修注入还是先修记忆', '先注入。');
  store.setSessionState('s-off', { openQuestion: '先做注入门控' });
  ctx.emit('session/event', session, userMessageEvent('好，那就这么定'));

  assert.equal(store.listCandidates(20).filter((memory) => memory.source === 'multi-turn-consensus').length, 0);
});
