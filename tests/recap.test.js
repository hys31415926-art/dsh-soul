/** 跨会话接话：久别后把上次最后几轮原话接回来；刚聊完不重复。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import { renderRecapLines } from '../lib/memory/render.js';

function seed(store, now, { sessionId = 's-a', turns = [] } = {}) {
  turns.forEach((turn, index) => {
    const endedAt = now - turn.minutesAgo * 60_000;
    store.recordTurn({
      sessionId,
      turn: index + 1,
      userText: turn.user,
      assistantText: turn.assistant,
      startedAt: endedAt - 60_000,
      endedAt,
    });
  });
}

test('接话：刚聊完（30 分钟内）不注入，避免同一段话被说两遍', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  seed(store, now, { turns: [{ minutesAgo: 3, user: '在吗', assistant: '在呢' }] });
  assert.equal(renderRecapLines(store, {}, now), '');
});

test('接话：隔了 45 分钟，注入上次最后几轮原话（你我交替）', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  seed(store, now, {
    turns: [
      { minutesAgo: 120, user: '先看检索那步', assistant: '好，我先验证模型能不能下' },
      { minutesAgo: 60, user: '下不动就换镜像', assistant: '明白，镜像不通就退回字面匹配' },
      { minutesAgo: 45, user: '就这样，开工', assistant: '开工' },
    ],
  });
  const text = renderRecapLines(store, {}, now);
  assert.ok(text.includes('上次聊天'), '应带「上次聊天」标题');
  assert.ok(text.includes('你：就这样，开工'), '应带用户原话');
  assert.ok(text.includes('我：开工'), '应带我的回复');
  assert.ok(text.indexOf('先看检索那步') < text.indexOf('就这样，开工'), '按时间正序');
  assert.ok(text.includes('（45 分钟前）'), '时间跨度带单位，且不重复「前」');
});

test('接话：没有历史回合时返回空字符串', (t) => {
  const { store } = makeTempStore(t);
  assert.equal(renderRecapLines(store, {}, Date.now()), '');
});

test('接话：recapInject=false 时整段关闭', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  seed(store, now, { turns: [{ minutesAgo: 90, user: '上次说到哪了', assistant: '说到部署' }] });
  assert.equal(renderRecapLines(store, { recapInject: false }, now), '');
});

test('接话：recapTurns 限制只带最近一轮', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  seed(store, now, {
    turns: [
      { minutesAgo: 90, user: '第一轮的话', assistant: '第一轮回复' },
      { minutesAgo: 60, user: '第二轮的话', assistant: '第二轮回复' },
    ],
  });
  const text = renderRecapLines(store, { recapTurns: 1 }, now);
  assert.ok(text.includes('第二轮的话'));
  assert.equal(text.includes('第一轮的话'), false, '只带最近一轮');
});

test('接话：recapWindowMinutes 可调，6 分钟前也算久别', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  seed(store, now, { turns: [{ minutesAgo: 10, user: '十分钟前', assistant: '嗯' }] });
  assert.equal(renderRecapLines(store, {}, now), '', '默认 30 分钟窗口内不注入');
  assert.ok(renderRecapLines(store, { recapWindowMinutes: 5 }, now).includes('十分钟前'));
});
