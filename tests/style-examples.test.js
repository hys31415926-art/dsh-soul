/** 语体样本库：存原句、去重加权、按场景挑锚（lib/memory/style-examples.js）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import {
  addStyleExample,
  selectStyleAnchors,
  markStyleAnchorsUsed,
  listStyleExamples,
} from '../lib/memory/style-examples.js';

test('同一句重复出现只加权，不增生', (t) => {
  const { store } = makeTempStore(t);
  const first = addStyleExample(store, { text: '这个问题我好像在哪见过，让我翻翻。', scene: 'chat', source: 'praise' });
  assert.equal(first.created, true);
  const second = addStyleExample(store, { text: '这个问题我好像在哪见过，让我翻翻。', scene: 'chat', source: 'praise' });
  assert.equal(second.created, false);
  assert.equal(second.id, first.id);
  assert.ok(second.score > first.score);
  assert.equal(listStyleExamples(store).length, 1);
});

test('挑锚：只挑 positive，同场景优先，negative 不进锚', (t) => {
  const { store } = makeTempStore(t);
  addStyleExample(store, { text: '被打断了也没关系，你慢慢说，我听着。', scene: 'chat', source: 'praise' });
  addStyleExample(store, { text: '这个函数的入参校验我先补上，再跑一遍。', scene: 'work', source: 'praise' });
  addStyleExample(store, { text: '又像客服了，别这样。', kind: 'negative', scene: 'chat', source: 'correction' });
  const chat = selectStyleAnchors(store, { scene: 'chat', limit: 2 });
  assert.ok(chat.length >= 1);
  assert.equal(chat[0].text, '被打断了也没关系，你慢慢说，我听着。');
  assert.ok(chat.every((a) => a.text !== '又像客服了，别这样。'));
  const work = selectStyleAnchors(store, { scene: 'work', limit: 1 });
  assert.equal(work[0].text, '这个函数的入参校验我先补上，再跑一遍。');
});

test('标记用过 + 太短的句子不入库', (t) => {
  const { store } = makeTempStore(t);
  const saved = addStyleExample(store, { text: '我先看看，不急着下结论。', scene: 'chat' });
  assert.equal(markStyleAnchorsUsed(store, [saved.id]), 1);
  assert.equal(selectStyleAnchors(store, { scene: 'chat' })[0].used, 1);
  assert.equal(addStyleExample(store, { text: '好的' }), null);
});
