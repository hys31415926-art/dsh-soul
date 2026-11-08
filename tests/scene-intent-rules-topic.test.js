/**
 * tests/scene-intent-rules-topic.test.js — 1.7.2 修的三处：
 *   1. 斗嘴（tease）与被比较（comparison）从前都混成普通闲聊，回法和检索都跟着串；
 *   2. 同主题的几条规则字面相似度只有 0.2，合并不了，但每轮一起注入等于同一句话念几遍；
 *   3. emotion.topic 全靠模型自己填，真实库里一直是空的——补一层「从原话取对象」的兜底。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTurn } from '../lib/core/conversation-policy.js';
import { sceneFallbacks, sceneOf } from '../lib/core/scene.js';
import { dedupeRulesByTopic, ruleTopic } from '../lib/core/rule-topics.js';
import { createEmotionTracker, topicFromText } from '../lib/emotion.js';
import { renderEmotionLine } from '../lib/memory/render.js';
import { makeTempStore } from './helpers.js';

test('斗嘴与比较：不再都归成普通闲聊', () => {
  assert.equal(classifyTurn('你看看人家那边的助手，说话多有意思，你再看看你。').kind, 'comparison');
  assert.equal(classifyTurn('我是说真的，你就是不如它。').kind, 'comparison');
  assert.equal(classifyTurn('你比它差远了').kind, 'comparison');
  assert.equal(classifyTurn('哈哈你今天怎么这么笨').kind, 'tease');
  assert.equal(classifyTurn('行吧行吧，你就这水平了').kind, 'tease');
  assert.equal(classifyTurn('你是不是在水啊，这也叫回答').kind, 'tease');
  // 嘴硬这种只是接个话头，别认成损人。
  assert.equal(classifyTurn('你就嘴硬吧，反正我不信').kind, 'casual');
  assert.equal(classifyTurn('我不开玩笑了。刚才那件事我真的有点不高兴。').kind, 'emotional');
});

test('比较落到情绪格，斗嘴留在闲聊格', () => {
  assert.equal(sceneOf('comparison'), 'emotional');
  assert.deepEqual(sceneFallbacks('emotional'), ['chat']);
  assert.equal(sceneOf('tease'), 'chat');
  assert.deepEqual(sceneFallbacks('chat'), []);
});

test('规则主题：同一件事的几种说法归到一起', () => {
  assert.equal(ruleTopic('说话活泼随性直接表达真实感受不反复掂量对方想法'), 'directness');
  assert.equal(ruleTopic('直接说出自己的态度和情绪不先揣测对方会怎么想'), 'directness');
  assert.equal(ruleTopic('回复中少用波浪号和卖萌语气词'), 'sweetness');
  assert.equal(ruleTopic('提问时直接给出可选项让用户选择'), 'questioning');
  // 判不出来就空着，不硬塞一个类。
  assert.equal(ruleTopic('中午记得吃饭'), '');
});

test('注入去重：同主题只留一条，不同主题各留各的', () => {
  const rules = [
    { id: 34, norm: '说话活泼随性直接表达真实感受不反复掂量对方想法', evidence_count: 1.5 },
    { id: 35, norm: '直接说出自己的态度和情绪不先揣测对方会怎么想', evidence_count: 1.5 },
    { id: 39, norm: '直接表达喜欢或烦不自我反省不检讨自己有什么问题', evidence_count: 1.5 },
    { id: 9, norm: '回复中少用波浪号和卖萌语气词', evidence_count: 1.5 },
    { id: 42, norm: '不必刻意在句尾挂口癖词自然说话即可', evidence_count: 1.5 },
    { id: 6, norm: '提问时直接给出可选项让用户选择避免开放式发问', evidence_count: 1.5 },
  ];
  const out = dedupeRulesByTopic(rules);
  assert.deepEqual(out.map((rule) => rule.id).sort((a, b) => a - b), [6, 39, 42]);
});

test('topic 兜底：从用户原话里取最长的一段，不编', () => {
  assert.equal(topicFromText('今天好累啊'), '今天好累啊');
  assert.equal(topicFromText('抱抱，今天有点想你'), '今天有点想你');
  assert.equal(topicFromText(''), '');
  assert.equal(topicFromText('？？？'), '');
});

test('topic 兜底：模型不给对象时有明确情绪才补，平平的一轮不补', async (t) => {
  const { store } = makeTempStore(t);
  const strong = createEmotionTracker({
    store,
    config: {},
    llm: {
      available: true,
      callJson: async () => ({ ok: true, json: { valence: -0.5, label: '低落', reason: '说累' } }),
    },
  });
  const next = await strong.judgeNow('今天好累啊');
  assert.equal(next.topic, '今天好累啊');

  const flat = createEmotionTracker({
    store: makeTempStore(t).store,
    config: {},
    llm: {
      available: true,
      callJson: async () => ({ ok: true, json: { valence: 0, label: '轻松', reason: '' } }),
    },
  });
  const calm = await flat.judgeNow('今天好累啊');
  assert.equal(calm.topic, '');
});

test('情绪行：兜底出来的 topic 与 reason 撞车时只说一次', (t) => {
  const { store } = makeTempStore(t);
  store.setEmotion({ valence: -0.4, label: '低落', reason: '今天好累啊', topic: '今天好累啊' });
  const line = renderEmotionLine(store, {});
  assert.equal(line, '我现在的心情：低落（今天好累啊）。');
  assert.equal(line.split('今天好累啊').length - 1, 1);
});
