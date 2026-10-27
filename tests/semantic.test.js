/**
 * tests/semantic.test.js — 语义记忆管道（v0.6）的单元测试。
 *
 * 覆盖：
 *   · evidence.js   证据写入/读取/计数/清理
 *   · journal.js    项目工作日志去重、今日摘要、项目归属
 *   · semantic.js   证据句校验、碎片拒绝、助手内容不能当用户事实、落库
 *   · extraction.js 回合结束后抽取（成功落库 / 失败降级只记工作日志 / 幂等）
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore, testConfig } from './helpers.js';
import { openStore } from '../lib/memory/store.js';
import { addEvidence, listEvidence, evidenceCounts, pruneEvidence } from '../lib/memory/evidence.js';
import {
  recordJournal,
  listJournal,
  recentJournal,
  todayDigest,
  formatTodayDigest,
  projectAttribution,
} from '../lib/memory/journal.js';
import {
  findEvidenceQuote,
  validateSemanticResult,
  applySemanticResult,
  recordTurnWorkJournal,
} from '../lib/memory/semantic.js';
import { createExtractionController } from '../lib/memory/extraction.js';

function makeProject(store, name = '测试项目') {
  const project = store.upsertProject({ name, goal: '验证语义管道', stage: '开发中', source: 'user' });
  const id = Number(project?.id ?? 0);
  assert.ok(id > 0, '项目应写入成功');
  return id;
}

function remember(store, content, extra = {}) {
  return store.rememberMemory({ type: 'preference', content, source: 'test', ...extra });
}

test('evidence：写入、读取、计数与清理', (t) => {
  const { store } = makeTempStore(t);
  const memory = remember(store, '我喜欢用 TypeScript 写工具');
  assert.equal(addEvidence(store, memory.id, [{ sessionId: 's1', turn: 1, role: 'user', quote: '我喜欢用 TypeScript 写工具' }]), 1);
  const rows = listEvidence(store, memory.id);
  assert.equal(rows.length, 1);
  assert.equal(rows[0].turn, 1);
  assert.equal(rows[0].quote, '我喜欢用 TypeScript 写工具');
  const counts = evidenceCounts(store, [memory.id]);
  assert.equal(typeof counts?.get === 'function' ? counts.get(memory.id) : counts[memory.id], 1);
  assert.equal(pruneEvidence(store, { retentionDays: 0 }), 0, '太新鲜的证据不应被清理');
});

test('journal：同一天同类日志合并 hits 而不重复', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  const first = recordJournal(store, { projectId: pid, sessionId: 's1', turn: 1, kind: 'decision', summary: '决定用 SQLite 存记忆', confidence: 0.8 });
  assert.ok(first?.id > 0);
  assert.equal(first.inserted, true);
  const second = recordJournal(store, { projectId: pid, sessionId: 's1', turn: 2, kind: 'decision', summary: '决定用 SQLite 存记忆' });
  assert.equal(second.inserted, false);
  const rows = listJournal(store, { projectId: pid });
  assert.equal(rows.length, 1);
  assert.ok(rows[0].hits >= 2);
  assert.equal(recentJournal(store, pid, 5).length, 1);
});

test('journal：今日摘要有条目、格式可读', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store, 'dsh-soul');
  recordJournal(store, { projectId: pid, sessionId: 's1', turn: 1, kind: 'progress', summary: '写完了语义抽取模块' });
  recordJournal(store, { projectId: pid, sessionId: 's1', turn: 1, kind: 'plan', summary: '接下来补真实宿主 E2E' });
  const digest = todayDigest(store, { projectId: pid });
  assert.equal(digest.totalEntries, 2);
  assert.equal(digest.projects.length, 1);
  assert.equal(digest.projects[0].project.name, 'dsh-soul');
  const text = formatTodayDigest(digest, { projectName: 'dsh-soul' });
  assert.match(text, /项目「dsh-soul」/u);
  assert.match(text, /进展/u);
  assert.match(text, /计划/u);
});

test('journal：项目归属优先活跃项目，其次名字匹配', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store, 'dsh-soul');
  store.setSessionState('s-attr', { activeProjectId: pid });
  assert.equal(projectAttribution(store, { sessionId: 's-attr', texts: ['随便聊聊'] })?.id, pid);
  const other = projectAttribution(store, { sessionId: 's-none', texts: ['继续推进 dsh-soul 的语义管道'] });
  assert.equal(Number(other?.id), pid);
  assert.equal(projectAttribution(store, { sessionId: 's-none', texts: ['今天天气不错'] }), null);
});

test('semantic：findEvidenceQuote 只在用户原话里找证据', () => {
  const hit = findEvidenceQuote(['我平时习惯用 TypeScript 写工具'], '用户习惯用 TypeScript 写工具');
  assert.ok(hit && hit.includes('TypeScript'));
  assert.equal(findEvidenceQuote(['今天天气不错'], '用户喜欢用 Rust 写系统软件'), null);
});

test('semantic：校验——用户事实必须有原句、碎片被拒、助手内容不算用户事实', () => {
  const turns = [
    { userText: '我喜欢用 TypeScript 写工具，你记一下', assistantText: '已经完成语义管道实现并跑了测试' },
  ];
  const { memories, projectUpdates, rejected } = validateSemanticResult({
    memories: [
      { type: 'preference', content: '主人喜欢用 TypeScript 写工具', confidence: 0.9 },
      { type: 'preference', content: '下一步：项目', confidence: 0.9 },
      { type: 'fact', content: '助手完成语义管道实现', confidence: 0.9 },
    ],
    projectUpdates: [
      { kind: 'progress', summary: '完成语义管道实现并跑了测试' },
      { kind: 'progress', summary: '明天上线发布生产环境' },
    ],
  }, { sessionId: 's1', turn: 1, turns, project: { id: 1, name: '测试项目' } });
  assert.equal(memories.length, 1);
  assert.equal(memories[0].content, '主人喜欢用 TypeScript 写工具');
  assert.ok(memories[0].quote.includes('TypeScript'));
  assert.equal(projectUpdates.length, 1);
  assert.equal(projectUpdates[0].kind, 'progress');
  assert.equal(rejected.length, 3);
});

test('semantic：applySemanticResult 写记忆 + 证据 + 工作日志', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  const turns = [{ userText: '以后都用中文回复我', assistantText: '已把语义管道跑通并验证；决定固定抽取窗口为 3 轮' }];
  const validated = validateSemanticResult({
    memories: [{ type: 'preference', content: '以后都用中文回复', confidence: 0.9 }],
    projectUpdates: [{ kind: 'decision', summary: '决定固定抽取窗口为 3 轮' }],
  }, { sessionId: 's1', turn: 2, turns, project: { id: pid, name: '测试项目' } });
  const stats = applySemanticResult(store, {
    sessionId: 's1',
    turn: 2,
    result: validated,
    window: { turns, project: { id: pid, name: '测试项目' }, eventRefs: {} },
    config: {},
  });
  assert.equal(stats.created.length, 1);
  assert.equal(stats.evidence, 1);
  assert.equal(stats.journal, 1);
  const saved = store.getMemory(stats.created[0]);
  assert.equal(saved.status, 'active');
  assert.equal(saved.source, 'semantic:llm');
  assert.equal(saved.createdBy, 'user');
  assert.equal(listEvidence(store, saved.id).length, 1);
  assert.equal(store.listProjectItems(pid).length, 1);
});

test('semantic：过程类更新只进工作日志，稳定类才进项目档案', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  const turns = [{ userText: '跑一下语义管道', assistantText: '跑完了，102/102 通过；决定把抽取窗口固定为 3 轮。' }];
  const validated = validateSemanticResult({
    projectUpdates: [
      { kind: 'work', summary: '跑完了，102/102 通过' },
      { kind: 'decision', summary: '决定把抽取窗口固定为 3 轮' },
    ],
  }, { sessionId: 's2', turn: 1, turns, project: { id: pid, name: '测试项目' } });
  assert.equal(validated.projectUpdates.length, 2);
  const stats = applySemanticResult(store, {
    sessionId: 's2',
    turn: 1,
    result: validated,
    window: { turns, project: { id: pid, name: '测试项目' }, eventRefs: {} },
    config: {},
  });
  assert.equal(stats.journal, 2, '两条都应进工作日志');
  const items = store.listProjectItems(pid);
  assert.equal(items.length, 1, '只有稳定类应进项目档案');
  assert.equal(items[0].kind, 'decision');
});

test('semantic：单回合项目更新最多 3 条，超出计 rejected 且优先保留稳定类型', () => {
  const turns = [{
    userText: '继续推进语义管道',
    assistantText: '推进了第一步；推进了第二步；推进了第三步；决定改用 SQLite 存储；发现迁移阻塞。',
  }];
  const validated = validateSemanticResult({
    projectUpdates: [
      { kind: 'progress', summary: '推进了第一步' },
      { kind: 'progress', summary: '推进了第二步' },
      { kind: 'progress', summary: '推进了第三步' },
      { kind: 'decision', summary: '决定改用 SQLite 存储' },
      { kind: 'issue', summary: '发现迁移阻塞' },
    ],
  }, { sessionId: 's3', turn: 1, turns, project: { id: 1, name: '测试项目' } });
  assert.equal(validated.projectUpdates.length, 3);
  const keptKinds = validated.projectUpdates.map((update) => update.kind).sort();
  assert.deepEqual(keptKinds, ['decision', 'issue', 'progress'], '稳定类型应优先保留');
  assert.equal(validated.rejected.filter((entry) => entry.reason === 'over-limit').length, 2);
});

test('semantic：recordTurnWorkJournal 用工具次数兜底记录工作日志', (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  const entry = recordTurnWorkJournal(store, {
    project: { id: pid, name: '测试项目' },
    sessionId: 's1',
    turn: 3,
    userText: '继续改语义管道',
    toolCalls: 4,
  });
  assert.ok(entry?.id > 0);
  assert.match(entry.summary, /工具调用|使用/u);
  assert.equal(listJournal(store, { projectId: pid }).length, 1);
});

test('extraction：LLM 成功时把语义结果落库并标记回合已抽取', async (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  store.setSessionState('s-ext', { activeProjectId: pid });
  store.recordTurn({
    sessionId: 's-ext',
    turn: 1,
    userText: '我喜欢用 TypeScript 写工具，你记一下',
    assistantText: '已经完成语义管道实现并跑了测试',
    toolCalls: 3,
    reason: 'completed',
  });
  const llm = {
    available: true,
    callJson: async () => ({
      ok: true,
      json: {
        memories: [
          { type: 'preference', content: '主人喜欢用 TypeScript 写工具', confidence: 0.9 },
          { type: 'fact', content: '没有原句支撑的事实', confidence: 0.8 },
        ],
        projectUpdates: [{ kind: 'progress', summary: '完成语义管道实现并跑了测试' }],
      },
    }),
  };
  const controller = createExtractionController({
    store,
    config: testConfig({ extractDebounceMs: 0, extractMinIntervalMs: 0 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm,
  });
  t.after(() => controller.dispose());
  assert.equal(controller.considerTurn({}, 's-ext', 1), true);
  await controller.drain();
  const rows = store.listMemories({ limit: 10 });
  assert.equal(rows.length, 1);
  assert.equal(rows[0].content, '主人喜欢用 TypeScript 写工具');
  assert.equal(listEvidence(store, rows[0].id).length, 1);
  assert.equal(listJournal(store, { projectId: pid }).length, 1);
  assert.equal(store.isTurnExtracted('s-ext', 1), true);
});

test('extraction：LLM 失败时降级——不写记忆，只记程序侧工作日志', async (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  store.setSessionState('s-fail', { activeProjectId: pid });
  store.recordTurn({
    sessionId: 's-fail',
    turn: 1,
    userText: '把语义管道跑一下',
    assistantText: '跑完了，84/84 通过',
    toolCalls: 2,
    reason: 'completed',
  });
  const llm = { available: true, callJson: async () => ({ ok: false, reason: 'timeout' }) };
  const controller = createExtractionController({
    store,
    config: testConfig({ extractDebounceMs: 0, extractMinIntervalMs: 0 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm,
  });
  t.after(() => controller.dispose());
  controller.considerTurn({}, 's-fail', 1);
  await controller.drain();
  assert.equal(store.listMemories({ limit: 10 }).length, 0);
  assert.equal(listJournal(store, { projectId: pid }).length, 1, '应有程序侧兜底工作日志');
  assert.equal(store.isTurnExtracted('s-fail', 1), true);
  const stats = controller.stats();
  assert.ok(stats.journalFallbacks >= 1);
});

test('extraction：模型返回非 JSON 文本时降级，不应抛 ReferenceError', async (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  store.setSessionState('s-text', { activeProjectId: pid });
  store.recordTurn({
    sessionId: 's-text',
    turn: 1,
    userText: '把语义管道跑一下，然后告诉我结果',
    assistantText: '跑完了，84/84 通过',
    toolCalls: 1,
    reason: 'completed',
  });
  // 回归：v0.6.2 线上 8 次「语义抽取队列异常：clip is not defined」，
  // 根因是该分支裁剪模型原文时没导入 clip，ReferenceError 直接杀死队列。
  const llm = {
    available: true,
    callJson: async () => ({ ok: false, reason: 'invalid-json', text: '抱歉，我无法按要求输出 JSON。' }),
  };
  const warnings = [];
  const controller = createExtractionController({
    store,
    config: testConfig({ extractDebounceMs: 0, extractMinIntervalMs: 0 }),
    logger: { debug() {}, info() {}, warn: (...args) => warnings.push(args.join(' ')), error() {} },
    llm,
  });
  t.after(() => controller.dispose());
  controller.considerTurn({}, 's-text', 1);
  await controller.drain(); // 修复前这里会抛出 ReferenceError
  const joined = warnings.join('\n');
  assert.ok(!joined.includes('clip is not defined'), `不应再出现 clip 未定义：${joined}`);
  assert.ok(joined.includes('语义抽取失败'), `应记录失败警告：${joined}`);
  assert.equal(store.isTurnExtracted('s-text', 1), true, '失败回合也必须标记已抽取，避免重复补做');
  assert.equal(listJournal(store, { projectId: pid }).length, 1, '降级后仍要留程序侧工作日志');
});

test('extraction：关闭抽取时不调用模型、不经程序日志', async (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  store.setSessionState('s-off', { activeProjectId: pid });
  store.recordTurn({ sessionId: 's-off', turn: 1, userText: '随便聊聊今天天气', assistantText: '嗯，挺好', toolCalls: 0, reason: 'completed' });
  let called = 0;
  const llm = { available: true, callJson: async () => { called += 1; return { ok: true, json: {} }; } };
  const controller = createExtractionController({
    store,
    config: testConfig({ memoryExtraction: 'off', extractDebounceMs: 0 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm,
  });
  t.after(() => controller.dispose());
  assert.equal(controller.considerTurn({}, 's-off', 1), false);
  await controller.drain();
  assert.equal(called, 0);
  assert.equal(store.listMemories({ limit: 10 }).length, 0);
});

test('schema：v4 迁移幂等，旧库可打开并带 evidence/journal/judgments 表', (t) => {
  const { store, dir } = makeTempStore(t);
  const version = store.db.prepare('PRAGMA user_version').get();
  assert.equal(Number(version.user_version), 7);
  const tables = store.db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((row) => row.name);
  for (const name of ['memory_evidence', 'project_journal', 'relation_history', 'judgments']) {
    assert.ok(tables.includes(name), `应有 ${name} 表`);
  }
  store.close();
  const reopened = openStore(join(dir, 'soul.db'));
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.equal(Number(reopened.db.prepare('PRAGMA user_version').get().user_version), 7);
  reopened.close(); // 先放句柄，makeTempStore 的清理才能删掉目录（Windows）
});

// ── v0.6 恢复：进程重启后补做「未抽取回合」 ─────────────────────────
const silentLogger = { debug() {}, info() {}, warn() {}, error() {} };

test('恢复：有路由时补做遗留回合，并把回合标记为已抽取', async (t) => {
  const { store } = makeTempStore(t);
  const projectId = makeProject(store);
  store.markSession('s-rec', { origin: 'user', cwd: 'C:/work' });
  store.recordTurn({
    sessionId: 's-rec',
    turn: 1,
    userText: '记住：恢复测试的项目是 dsh-soul，今天做完语义管道。',
    assistantText: '已确认。',
    toolCalls: 0,
    reason: { kind: 'completed' },
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
  });
  store.setSessionState('s-rec', {
    lastUserText: '记住：恢复测试的项目是 dsh-soul，今天做完语义管道。',
    activeProjectId: projectId,
  });
  let calls = 0;
  const llm = {
    available: true,
    hasRoute: () => true,
    routeFor: () => ({ provider: 'test', model: 'test-model' }),
    onRoute: null,
    callJson: async () => {
      calls += 1;
      return {
        ok: true,
        json: {
          memories: [{
            // v0.6：project 类型属于「工作证据」而非用户事实，必须走 projectUpdates，
            // 因此这里用用户事实类型 preference，验证证据校验与落库链路。
            type: 'preference',
            content: '用户在推进 dsh-soul 语义管道',
            evidenceQuote: '记住：恢复测试的项目是 dsh-soul，今天做完语义管道。',
            confidence: 0.8,
          }],
          projectUpdates: [],
        },
      };
    },
  };
  const controller = createExtractionController({ store, config: testConfig(), logger: silentLogger, llm });
  t.after(() => controller.dispose());
  const recovered = controller.recoverPending();
  assert.ok(recovered >= 1, `应至少补做一个遗留回合，实际 ${recovered}`);
  await controller.drain();
  assert.equal(calls, 1, '应调用一次语义抽取');
  assert.equal(store.isTurnExtracted('s-rec', 1), true, '遗留回合应已标记抽取');
  assert.ok(
    store.listMemories({ limit: 10 }).some((memory) => memory.content.includes('dsh-soul')),
    '应写入抽取出的记忆',
  );
});

test('恢复：没有可用路由时不补做（避免误标已抽取）', async (t) => {
  const { store } = makeTempStore(t);
  store.markSession('s-noroute', { origin: 'user', cwd: 'C:/work' });
  store.recordTurn({
    sessionId: 's-noroute',
    turn: 1,
    userText: '记住：这条现在不该被抽取。',
    assistantText: '好。',
    toolCalls: 0,
    reason: { kind: 'completed' },
    startedAt: Date.now() - 1000,
    endedAt: Date.now(),
  });
  const llm = {
    available: true,
    hasRoute: () => false,
    routeFor: () => null,
    onRoute: null,
    callJson: async () => {
      throw new Error('should not be called');
    },
  };
  const controller = createExtractionController({ store, config: testConfig(), logger: silentLogger, llm });
  t.after(() => controller.dispose());
  assert.equal(controller.recoverPending(), 0);
  await controller.drain();
  assert.equal(store.isTurnExtracted('s-noroute', 1), false, '未抽取回合必须保持未标记');
});

test('extraction：同一回合重复入队只调用一次模型', async (t) => {
  const { store } = makeTempStore(t);
  const pid = makeProject(store);
  store.setSessionState('s-dedupe', { activeProjectId: pid });
  store.recordTurn({
    sessionId: 's-dedupe',
    turn: 1,
    userText: '记住我喜欢喝美式，不加糖。',
    assistantText: '好，记下了。',
    toolCalls: 0,
    reason: 'completed',
  });
  let calls = 0;
  const llm = {
    available: true,
    callJson: async () => {
      calls += 1;
      return { ok: true, json: { memories: [{ type: 'preference', content: '用户喜欢喝美式咖啡且不加糖', confidence: 0.9 }], projectUpdates: [] } };
    },
  };
  const controller = createExtractionController({
    store,
    config: testConfig({ extractDebounceMs: 0, extractMinIntervalMs: 0 }),
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    llm,
  });
  t.after(() => controller.dispose());
  controller.considerTurn({}, 's-dedupe', 1);
  controller.considerTurn({}, 's-dedupe', 1); // 模拟 onRoute 二次触发补做
  await controller.drain();
  assert.equal(calls, 1, '同一回合只应抽取一次');
  assert.equal(store.listMemories({ limit: 10 }).length, 1);
});

// 放在文件末尾，避免 import 顺序从 join 引入未使用告警时的困惑。
import { join } from 'node:path';
