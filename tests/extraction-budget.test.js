/**
 * v1.4 新增：抽取预算/失败退避、注入三级分流。
 *
 * 覆盖：
 *  - turns 表新增 extract_attempts / next_extract_at（schema v10）
 *  - 失败退避点让 unextractedTurns 暂时跳过该回合，到期才回来
 *  - 成功标记会清空退避
 *  - 抽取器失败后写退避、补做受冷却与批量上限约束、每小时预算用尽会挂起队列
 *  - usageOf / renderInjectedMemories 的三级分流
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore, testConfig } from './helpers.js';
import { SCHEMA_VERSION } from '../lib/memory/store.js';
import { createExtractionController } from '../lib/memory/extraction.js';
import { usageOf } from '../lib/memory/retrieval.js';
import { renderInjectedMemories } from '../lib/memory/render.js';

const DAY = 24 * 60 * 60 * 1000;
const TURN_TEXT = '以后日志统一用 zstd 压缩存，格式别再改了';

function turnColumns(store) {
  return store.db.prepare('PRAGMA table_info(turns)').all().map((row) => row.name);
}

function fakeLlm(handler = () => ({ ok: false, reason: 'empty-response' })) {
  const calls = [];
  return {
    calls,
    available: true,
    hasRoute: () => true,
    async callJson(request) {
      calls.push(request);
      return handler(request, calls.length);
    },
  };
}

function makeController(t, overrides = {}, llm = fakeLlm()) {
  const { store } = makeTempStore(t);
  const config = testConfig({ extractDebounceMs: 0, extractMinIntervalMs: 0, ...overrides });
  const controller = createExtractionController({ store, config, llm });
  t.after(() => controller.dispose());
  return { store, config, controller, llm };
}

test('迁移：turns 增加退避列，schema 版本随之升高', (t) => {
  const { store } = makeTempStore(t);
  const names = turnColumns(store);
  assert.ok(names.includes('extract_attempts'), 'turns 应有 extract_attempts');
  assert.ok(names.includes('next_extract_at'), 'turns 应有 next_extract_at');
  assert.ok(SCHEMA_VERSION >= 10, 'schema 版本应不低于 v10');
});

test('退避：失败点之前不回收，到了才回来', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  store.recordTurn({ sessionId: 's-1', turn: 3, userText: TURN_TEXT, endedAt: now });

  assert.equal(store.unextractedTurns({ now }).length, 1, '刚写完应可抽取');

  store.recordTurnExtractFailure('s-1', 3, { attempts: 2, nextAt: now + 5 * 60 * 1000 });
  assert.equal(store.unextractedTurns({ now }).length, 0, '退避期内不应被捞回');
  assert.equal(store.unextractedTurns({ now: now + 5 * 60 * 1000 + 1 }).length, 1, '到期应能再抽');

  const state = store.turnExtractState('s-1', 3);
  assert.equal(state.attempts, 2);
  assert.equal(state.nextAt, now + 5 * 60 * 1000);
});

test('成功：markTurnExtracted 清空退避与尝试次数', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  store.recordTurn({ sessionId: 's-1', turn: 4, userText: TURN_TEXT, endedAt: now });
  store.recordTurnExtractFailure('s-1', 4, { attempts: 3, nextAt: now + 60 * 60 * 1000 });

  store.markTurnExtracted('s-1', 4, now + 1000);

  assert.equal(store.unextractedTurns({ now }).length, 0);
  const state = store.turnExtractState('s-1', 4);
  assert.equal(state.attempts, 0, '成功后应清零');
  assert.equal(state.nextAt, 0, '成功后应清空退避点');
});

test('回填：resetExtractedTurns 一并清空退避，不空转', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  store.recordTurn({ sessionId: 's-1', turn: 9, userText: TURN_TEXT, endedAt: now });
  store.db.prepare('UPDATE turns SET extracted_at = ?, next_extract_at = ? WHERE session_id = ? AND turn = ?')
    .run(now, now + 60 * 60 * 1000, 's-1', 9);

  const rows = store.resetExtractedTurns({ limit: 5 });
  assert.equal(rows.length, 1);
  assert.equal(store.turnExtractState('s-1', 9).nextAt, 0, '重置后不应还带着退避');
  assert.equal(store.unextractedTurns({ now }).length, 1);
});

test('抽取：模型失败后写退避点，冷却期内不再重复调用', async (t) => {
  const { store, controller, llm } = makeController(t);
  const now = Date.now();
  store.recordTurn({ sessionId: 's-1', turn: 5, userText: TURN_TEXT, endedAt: now });

  assert.equal(controller.recoverPending(), 1, '应补做 1 个遗留回合');
  await controller.drain();

  assert.equal(llm.calls.length, 1, '失败也只该调用一次');
  const state = store.turnExtractState('s-1', 5);
  assert.equal(state.attempts, 1);
  assert.ok(state.nextAt > now, '应落下退避点');
  assert.equal(controller.stats().backoff, 1);

  assert.equal(controller.recoverPending(), 0, '冷却期内不再触发补做');
  await controller.drain();
  assert.equal(llm.calls.length, 1, '冷却期内不应再打模型');
});

test('补做：一批最多 recoverBatch 个', async (t) => {
  const { store, controller } = makeController(t, { extractRecoverBatch: 2 });
  const now = Date.now();
  for (let turn = 1; turn <= 5; turn += 1) {
    store.recordTurn({ sessionId: 's-1', turn, userText: TURN_TEXT, endedAt: now });
  }

  assert.equal(controller.recoverPending(), 2, '一批只补 recoverBatch 个');
  assert.equal(controller.recoverPending(), 0, '冷却期内不再补做');
  await controller.drain(500);
});

test('预算：每小时调用用尽后队列挂起，不空转也不丢活', async (t) => {
  const { store, controller, llm } = makeController(t, { extractMaxCallsPerHour: 1 });
  const now = Date.now();
  store.recordTurn({ sessionId: 's-1', turn: 1, userText: TURN_TEXT, endedAt: now });
  store.recordTurn({ sessionId: 's-1', turn: 2, userText: '记住我不喜欢被反复追问同一个问题', endedAt: now });

  assert.equal(controller.recoverPending(), 2);
  await controller.drain(400);

  const stats = controller.stats();
  assert.equal(llm.calls.length, 1, '每小时只允许一次调用');
  assert.ok(stats.deferred >= 1, '剩下的应记为排队等待');
  assert.ok(stats.queued >= 1, '队列应保留未做的回合');
});

test('注入分级：偏好走 tone，事实走 mention，低置信与过旧走 uncertain', (t) => {
  void t;
  const now = Date.now();
  assert.equal(usageOf({ type: 'fact', confidence: 0.9, updatedAt: now }), 'mention');
  assert.equal(usageOf({ type: 'preference', confidence: 0.9, updatedAt: now }), 'tone');
  assert.equal(usageOf({ type: 'interaction', confidence: 0.9, updatedAt: now }), 'tone');
  assert.equal(usageOf({ type: 'fact', confidence: 0.2, updatedAt: now }), 'uncertain');
  assert.equal(usageOf({ type: 'fact', confidence: 0.9, updatedAt: now - 400 * DAY }), 'uncertain');
});

test('注入块：三级各有标题，空列表不产出任何内容', (t) => {
  void t;
  const now = Date.now();
  const memories = [
    { id: 1, type: 'fact', content: '用户在做 dsh-soul 插件', confidence: 0.9, updatedAt: now, hits: 2 },
    { id: 2, type: 'preference', content: '用户喜欢先看结论再看细节', confidence: 0.9, updatedAt: now, hits: 3 },
    { id: 3, type: 'fact', content: '用户以前住在杭州', confidence: 0.3, updatedAt: now - 300 * DAY, hits: 1 },
  ];

  const text = renderInjectedMemories(memories, 600);
  assert.match(text, /【可以自然提起】/);
  assert.match(text, /【只影响语气，不要复述内容】/);
  assert.match(text, /【拿不准／较旧，别当事实说】/);
  assert.match(text, /dsh-soul/, '事实类应带出来');
  assert.match(text, /先看结论/, '偏好类应在语气段');

  assert.equal(renderInjectedMemories([], 600), '', '没有记忆时不产出');
});
