/** 判断日志：记录、结算、素材筛选、与记忆隔离（主动性改造 v0.7）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import { SCHEMA_VERSION } from '../lib/memory/store.js';

test('判断：记录后可读回，默认 open，空 guess 拒绝', (t) => {
  const { store } = makeTempStore(t);
  assert.equal(SCHEMA_VERSION, 7);
  const id = store.recordJudgment({ sessionId: 's-1', kind: 'read', subject: '他在问进度', guess: '他其实想被安慰' });
  const item = store.getJudgment(id);
  assert.equal(item.guess, '他其实想被安慰');
  assert.equal(item.outcome, 'open');
  assert.equal(item.kind, 'read');
  assert.throws(() => store.recordJudgment({ guess: ' ' }), /guess 不能为空/);
});

test('判断：结算 right / wrong / dropped，未知 id 报错', (t) => {
  const { store } = makeTempStore(t);
  const id = store.recordJudgment({ guess: '他想要方案' });
  const wrong = store.resolveJudgment(id, { outcome: 'wrong', note: '他其实只想被接住' });
  assert.equal(wrong.outcome, 'wrong');
  assert.equal(wrong.note, '他其实只想被接住');
  assert.equal(store.resolveJudgment(id, { outcome: 'dropped' }).outcome, 'dropped');
  assert.throws(() => store.resolveJudgment(9999, { outcome: 'right' }), /不存在/);
});

test('判断：素材只给最近猜错的 + 悬太久没验证的，数量受控', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  const wrongId = store.recordJudgment({ guess: '他想听方案', now: now - 60_000 });
  store.resolveJudgment(wrongId, { outcome: 'wrong', note: '他想被接住', now: now - 30_000 });
  store.recordJudgment({ guess: '这件事他还要跟进', now: now - 3 * 86_400_000 }); // 悬了 3 天
  store.recordJudgment({ guess: '这轮他不想聊工作', now: now - 1000 }); // 新的 open，不该进 stale
  const rightId = store.recordJudgment({ guess: '他喜欢先看结论', now: now - 2000 });
  store.resolveJudgment(rightId, { outcome: 'right', now: now - 1000 });

  const { wrong, stale } = store.judgmentMaterial({ now });
  assert.equal(wrong.length, 1);
  assert.equal(wrong[0].guess, '他想听方案');
  assert.equal(stale.length, 1);
  assert.equal(stale[0].guess, '这件事他还要跟进');
});

test('判断：listJudgments 支持按结果过滤', (t) => {
  const { store } = makeTempStore(t);
  const a = store.recordJudgment({ guess: 'A' });
  const b = store.recordJudgment({ guess: 'B' });
  store.resolveJudgment(a, { outcome: 'wrong' });
  store.resolveJudgment(b, { outcome: 'right' });
  assert.equal(store.listJudgments({ outcome: 'wrong' }).length, 1);
  assert.equal(store.listJudgments({ outcome: 'open' }).length, 0);
  assert.equal(store.listJudgments({ limit: 1 }).length, 1);
});

test('判断不是记忆：不进入记忆库与检索', (t) => {
  const { store } = makeTempStore(t);
  store.recordJudgment({ guess: '他其实想被接住' });
  assert.equal(store.memoryCounts().active, 0);
  assert.equal(store.searchMemories('接住').length, 0);
});
