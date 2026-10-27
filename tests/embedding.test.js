/** 语义检索：向量存取、余弦阈值、混合候选（不依赖真实模型，用假向量）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import { blobToVector, cosine, vectorToBlob } from '../lib/memory/embed.js';
import { selectMemories } from '../lib/memory/retrieval.js';

test('向量：Float32Array 存进库再取出来，数值不变', (t) => {
  const { store } = makeTempStore(t);
  const vector = Float32Array.from([0.1, -0.2, 0.3, 0.4]);
  assert.equal(store.setEmbedding('memory', 42, vector), true);
  const blob = store.getEmbedding('memory', 42);
  assert.ok(blob, '应能取回 BLOB');
  const back = blobToVector(blob);
  assert.deepEqual(Array.from(back), Array.from(vector));
  assert.equal(store.embeddingCount('memory'), 1);
});

test('向量：同一 ref 重复写入是覆盖，不是增生', (t) => {
  const { store } = makeTempStore(t);
  store.setEmbedding('memory', 1, Float32Array.from([1, 0]));
  store.setEmbedding('memory', 1, Float32Array.from([0, 1]));
  assert.equal(store.embeddingCount('memory'), 1);
  assert.deepEqual(Array.from(blobToVector(store.getEmbedding('memory', 1))), [0, 1]);
});

test('余弦：同向为 1、反向为 -1、正交为 0', () => {
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([1, 0])).toFixed(3), '1.000');
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([-1, 0])).toFixed(3), '-1.000');
  assert.equal(cosine(Float32Array.from([1, 0]), Float32Array.from([0, 1])).toFixed(3), '0.000');
});

test('语义召回：字面搜不到的记忆，靠向量能进候选', (t) => {
  const { store } = makeTempStore(t);
  const cold = store.rememberMemory({ type: 'preference', content: '用户怕冷，空调别开太低' });
  const theme = store.rememberMemory({ type: 'preference', content: '用户喜欢深色主题' });
  store.setEmbedding('memory', cold.id, Float32Array.from([1, 0]));
  store.setEmbedding('memory', theme.id, Float32Array.from([0, 1]));

  // 这句话字面上没有任何一个词出现在记忆里（「怕冷/空调」都不在），
  // 但向量方向上接近「怕冷」。
  const result = selectMemories(store, {
    query: '屋里温度调到二十六度吧',
    queryVector: Float32Array.from([0.98, 0.2]),
    limit: 5,
    budgetChars: 400,
  });
  assert.ok(result.memories.some((memory) => memory.id === cold.id), '应召回怕冷那条');
});

test('语义召回：低于阈值的不进候选（防止反义/无关句硬塞）', (t) => {
  const { store } = makeTempStore(t);
  const cold = store.rememberMemory({ type: 'preference', content: '用户怕冷，空调别开太低' });
  store.setEmbedding('memory', cold.id, Float32Array.from([1, 0]));

  const result = selectMemories(store, {
    query: '随便聊聊',
    queryVector: Float32Array.from([0.2, 0.98]), // 余弦约 0.2，低于 0.5
    limit: 5,
    budgetChars: 400,
  });
  assert.equal(result.memories.some((memory) => memory.id === cold.id), false);
});

test('语义召回：没有 queryVector 时行为和以前一样（纯字面）', (t) => {
  const { store } = makeTempStore(t);
  const cold = store.rememberMemory({ type: 'preference', content: '用户怕冷，空调别开太低' });
  store.setEmbedding('memory', cold.id, Float32Array.from([1, 0]));
  const result = selectMemories(store, { query: '空调', limit: 5, budgetChars: 400 });
  assert.ok(result.memories.some((memory) => memory.id === cold.id), '字面仍能命中');
});
