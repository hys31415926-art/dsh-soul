/**
 * tests/wake-log.test.js — v1.6：记忆唤醒链路可观测。
 *
 * 覆盖三件事：
 *   · 每轮落一行元数据（不存正文），读回来字段对得上；
 *   · 淘汰原因分得清（同类配额 / 单条预算 / 渲染预算 / 没说找到）；
 *   · 只读一致性检查：健康时说健康，坏了要明确报失败，且不改库。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';
import { clearRetrievalCache, selectMemories } from '../lib/memory/retrieval.js';
import { renderContextBlock } from '../lib/memory/render.js';
import { installHooks } from '../lib/hooks.js';
import { fakeCommands } from './helpers.js';
import { registerCommand } from '../lib/commands/soul.js';

test('唤醒日志：写一行、读回来字段对得上', (t) => {
  const { store } = makeTempStore(t);
  const id = store.appendWakeLog({
    turnId: 7,
    sessionId: 's-1',
    at: 1_700_000_000_000,
    version: '1.6.0',
    mode: 'current_message',
    path: 'literal',
    cache: 'miss',
    candidates: [3, 5, 8],
    filtered: { wrongType: 1, excluded: [{ id: 8, reason: 'wrongType' }] },
    injectedIds: [3, 5],
    overBudgetIds: [9],
    sectionChars: { memories: 120 },
    budgetUsed: 340,
    budgetTotal: 2000,
    rendered: true,
    degraded: '',
    ms: 12,
  });
  assert.ok(id > 0);
  const log = store.recentWakeLogs({ sessionId: 's-1', limit: 1 })[0];
  assert.equal(log.turnId, 7);
  assert.equal(log.version, '1.6.0');
  assert.deepEqual(log.injectedIds, [3, 5]);
  assert.deepEqual(log.overBudgetIds, [9]);
  assert.deepEqual(log.candidates, [3, 5, 8]);
  assert.equal(log.filtered.wrongType, 1);
  assert.equal(log.filtered.excluded[0].reason, 'wrongType');
  assert.equal(log.sectionChars.memories, 120);
  assert.equal(log.budgetUsed, 340);
  assert.equal(log.rendered, true);
});

test('唤醒日志：参数残缺也不抛，默认值能落库', (t) => {
  const { store } = makeTempStore(t);
  const id = store.appendWakeLog();
  assert.ok(Number.isInteger(id) && id >= -1);
  assert.equal(store.wakeLogStats().total, 1);
});

test('诊断：同类配额挤掉的记忆能查到原因', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  const preferences = [
    '前辈喜欢早上喝美式咖啡',
    '前辈晚上喜欢听雨声',
    '前辈不爱吃香菜',
    '前辈喜欢深色界面',
    '前辈习惯把工具放在右手边',
    '前辈讨厌开会',
    '前辈喜欢猫',
    '前辈周末爱睡懒觉',
  ];
  for (const text of preferences) store.rememberMemory({ type: 'preference', content: text, importance: 0.6 });
  const result = selectMemories(store, { query: '', limit: 8, sessionId: 's-q' });
  const quota = (result.excluded ?? []).filter((item) => item.reason === 'typeQuota');
  assert.ok(quota.length >= 1, '同类型第 3 条起应记成 typeQuota');
  assert.ok(result.filtered.typeQuota >= 1);
  assert.ok(result.considered >= 8, 'considered 要能说明候选池有多大');
});

test('诊断：单条超预算单独记 ID', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  const long = '长'.repeat(120);
  store.rememberMemory({ type: 'fact', content: long, importance: 0.5 });
  store.rememberMemory({ type: 'fact', content: long + '二', importance: 0.5 });
  const result = selectMemories(store, { query: '', budgetChars: 80, limit: 5, sessionId: 's-b' });
  assert.ok(result.overBudgetIds.length >= 1, '放不进预算的要留下 ID');
  assert.ok((result.excluded ?? []).some((item) => item.reason === 'overBudget'));
});

test('渲染诊断：report 收集到预算与段落，dryRun 不改 retrieval.last', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  store.rememberMemory({ type: 'preference', content: '前辈喜欢安静的晚上', importance: 0.7 });
  store.metaSet('retrieval.last', 'sentinel-keep');
  const report = {};
  const text = renderContextBlock({
    store,
    config: testConfig({ memoryGapMinutes: 0 }),
    sessionId: 's-r',
    report,
    dryRun: true,
  });
  assert.equal(typeof text, 'string');
  assert.ok(['literal', 'popular'].includes(report.path), '路径要么字面要么热度：' + report.path);
  assert.equal(report.budget.total, 2000);
  assert.equal(report.rendered, text !== '');
  assert.ok(Array.isArray(report.injectedIds));
  assert.equal(String(store.metaGet('retrieval.last')), 'sentinel-keep', 'dryRun 不许写观测记录');
});

test('渲染诊断：跳过的回合给出跳过原因', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  const report = {};
  renderContextBlock({ store, config: testConfig({ inject: false }), sessionId: 's-skip', report, dryRun: true });
  assert.equal(report.memoryEnabled, false);
  assert.equal(report.skipReason, '配置关闭注入');
});

test('一致性检查：健康库返回 ok 且列出检查项', (t) => {
  const { store } = makeTempStore(t);
  const result = store.integrityCheck();
  assert.equal(result.ok, true);
  const names = result.checks.map((check) => check.name);
  for (const need of ['数据库连接', 'schema 版本', '必要表', '向量索引', '改口自洽', '唤醒日志']) {
    assert.ok(names.includes(need), '缺少检查项：' + need);
  }
});

test('一致性检查：改口指向不存在的新版本要明确失败', (t) => {
  const { store } = makeTempStore(t);
  const memory = store.rememberMemory({ type: 'fact', content: '前辈住在杭州', importance: 0.5 });
  store.db.prepare('UPDATE memories SET superseded_by = 99999 WHERE id = ?').run(memory.id);
  const result = store.integrityCheck();
  assert.equal(result.ok, false);
  const broken = result.checks.find((check) => check.name === '改口自洽');
  assert.equal(broken.status, 'fail');
  assert.match(broken.detail, /不存在/u);
});

test('唤醒日志按行数上限裁剪', (t) => {
  const { store } = makeTempStore(t);
  const now = Date.now();
  // 行数上限最小 100：写满 120 行，看旧的 20 行被裁掉、新的留着。
  for (let index = 0; index < 120; index += 1) {
    store.appendWakeLog({ turnId: index + 1, sessionId: 's-t', at: now - (120 - index) * 1000, injectedIds: [index + 1] });
  }
  const pruned = store.pruneWakeLogs({ keepRows: 100, keepDays: 30, now });
  assert.equal(pruned.byAge, 0, '都是新行，不该按时间裁');
  assert.equal(pruned.byCount, 20);
  assert.equal(pruned.remaining, 100);
  const logs = store.recentWakeLogs({ limit: 200 });
  assert.equal(logs.length, 100);
  assert.equal(logs[0].turnId, 120, '保留最新的行');
  assert.equal(logs[logs.length - 1].turnId, 21, '最旧的 20 行被裁掉');
});

test('hooks：组装提示词后，回合收尾落一行唤醒日志', (t) => {
  clearRetrievalCache();
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  const logger = { debug() {}, info() {}, warn() {}, error() {} };
  installHooks(ctx, store, testConfig({ memoryGapMinutes: 0, memoryExtraction: 'off' }), logger);
  const session = makeSession('s-wake');
  store.rememberMemory({ type: 'fact', content: '启动慢的问题通常是孤儿进程抢 CPU', importance: 0.8 });
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 4 } });
  ctx.emit('session/event', session, userMessageEvent('启动慢的问题怎么排查，我怀疑是孤儿进程抢 CPU，想确认一下'));
  const assembly = { contexts: [] };
  ctx.emit('system-prompt/assemble', assembly, { agent: { session } }, () => {});
  assert.ok(assembly.contexts.some((item) => item.name === 'dsh-soul:context'), '这一轮应注入上下文');
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 4, reason: { kind: 'stop' } } });
  const logs = store.recentWakeLogs({ sessionId: 's-wake', limit: 1 });
  assert.equal(logs.length, 1, '收尾应落一行');
  assert.equal(logs[0].turnId, 4);
  assert.equal(logs[0].rendered, true);
  assert.ok(logs[0].injectedIds.length >= 1, '注入的 ID 要落下来');
  assert.equal(logs[0].budgetTotal, 2000);
});

test('hooks：没组装过提示词的回合不写日志（不虚构注入）', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig({ memoryExtraction: 'off' }), { debug() {}, info() {}, warn() {}, error() {} });
  const session = makeSession('s-nolog');
  ctx.emit('session/event', session, { type: 'turn/start', data: { turn: 1 } });
  ctx.emit('session/event', session, { type: 'turn/end', data: { turn: 1, reason: { kind: 'stop' } } });
  assert.equal(store.recentWakeLogs({ sessionId: 's-nolog', limit: 5 }).length, 0);
});

function mountCommands(t) {
  const { store } = makeTempStore(t);
  const commands = fakeCommands();
  const ctx = makeCtx({ commands });
  registerCommand(ctx, { store, config: testConfig(), paths: { dbPath: 'C:/tmp/soul.db', dataDir: 'C:/tmp', logFile: '' }, personaInfo: { sources: [] }, version: '1.6.0', logger: { debug() {}, info() {}, warn() {}, error() {} } });
  const run = (rawInput) => commands.definitions[0].handler({ agent: { session: { id: 's-cmd' } }, rawInput });
  return { store, run };
}

test('命令：/soul plan 只预览不落库，/soul why 没历史时给明确提示', (t) => {
  clearRetrievalCache();
  const { store, run } = mountCommands(t);
  store.rememberMemory({ type: 'fact', content: '启动慢的问题通常是孤儿进程抢 CPU', importance: 0.8 });
  const plan = run('plan 启动慢怎么排查');
  assert.equal(plan.kind, 'success');
  assert.match(plan.text, /预览|预算/u);
  assert.equal(store.metaGet('retrieval.last') ?? '', '', '预览不许写历史');
  const why = run('why');
  assert.match(why.text, /还没有|没有历史/u);
});

test('命令：/soul diagnose 能按记忆查淘汰原因，/soul check 报一致，status 带唤醒日志行', (t) => {
  const { store, run } = mountCommands(t);
  const memory = store.rememberMemory({ type: 'fact', content: '启动慢的问题通常是孤儿进程抢 CPU', importance: 0.8 });
  store.appendWakeLog({ turnId: 3, sessionId: 's-cmd', at: Date.now(), mode: 'current_message', path: 'literal', cache: 'miss', injectedIds: [], filtered: { excluded: [{ id: memory.id, reason: 'typeQuota' }] }, rendered: false, degraded: 'hardCap' });
  const diagnose = run('diagnose memory:#' + memory.id);
  assert.equal(diagnose.kind, 'success');
  assert.match(diagnose.text, /typeQuota|同类/u);
  const check = run('check');
  assert.match(check.text, /一致/u);
  const status = run('status');
  assert.match(status.text, /唤醒日志：1 行/u);
});
