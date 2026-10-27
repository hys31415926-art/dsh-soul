/** 注入块稳定性：同一批数据渲染两次必须完全相同，否则宿主每轮都会追加一份新快照。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import { renderContextBlock } from '../lib/memory/render.js';

function seed(store) {
  store.rememberMemory({ type: 'preference', content: '主人喜欢先看结论再看分析', source: 'user-explicit', confidence: 0.9 });
  store.setRelationHistory({ turns: 362, firstSeen: Date.now() - 2 * 86_400_000 });
  store.setSessionState?.('s-1', { lastUserText: '在吗' });
  store.recordTurn({ sessionId: 's-1', turn: 1, userText: '在吗', assistantText: '在呀。', endedAt: Date.now() });
}

test('稳定性：连续两轮渲染结果完全相同（不掺轮数/相对时间）', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const config = { recapWindowMinutes: 5 };
  const first = renderContextBlock({ store, config, sessionId: 's-1', query: '在吗' });
  const second = renderContextBlock({ store, config, sessionId: 's-1', query: '在吗' });
  assert.equal(first, second);
  assert.ok(!/聊过 \d+ 轮/.test(first), '注入块不该包含每回合都会变的轮数');
});

test('画像槽：常驻一小段关于主人的长期信息', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const text = renderContextBlock({ store, config: {}, sessionId: 's-1', query: '在吗' });
  assert.match(text, /关于主人/);
  assert.match(text, /先看结论/);
});

test('画像槽：profileInject=false 时不出现', (t) => {
  const { store } = makeTempStore(t);
  seed(store);
  const text = renderContextBlock({ store, config: { profileInject: false }, sessionId: 's-1', query: '在吗' });
  assert.ok(!/关于主人/.test(text));
});
