/** project-manager / relationship 层：项目解析与切换、进展自动归类、关系状态合并。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { makeTempStore } from './helpers.js';
import {
  PROJECT_STATUSES, activeProject, addProjectEntry, addTask, maybeRecordProjectNote,
  resolveProject, switchProject, taskLine, upsertProject,
} from '../lib/core/project-manager.js';
import { applyRelationshipSignals, relationLine } from '../lib/relationship/continuity.js';

test('项目：按名字/id 解析，切换后 activeProject 生效', (t) => {
  const { store } = makeTempStore(t);
  const project = upsertProject(store, { name: '小说《长夜》', goal: '写完全书', stage: '第一卷' });
  assert.equal(resolveProject(store, '小说《长夜》').id, project.id);
  assert.equal(resolveProject(store, String(project.id)).id, project.id);
  assert.equal(resolveProject(store, '不存在的项目'), null);

  assert.equal(activeProject(store, 's-1'), null);
  switchProject(store, 's-1', '小说《长夜》');
  assert.equal(activeProject(store, 's-1').name, '小说《长夜》');
  assert.equal(store.getSessionState('s-1').activeProjectId, project.id);
  assert.ok(PROJECT_STATUSES.includes(project.status));
});

test('项目进展：有活跃项目时记录，无项目时不误建', (t) => {
  const { store } = makeTempStore(t);
  assert.equal(maybeRecordProjectNote(store, 's-1', '决定用 SQLite 存记忆'), null, '没有项目时不应乱建');

  const project = upsertProject(store, { name: 'dsh-soul', goal: '长期伙伴插件' });
  switchProject(store, 's-1', String(project.id));
  const saved = maybeRecordProjectNote(store, 's-1', '决定用 SQLite 存长期记忆');
  assert.equal(saved.kind, 'decision');
  assert.equal(saved.project.id, project.id);

  const items = store.listProjectItems(project.id, { kind: 'decision' });
  assert.match(items[0].content, /SQLite/);
});

test('任务：创建与展示行含目标/状态/验收', (t) => {
  const { store } = makeTempStore(t);
  const project = upsertProject(store, { name: 'p', goal: 'g' });
  const task = addTask(store, { projectId: project.id, title: '写测试', priority: 1, acceptance: 'node --test 全绿' });
  const line = taskLine(task);
  assert.match(line, /写测试/);
  assert.match(line, /pending/);
  assert.match(line, /node --test/);
});

test('关系：称呼/尺度/梗/边界合并，不覆盖已有值', (t) => {
  const { store } = makeTempStore(t);
  store.setRelation({ userAlias: '主人' });

  const applied = applyRelationshipSignals(store, { sessionId: 's-1', text: '叫你鱼，可以再亲密一点，咱们的暗号是噢耶耶' });
  assert.ok(applied.length >= 2, '应识别出多个关系设定');
  const relation = store.getRelation();
  assert.equal(relation.userAlias, '主人', '未在本轮出现的称呼应保留');
  assert.equal(relation.agentAlias, '鱼');
  assert.match(relation.tone, /亲密/);
  assert.match(relation.sharedTerms, /噢耶耶/);

  const line = relationLine(relation);
  assert.match(line, /主人|鱼/);
});

test('关系：重复设定幂等，不重复写记忆', (t) => {
  const { store } = makeTempStore(t);
  const first = applyRelationshipSignals(store, { sessionId: 's-1', text: '叫你鱼' });
  const before = store.memoryCounts().active;
  const second = applyRelationshipSignals(store, { sessionId: 's-1', text: '叫你鱼' });
  assert.equal(second.length, 0, '相同设定不应重复应用');
  assert.equal(store.memoryCounts().active, before, '相同设定不应重复写记忆');
  assert.ok(first.length >= 1);
});
