/** 语体信号：把「主人夸/嫌上一轮说法」从一句话里认出来（lib/style-signal.js）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFeedbackSignal, classifyFeedbackSignal, pickReplySentence } from '../lib/style-signal.js';

test('夸：明确指向上一条说法', () => {
  assert.equal(classifyFeedbackSignal('这句说得好，就这样'), 'praise');
  assert.equal(classifyFeedbackSignal('有内味了'), 'praise');
  assert.equal(classifyFeedbackSignal('这样讲就很自然'), 'praise');
});

test('嫌：指向说话方式，不是内容', () => {
  assert.equal(classifyFeedbackSignal('又像说明书了'), 'correction');
  assert.equal(classifyFeedbackSignal('别这么说话，太生硬'), 'correction');
  assert.equal(classifyFeedbackSignal('不像你了'), 'correction');
});

test('转折词只否掉假夸奖，转折后的批评仍要识别', () => {
  const mixed = analyzeFeedbackSignal('代码没问题，但是你说话又像客服一样生硬了');
  assert.equal(mixed?.signal, 'correction');
  assert.equal(mixed?.category, 'mechanical_tone');
  assert.match(mixed?.rule ?? '', /客服|直接说事/u);
  assert.equal(classifyFeedbackSignal('代码没问题，但是你说话又像客服一样生硬了'), 'correction');
  // 前半句是夸奖、后半句在说正事：没有语体批评，仍然判不出来
  assert.equal(analyzeFeedbackSignal('这句说得好，但是我觉得这个方案还有几个问题需要一起看一下'), null);
});

test('判不出来就 null：不猜', () => {
  assert.equal(classifyFeedbackSignal('好的'), null);
  assert.equal(classifyFeedbackSignal(''), null);
  assert.equal(classifyFeedbackSignal('把这个函数改成异步'), null);
  // 长句多半是在说正事，不当成对说话方式的评价
  assert.equal(classifyFeedbackSignal('这句说得好，但是我觉得这个方案还有几个问题需要一起看一下比如缓存失效和重试策略'), null);
});

test('挑样本句：跳过清单/代码，取完整的句子', () => {
  const reply = '- 第一条\n看到这个问题我其实有点想笑，因为昨天才刚踩过同一个坑。\n```js\nconst a = 1;\n```';
  assert.equal(pickReplySentence(reply), '看到这个问题我其实有点想笑，因为昨天才刚踩过同一个坑。');
});

test('挑样本句：没有合格句子就返回空串', () => {
  assert.equal(pickReplySentence('- 一\n- 二\n```js\nx\n```'), '');
  assert.equal(pickReplySentence('嗯。'), '');
});
