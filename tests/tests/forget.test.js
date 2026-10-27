/** 遗忘层：14 天没被用到降权、30 天没被用到归档；你明确要求记的不归档。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';

const DAY = 86_400_000;

function age(store, id, days) {
  const at = Date.now() - days * DAY;
  store.db.prepare('UPDATE memories SET updated_at = ? WHERE id = ?').run(at, id);
}

test('遗忘：14 天没被用到降一档重要性，同一段沉默只降一次', (t) => {
  const { store } = makeTempStore(t);
  const memory = store.rememberMemory({ type: 'fact', content: '用户的咖啡是不加糖的' });
  const before = store.getMemory(memory.id).importance;
  age(store, memory.id, 20);

  const first = store.curate({ retentionDays: 90 });
  assert.equal(first.decayed, 1, '20 天没用到应该降一档');
  const after = store.getMemory(memory.id).importance;
  assert.ok(after < before, 'importance 应该下降');
  const raw = store.db.prepare('SELECT decayed_at FROM memories WHERE id = ?').get(memory.id);
  assert.ok(raw.decayed_at > 0, '应该记录降权时间');

  const second = store.curate({ retentionDays: 90 });
  assert.equal(second.decayed, 0, '同一段沉默不应重复降权');
  assert.equal(store.getMemory(memory.id).importance, after, '幂等');
});

test('遗忘：30 天没被用到且不是明确要求记的，归档', (t) => {
  const { store } = makeTempStore(t);
  const auto = store.rememberMemory({ type: 'fact', content: '用户上周在弄一个语音插件的活' });
  age(store, auto.id, 40);

  const result = store.curate({ retentionDays: 90 });
  assert.equal(result.forgotten, 1, '40 天没用到应归档');
  assert.equal(store.getMemory(auto.id).status, 'archived');
});

test('遗忘：你明确要求记住的（source=user-explicit）不归档', (t) => {
  const { store } = makeTempStore(t);
  const saved = store.rememberMemory({ type: 'profile', content: '用户叫洄的主人', source: 'user-explicit' });
  age(store, saved.id, 40);

  const result = store.curate({ retentionDays: 90 });
  assert.equal(result.forgotten, 0);
  assert.equal(store.getMemory(saved.id).status, 'active');
});

test('遗忘：归档后默认检索不再返回，显式带状态可以查到', (t) => {
  const { store } = makeTempStore(t);
  const old = store.rememberMemory({ type: 'fact', content: '用户以前用过一个叫阿里的云盘' });
  age(store, old.id, 40);
  store.curate({ retentionDays: 90 });

  const hits = store.searchMemories('阿里的云盘');
  assert.ok(!hits.some((row) => row.id === old.id), '默认检索不应返回归档记忆');
  assert.equal(store.getMemory(old.id).status, 'archived');
});

test('遗忘：只动记忆，项目与判断日志不受影响', (t) => {
  const { store } = makeTempStore(t);
  const project = store.upsertProject({ name: 'dsh-soul', goal: '长期记忆插件' });
  const judgment = store.recordJudgment({ kind: 'read', subject: '他在问进度', guess: '他想要个时间点' });
  const memory = store.rememberMemory({ type: 'fact', content: '用户说过要清理一下旧仓库' });
  age(store, memory.id, 40);

  store.curate({ retentionDays: 90 });
  assert.equal(store.getProject(project.id).name, 'dsh-soul', '项目不受遗忘影响');
  assert.equal(store.getJudgment(judgment).outcome, 'open', '判断日志不受遗忘影响');
  assert.equal(store.getMemory(memory.id).status, 'archived', '记忆照常归档');
});
