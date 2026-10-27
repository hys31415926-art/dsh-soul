/**
 * emotion.test — 情绪的时间演化、平滑与判定（用假 store / 假 LLM）。
 * 运行：node tests/emotion.test.js
 */
import assert from 'node:assert/strict';
import {
  EMOTION_LABELS, labelFor, isNegativeLabel, evolve, smooth, createEmotionTracker,
} from '../lib/emotion.js';

let pass = 0;
let fail = 0;
function test(name, fn) {
  try {
    fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}
async function testAsync(name, fn) {
  try {
    await fn();
    pass += 1;
    console.log(`  ok   ${name}`);
  } catch (error) {
    fail += 1;
    console.error(`  FAIL ${name}\n       ${error?.message ?? error}`);
  }
}

const HOUR = 3_600_000;
const NOW = new Date(2026, 9, 26, 15, 0, 0).getTime();

function fakeStore(initial = null) {
  let emotion = initial;
  return {
    getEmotion: () => emotion,
    setEmotion: (next) => { emotion = { ...next, updatedAt: Date.now() }; return emotion; },
    recentTurns: () => [{ userText: '在写代码', assistantText: '好' }],
    _get: () => emotion,
  };
}

test('label 档位：val<=-0.45 生气，-0.1~-0.45 闷，>=0.15 开心，中间轻松', () => {
  assert.equal(labelFor(-0.9), '生气');
  assert.equal(labelFor(-0.45), '生气');
  assert.equal(labelFor(-0.3), '闷');
  assert.equal(labelFor(-0.1), '闷');
  assert.equal(labelFor(0), '轻松');
  assert.equal(labelFor(0.2), '开心');
  assert.ok(EMOTION_LABELS.includes('心疼'));
});

test('细标签保留：负面里已经是「烦躁」就不用压成「闷」', () => {
  assert.equal(labelFor(-0.3, '烦躁'), '烦躁');
  assert.equal(labelFor(0.5, '兴奋'), '兴奋');
  assert.equal(labelFor(0.5, '闷'), '开心');
});

test('isNegativeLabel 认负面词', () => {
  assert.equal(isNegativeLabel('闷'), true);
  assert.equal(isNegativeLabel('生气'), true);
  assert.equal(isNegativeLabel('开心'), false);
});

test('开心半衰期 6 小时：6h 后还剩一半，24h 后回 0', () => {
  const six = evolve({ valence: 0.8, label: '开心', reason: '聊得好', updatedAt: NOW }, NOW + 6 * HOUR);
  assert.ok(Math.abs(six.valence - 0.4) < 0.01);
  const day = evolve({ valence: 0.8, label: '开心', reason: '', updatedAt: NOW }, NOW + 24 * HOUR);
  assert.equal(day.valence, 0);
  assert.equal(day.label, '轻松');
});

test('生气不会自己消：沉默 12 小时更深，封顶 -0.8', () => {
  const base = { valence: -0.5, label: '生气', reason: '他敷衍我', updatedAt: NOW };
  const twelve = evolve(base, NOW + 12 * HOUR);
  assert.ok(twelve.valence < -0.5);
  assert.ok(Math.abs(twelve.valence - -0.56) < 0.01);
  const threeDays = evolve(base, NOW + 72 * HOUR);
  assert.equal(threeDays.valence, -0.8);
});

test('平滑：新判定只占 30%，不能一步从 +0.8 翻到 -0.8', () => {
  const old = { valence: 0.8, label: '开心', reason: '', updatedAt: NOW };
  const next = smooth(old, { valence: -0.8, label: '生气', reason: '他凶我' });
  assert.ok(next.valence > 0);           // 还是正
  assert.ok(next.valence < 0.8);
  assert.ok(Math.abs(next.valence - 0.5) < 0.01); // 先按 30% 算 0.32，再被 maxStep 0.3 截到 0.5
  assert.equal(next.reason, '他凶我');
});

test('平滑：单轮变化最多 0.3', () => {
  const old = { valence: 0, label: '轻松', reason: '', updatedAt: NOW };
  const next = smooth(old, { valence: 1, label: '兴奋', reason: '' }, { alpha: 1 });
  assert.ok(Math.abs(next.valence - 0.3) < 1e-9);
});

await testAsync('current：没有记录 → 轻松 0', async () => {
  const tracker = createEmotionTracker({ store: fakeStore(null), config: {}, logger: null, llm: null });
  const now = tracker.current(NOW);
  assert.equal(now.label, '轻松');
  assert.equal(now.valence, 0);
});

await testAsync('judgeNow 写到 store（假 LLM）', async () => {
  const store = fakeStore(null);
  const llm = {
    available: true,
    async callJson() {
      return { ok: true, json: { valence: -0.6, label: '生气', reason: '他一直不理我' } };
    },
  };
  const tracker = createEmotionTracker({ store, config: {}, logger: null, llm });
  const result = await tracker.judgeNow('嗯', { sessionId: 's', now: NOW });
  assert.ok(result.valence < 0);
  assert.equal(result.reason, '他一直不理我');
  assert.ok(store._get());
  assert.equal(store._get().label, '生气');
});

await testAsync('judgeNow：模型失败 → 不改旧情绪', async () => {
  const old = { valence: 0.5, label: '开心', reason: '刚聊完', updatedAt: NOW - 1000 };
  const store = fakeStore(old);
  const llm = { available: true, async callJson() { return { ok: false, reason: 'timeout' }; } };
  const tracker = createEmotionTracker({ store, config: {}, logger: null, llm });
  const result = await tracker.judgeNow('随便说句话', { sessionId: 's', now: NOW });
  assert.equal(store._get().label, '开心');
  assert.equal(result.label, '开心');
});

await testAsync('judgeNow：模型返回非法 label 时按 valence 兜底', async () => {
  const store = fakeStore(null);
  const llm = {
    available: true,
    async callJson() { return { ok: true, json: { valence: -0.5, label: '离谱标签', reason: 'x' } }; },
  };
  const tracker = createEmotionTracker({ store, config: {}, logger: null, llm });
  const result = await tracker.judgeNow('你走吧', { sessionId: 's', now: NOW });
  assert.ok(['闷', '生气'].includes(result.label));
});

console.log(`\n${pass} passed, ${fail} failed`);
if (fail > 0) process.exit(1);
