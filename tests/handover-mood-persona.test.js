/**
 * tests/handover-mood-persona.test.js — 交接书（mood / persona）改造的回归测试。
 *
 * 盯四个已修的点：
 *   1. 语体样本不再把「立规矩 / 编号步骤」当原句（pickReplySentence）；
 *   2. 正向锚点只能是助手自己说过的原话，只出现在用户话里的降成 borrowed；
 *   3. 用户第一人称原话不再整句贴成长期记忆；
 *   4. 「他觉得你差并为此难受」这类推测出来的情绪降成候选，不当稳定偏好。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { pickReplySentence } from '../lib/style-signal.js';
import { validateSemanticResult } from '../lib/memory/semantic.js';
import { evolve, smooth } from '../lib/emotion.js';
import { makeTempStore } from './helpers.js';

test('语体样本：立规矩/编号步骤的句子不进原句库', () => {
  const rules = '接下来我立三条规矩：1. 不每步截图；2. 先给结论再补细节。';
  assert.equal(pickReplySentence(rules), '');
  // 同一段里夹着的正常口语仍然能挑出来。
  const mixed = '接下来我立三条规矩：1. 不每步截图；2. 先给结论再补细节。\n好家伙，这回我算是把话说明白了，你也别再绕。';
  assert.equal(pickReplySentence(mixed), '好家伙，这回我算是把话说明白了，你也别再绕。');
});

test('语体样本：只在用户话里出现的句子降成 borrowed，不当正向锚点', () => {
  const validated = validateSemanticResult({
    styleExamples: [{ text: '我爱你所以说什么都无所谓', kind: 'positive', scene: 'chat' }],
  }, { turns: [{ userText: '我爱你所以说什么都无所谓', assistantText: '听见了。' }] });
  assert.equal(validated.styleExamples.length, 1);
  assert.equal(validated.styleExamples[0].kind, 'borrowed');
});

test('语体样本：助手真说过的原句仍然记 positive', () => {
  const validated = validateSemanticResult({
    styleExamples: [{ text: '我爱你所以说什么都无所谓', kind: 'positive', scene: 'chat' }],
  }, { turns: [{ userText: '嗯', assistantText: '我爱你所以说什么都无所谓' }] });
  assert.equal(validated.styleExamples[0].kind, 'positive');
});

test('记忆写入：用户第一人称原话不再整句贴成长期记忆', () => {
  const validated = validateSemanticResult({
    memories: [{ type: 'preference', content: '我爱你所以说什么都无所谓', confidence: 0.9 }],
  }, { turns: [{ userText: '我爱你所以说什么都无所谓' }] });
  assert.equal(validated.memories.length, 0);
});

test('记忆写入：推测出来的情绪降成候选，不当稳定偏好', () => {
  const validated = validateSemanticResult({
    memories: [{
      type: 'preference',
      content: '用户觉得助手不会说话、表现很菜，并为此感到难受。',
      evidenceQuote: '你的表现很菜，我看着难受',
      confidence: 0.9,
    }],
  }, { turns: [{ userText: '你的表现很菜，我看着难受' }] });
  assert.equal(validated.memories.length, 1);
  assert.ok(validated.memories[0].confidence <= 0.6);
});

test('情绪：新判定没给原因时，旧原因和指向不会被覆盖成空', () => {
  const now = Date.now();
  const next = smooth(
    { valence: 0.6, label: '开心', reason: '壁纸换了', topic: '副屏', updatedAt: now },
    { valence: 0.8, label: '开心', reason: '', topic: '' },
  );
  assert.equal(next.reason, '壁纸换了');
  assert.equal(next.topic, '副屏');
});

test('情绪：淡下去之后不再带着旧原因，避免每轮凭空生成', () => {
  const now = Date.now();
  const evolved = evolve(
    { valence: 0.5, label: '开心', reason: '壁纸换了', topic: '副屏', updatedAt: now - 48 * 3_600_000 },
    now,
  );
  assert.equal(evolved.valence, 0);
  assert.equal(evolved.reason, '');
  assert.equal(evolved.topic, '');
});

test('规则：换句话说的同一条反馈不再各存一条', (t) => {
  const { store } = makeTempStore(t);
  const first = store.upsertBehaviorRule({
    rule: '不要像背答案一样回答，自然一点',
    scene: 'chat',
    category: 'mechanical_tone',
    turnId: 1,
  });
  const second = store.upsertBehaviorRule({
    rule: '不要像背答案一样回话，自然一点哦',
    scene: 'chat',
    category: 'mechanical_tone',
    turnId: 2,
  });
  assert.equal(second.id, first.id);
  assert.equal(store.listStyleRules({ scene: 'chat' }).length, 1);
});

test('规则：说的不是一回事就各留各的', (t) => {
  const { store } = makeTempStore(t);
  store.upsertBehaviorRule({ rule: '少用波浪号和卖萌语气词', scene: 'chat', category: 'over_intimate', turnId: 1 });
  store.upsertBehaviorRule({ rule: '回答时先给结论再补细节', scene: 'chat', category: 'mechanical_tone', turnId: 2 });
  assert.equal(store.listStyleRules({ scene: 'chat' }).length, 2);
});
