/**
 * tests/style-preference-scene.test.js — 1.7 审查后的回归测试。
 *
 * 盯三处：
 *   1. 「往哪个方向调」这类偏好以前被整句丢掉，现在要进语体链路；
 *   2. 场景格从 work/chat 两档细分为六档，且旧数据（全在 chat）仍能被兜底取到；
 *   3. 情绪指向 topic 在「话题变了」时跟着换。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFeedbackSignal } from '../lib/style-signal.js';
import { sceneFallbacks, sceneOf } from '../lib/core/scene.js';
import { smooth } from '../lib/emotion.js';
import { makeTempStore } from './helpers.js';

test('偏好：往哪个方向调也算反馈，不再整句丢掉', () => {
  const case1 = analyzeFeedbackSignal('能再活泼一点吗');
  assert.equal(case1?.signal, 'preference');
  assert.equal(case1?.category, 'style_preference');
  assert.ok((case1?.rule ?? '').includes('方向'));

  const case2 = analyzeFeedbackSignal('以后更活泼、更不过脑子一点吧');
  assert.equal(case2?.signal, 'preference');

  const case3 = analyzeFeedbackSignal('允许主动换话题');
  assert.equal(case3?.signal, 'preference');

  // 同一句里既有方向又有具体的嫌时走批评通道，也不算丢——只是归到更准的那一类。
  const mixed = analyzeFeedbackSignal('能再活泼一点吗，不用那么端着');
  assert.equal(mixed?.signal, 'correction');
  assert.equal(mixed?.category, 'flat_tone');
  const mixed3 = analyzeFeedbackSignal('允许主动换话题，不用每轮都问我');
  assert.equal(mixed3?.category, 'over_questioning');
});

test('偏好：真在嫌的地方仍然走批评通道，不被偏好吞掉', () => {
  const correction = analyzeFeedbackSignal('不要反复自我反思了，看着累');
  assert.equal(correction?.signal, 'correction');
  assert.equal(correction?.category, 'self_analysis_apology');

  const praise = analyzeFeedbackSignal('这句说得好，就这样');
  assert.equal(praise?.signal, 'praise');
});

test('场景格：亲近/情绪/被检验/反馈各自成格，不再全塞进 chat', () => {
  assert.equal(sceneOf('work'), 'work');
  assert.equal(sceneOf('discussion'), 'work');
  assert.equal(sceneOf('flirt'), 'intimate');
  assert.equal(sceneOf('emotional'), 'emotional');
  assert.equal(sceneOf('test'), 'test');
  assert.equal(sceneOf('feedback'), 'feedback');
  assert.equal(sceneOf('casual'), 'chat');
  assert.equal(sceneOf('乱写的'), 'chat');
});

test('场景格：细分场景没有自己的规则时，仍然取得到 chat 里学过的', (t) => {
  const { store } = makeTempStore(t);
  store.upsertBehaviorRule({ rule: '少用波浪号和卖萌语气词', scene: 'chat', category: 'over_intimate', turnId: 1, isExplicit: true });
  store.upsertBehaviorRule({ rule: '先给结论再补细节', scene: 'work', category: 'mechanical_tone', turnId: 2, isExplicit: true });
  const fallbacks = sceneFallbacks('intimate');
  assert.deepEqual(fallbacks, ['chat']);
  const rules = store.activeStyleRules({ scene: 'intimate', limit: 6, fallbackScenes: fallbacks });
  const texts = rules.map((rule) => rule.rule);
  assert.ok(texts.some((text) => text.includes('波浪号')), '闲聊学到的规则不能因为场景细分就消失');
  assert.ok(!texts.some((text) => text.includes('先给结论')), '工作规则不该漏到亲近场景');
});

test('场景格：细分场景自己的规则优先于 chat 兜底', (t) => {
  const { store } = makeTempStore(t);
  store.upsertBehaviorRule({ rule: '少用波浪号和卖萌语气词', scene: 'chat', category: 'over_intimate', turnId: 1, isExplicit: true });
  store.upsertBehaviorRule({ rule: '亲近时不必每句都撒娇', scene: 'intimate', category: 'over_intimate', turnId: 2, isExplicit: true });
  const rules = store.activeStyleRules({ scene: 'intimate', limit: 6, fallbackScenes: ['chat'] });
  assert.equal(rules[0]?.scene, 'intimate');
  assert.ok(rules.length >= 1);
});

test('情绪指向：话题换了，topic 跟着换而不是一直挂在旧事上', () => {
  const now = Date.now();
  const next = smooth(
    { valence: 0.5, label: '开心', reason: '壁纸换了', topic: '副屏', updatedAt: now },
    { valence: 0.7, label: '开心', reason: '验收过了', topic: '明天的验收' },
  );
  assert.equal(next.topic, '明天的验收');
  assert.equal(next.reason, '验收过了');
});
