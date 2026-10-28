/** 语体样本库：存原句、去重加权、按场景挑锚（lib/memory/style-examples.js）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import {
  addStyleExample,
  selectStyleAnchors,
  markStyleAnchorsUsed,
  listStyleExamples,
  penalizeStyleExamples,
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

test('负评归责：同回合只扣一次，第二个独立回合才停用；无匹配不扣分', (t) => {
  const { store } = makeTempStore(t);
  const text = '这个说法我接住了，往后就这么办。';
  const saved = addStyleExample(store, { text, scene: 'chat', score: 0.8, source: 'praise' });
  markStyleAnchorsUsed(store, [saved.id]);
  const first = penalizeStyleExamples(store, {
    text, scene: 'chat', turnId: 31, injectedSince: Date.now() - 60_000,
  });
  assert.equal(first.length, 1);
  assert.equal(first[0].score, 0.45);
  assert.equal(first[0].attribution, 'text');
  const duplicate = penalizeStyleExamples(store, {
    text, scene: 'chat', turnId: 31, injectedSince: Date.now() - 60_000,
  });
  assert.equal(duplicate.length, 0, '同一回合 user/assistant 两次负评只能扣一次');
  const afterFirst = listStyleExamples(store, { kind: 'positive' }).find((row) => row.id === saved.id);
  assert.equal(afterFirst.score, 0.45);
  const second = penalizeStyleExamples(store, {
    text, scene: 'chat', turnId: 32, injectedSince: Date.now() - 60_000,
  });
  assert.equal(second.length, 1);
  assert.equal(second[0].disabled, true);
  assert.equal(listStyleExamples(store, { kind: 'disabled' }).length, 1);

  const untouched = addStyleExample(store, { text: '我先看看，不急着下结论。', scene: 'chat', score: 0.8 });
  const noMatch = penalizeStyleExamples(store, {
    text: '完全不相干的一句话，长度也够。', scene: 'work', turnId: 40, injectedSince: 0,
  });
  assert.equal(noMatch.length, 0, '相似度不足且未注入过时，不能随机扣分');
  const still = listStyleExamples(store, { kind: 'positive' }).find((row) => row.id === untouched.id);
  assert.equal(still.score, 0.8);
});

test('负评归责：上一回合真正注入过的样本可被归责', (t) => {
  const { store } = makeTempStore(t);
  const saved = addStyleExample(store, { text: '被打断了也没关系，你慢慢说。', scene: 'chat', score: 0.8 });
  markStyleAnchorsUsed(store, [saved.id]);
  const penalized = penalizeStyleExamples(store, {
    text: '这句有点冷。', scene: 'chat', turnId: 50, injectedSince: Date.now() - 60_000,
  });
  assert.equal(penalized.length, 1);
  assert.equal(penalized[0].attribution, 'injected');
  assert.equal(penalized[0].score, 0.45);
});


test('borrowed 只是参考措辞：不覆盖已有 positive，也不进锚点', (t) => {
  const { store } = makeTempStore(t);
  const text = '这股劲搁别人身上，三天就散。';
  const positive = addStyleExample(store, { text, kind: 'positive', scene: 'chat', score: 0.8, source: 'praise' });
  const borrowed = addStyleExample(store, { text, kind: 'borrowed', scene: 'chat', score: 0.5, source: 'self-adopt' });
  assert.equal(borrowed.id, positive.id);
  const rows = listStyleExamples(store, { kind: 'positive' });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].score, 0.8, '自采纳不能把已确认的 positive 降成 borrowed');
  assert.equal(selectStyleAnchors(store, { scene: 'chat' }).length, 1);
});

test('标记用过 + 太短的句子不入库', (t) => {
  const { store } = makeTempStore(t);
  const saved = addStyleExample(store, { text: '我先看看，不急着下结论。', scene: 'chat' });
  assert.equal(markStyleAnchorsUsed(store, [saved.id]), 1);
  assert.equal(selectStyleAnchors(store, { scene: 'chat' })[0].used, 1);
  assert.equal(addStyleExample(store, { text: '好的' }), null);
});
