/**
 * tests/retrieval-v15.test.js — v1.5：检索路由、单值改口、检索缓存、睡眠维护。
 *
 * 这些行为都不是「多写点功能」，而是修三类真实毛病：
 *   · 把旧话题拼进检索词 → 答非所问；
 *   · 改了住址，旧地址还当成现在 → 说错话；
 *   · 一堆快沉默掉的琐碎记忆各自占位 → 注入块里全是垃圾。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore, testConfig } from './helpers.js';
import {
  clearRetrievalCache,
  planRetrieval,
  selectMemories,
  usageOf,
} from '../lib/memory/retrieval.js';
import { attributeSlot } from '../lib/memory/attributes.js';
import { renderContextBlock, renderInjectedMemories } from '../lib/memory/render.js';

const DAY = 86_400_000;

test('检索路由：默认只按当前消息，不把未决问题拼进检索词', () => {
  const plan = planRetrieval({
    text: '今天想吃什么',
    state: { openQuestion: '启动慢的问题还没修' },
    config: {},
  });
  assert.equal(plan.mode, 'current_message');
  assert.equal(plan.query, '今天想吃什么');
  assert.equal(plan.windowDays, 0);
  assert.equal(plan.includeSuperseded, false);
});

test('检索路由：受控陪伴只在「有线索 + 有话题」时扩展', () => {
  const config = { queryMode: 'guarded_companion' };
  const extended = planRetrieval({
    text: '今天调了半天这个启动问题，有点累',
    state: { openQuestion: '启动慢' },
    config,
  });
  assert.equal(extended.mode, 'companion_augmented');
  assert.match(extended.query, /启动慢/u);

  const notExtended = planRetrieval({ text: '抱抱', state: { openQuestion: '启动慢' }, config });
  assert.equal(notExtended.mode, 'current_message');
  assert.doesNotMatch(notExtended.query, /启动慢/u);
});

test('检索路由：问眼下状态只看最近几天，且只允许画像/事实/情景', () => {
  const plan = planRetrieval({ text: '在干嘛', config: { statusWindowDays: 5 } });
  assert.equal(plan.windowDays, 5);
  assert.deepEqual(plan.types, ['profile', 'fact', 'episodic']);
  assert.match(plan.reasons.join(''), /眼下状态/u);
});

test('检索路由：问「以前」时把被取代的旧值也算素材', () => {
  const plan = planRetrieval({ text: '你以前住哪儿来着', config: {} });
  assert.equal(plan.includeSuperseded, true);
  assert.equal(plan.windowDays, 0);
});

test('用法分级：被取代的旧值只能当「以前」说', () => {
  assert.equal(
    usageOf({ status: 'superseded', type: 'fact', content: '住在杭州', updatedAt: Date.now() }),
    'past',
  );
});

test('单值属性识别：住址改口算改口，爱好不算', () => {
  assert.equal(attributeSlot('前辈住在杭州', 'fact'), '住址');
  assert.equal(attributeSlot('喜欢喝美式', 'preference'), null);
});

test('写入改口：单值属性把旧值标成被取代，且指回新值', (t) => {
  const { store } = makeTempStore(t);
  const before = store.rememberMemory({ type: 'fact', content: '前辈住在杭州', source: 'user-explicit', importance: 0.8 });
  const after = store.rememberMemory({ type: 'fact', content: '前辈搬到上海了', source: 'user-explicit', importance: 0.8 });
  const old = store.getMemory(before.id);
  assert.equal(old.status, 'superseded');
  assert.equal(old.supersededBy, after.id);
  assert.equal(store.getMemory(after.id).status, 'active');
});

test('多值偏好不互相取代', (t) => {
  const { store } = makeTempStore(t);
  const a = store.rememberMemory({ type: 'preference', content: '前辈喜欢喝美式', source: 'auto' });
  const b = store.rememberMemory({ type: 'preference', content: '前辈喜欢喝拿铁', source: 'auto' });
  assert.equal(store.getMemory(a.id).status, 'active');
  assert.equal(store.getMemory(b.id).status, 'active');
});

test('检索缓存：同一句话第二次命中，写入新记忆后失效', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  store.rememberMemory({ type: 'fact', content: '前辈在做一个启动慢的问题', importance: 0.7 });
  const first = selectMemories(store, { query: '启动慢', sessionId: 's1', limit: 5 });
  assert.equal(first.cache, 'miss');
  assert.ok(first.memories.length > 0);

  const second = selectMemories(store, { query: '启动慢', sessionId: 's1', limit: 5 });
  assert.equal(second.cache, 'hit');
  assert.equal(second.path, first.path);
  assert.equal(second.memories.length, first.memories.length);

  store.rememberMemory({ type: 'fact', content: '启动慢的原因是孤儿进程抢 CPU', importance: 0.6 });
  const third = selectMemories(store, { query: '启动慢', sessionId: 's1', limit: 5 });
  assert.equal(third.cache, 'miss');
});

test('问「以前」时能召回被取代的旧值', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  const oldOne = store.rememberMemory({ type: 'fact', content: '前辈住在杭州', source: 'user-explicit', importance: 0.8 });
  store.rememberMemory({ type: 'fact', content: '前辈搬到上海了', source: 'user-explicit', importance: 0.8 });

  const plain = selectMemories(store, { limit: 5 });
  assert.ok(!plain.memories.some((memory) => memory.id === oldOne.id));

  const withPast = selectMemories(store, { limit: 5, includeSuperseded: true });
  const recalled = withPast.memories.find((memory) => memory.id === oldOne.id);
  assert.ok(recalled, '问「以前」时应把旧地址带回来');
  assert.equal(usageOf(recalled), 'past');
});

test('睡眠维护：近重复记忆合并成一条', (t) => {
  const { store } = makeTempStore(t);
  const old = Date.now() - 20 * DAY;
  const a = store.rememberMemory({ type: 'fact', content: '前辈在做一个叫 dsh 的插件', importance: 0.5, createdAt: old, updatedAt: old });
  const b = store.rememberMemory({ type: 'fact', content: '前辈在做一个叫 dsh 的插件系统', importance: 0.5, createdAt: old, updatedAt: old });
  const report = store.curate();
  assert.ok(report.deduped >= 1, '近重复应当合并');
  const alive = [a, b].map((memory) => store.getMemory(memory.id)).filter((memory) => memory.status === 'active');
  assert.equal(alive.length, 1);
});

test('睡眠维护：低价值的一组记忆压成近况汇总', (t) => {
  const { store } = makeTempStore(t);
  const old = Date.now() - 20 * DAY;
  for (const text of ['前辈今天喝了咖啡', '前辈今天走了两圈', '前辈今天早睡了一次']) {
    store.rememberMemory({ type: 'episodic', content: text, importance: 0.2, createdAt: old, updatedAt: old });
  }
  const report = store.curate();
  assert.ok(report.consolidated >= 1, '一组低价值记忆应当被聚合');
  const summary = store
    .listMemories({ type: 'episodic', limit: 20 })
    .find((memory) => String(memory.tags ?? '').includes('consolidated'));
  assert.ok(summary, '应当生成一条近况汇总');
  assert.match(summary.content, /近况汇总/u);
});

test('睡眠维护：用户交代过的事和关系记忆不会被归档', (t) => {
  const { store } = makeTempStore(t);
  const old = Date.now() - 60 * DAY;
  const explicit = store.rememberMemory({ type: 'fact', content: '前辈要求记住：他生日是三月', source: 'user-explicit', importance: 0.5, createdAt: old, updatedAt: old });
  const relation = store.rememberMemory({ type: 'relationship', content: '前辈和小洄一起熬过很多夜', importance: 0.3, createdAt: old, updatedAt: old });
  store.curate();
  assert.equal(store.getMemory(explicit.id).status, 'active');
  assert.equal(store.getMemory(relation.id).status, 'active');
});

test('注入渲染：被取代的旧值单独成段，标明只能当「以前」说', () => {
  const text = renderInjectedMemories([
    { id: 1, type: 'fact', content: '前辈住在杭州', status: 'superseded', confidence: 0.8, updatedAt: Date.now() - 40 * DAY },
  ], 1000);
  assert.match(text, /【以前的情况/u);
  assert.match(text, /杭州/u);
});

test('注入即观测：渲染后写入 retrieval.last', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  store.rememberMemory({ type: 'preference', content: '前辈喜欢安静的晚上', importance: 0.7 });
  renderContextBlock({ store, config: testConfig({ memoryGapMinutes: 0 }), sessionId: 's-x' });
  const last = String(store.metaGet('retrieval.last') ?? '');
  assert.match(last, /模式 current_message/u);
  assert.match(last, /路径/u);
});
