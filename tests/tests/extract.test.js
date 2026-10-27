/** extract 层：显式记忆、纠正、偏好、临时情绪/问句/密钥过滤、关系识别、项目归类。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { extractCandidates, detectRelationship, classifyProjectNote, guessMemoryType, isTransient } from '../lib/memory/extract.js';

test('显式「记住」优先，置信度高且带 explicit 标记', () => {
  const candidates = extractCandidates('记住：我每周三晚上要做项目复盘');
  assert.equal(candidates.length, 1);
  assert.equal(candidates[0].kind, 'memory');
  assert.equal(candidates[0].source, 'user-explicit');
  assert.equal(candidates[0].confidence, 0.92);
  assert.match(candidates[0].content, /每周三/);
});

test('纠正信号单独成候选，用于取代旧记忆', () => {
  const candidates = extractCandidates('不对，我喜欢用 TypeScript 写工具，不是 Python');
  assert.ok(candidates.some((candidate) => candidate.kind === 'correction'), '应识别出纠正');
  const correction = candidates.find((candidate) => candidate.kind === 'correction');
  assert.equal(correction.source, 'user-correction');
  assert.match(correction.content, /TypeScript/);
});

test('临时情绪/问句不沉淀为长期记忆', () => {
  assert.deepEqual(extractCandidates('今天好累哈哈哈'), []);
  assert.deepEqual(extractCandidates('我喜欢什么？'), []);
  assert.equal(isTransient('今天好累'), true);
  assert.equal(isTransient('用户喜欢先看结论'), false);
});

test('疑似密钥不写入', () => {
  const candidates = extractCandidates('记住：我的 api_key 是 sk-abcdefghijklmnopqrstuvwxyz123456');
  assert.deepEqual(candidates, [], '含密钥的文本不应被抽取');
});

test('稳定偏好识别为 preference 类型', () => {
  const candidates = extractCandidates('我比较喜欢先看结论，再听分析');
  assert.ok(candidates.some((candidate) => candidate.type === 'preference'), '应识别出偏好');
});

test('交互偏好与关系事实分别归类', () => {
  const interaction = extractCandidates('以后别每次都问我还有没有其他需要');
  assert.ok(interaction.some((candidate) => candidate.type === 'interaction'), '应识别出交互偏好');

  const relation = extractCandidates('咱们的暗号是噢耶耶');
  assert.ok(relation.some((candidate) => candidate.type === 'relationship'), '应识别出关系事实');
});

test('区分事实/画像/决定类型', () => {
  assert.equal(guessMemoryType('用户喜欢先看结论'), 'preference');
  assert.equal(guessMemoryType('用户叫阿岚，在做 Agent 插件'), 'profile');
  assert.equal(guessMemoryType('决定用 SQLite 存长期记忆'), 'episodic');
});

test('关系设定识别：称呼、尺度、共同梗、边界', () => {
  const rel = detectRelationship('以后叫我阿岚，叫你小满；可以再亲密一点；咱们的暗号是接歌；别叫我宝贝');
  assert.equal(rel.userAlias, '阿岚');
  assert.equal(rel.agentAlias, '小满');
  assert.equal(rel.tone, '允许更亲密/暧昧一些');
  assert.ok(rel.sharedTerms.some((term) => /接歌/.test(term)));
  assert.ok(rel.boundaries.some((item) => /宝贝/.test(item)));
});

test('项目条目按措辞归类', () => {
  assert.equal(classifyProjectNote('决定用 SQLite 存长期记忆'), 'decision');
  assert.equal(classifyProjectNote('下一步要写自动化测试'), 'todo');
  assert.equal(classifyProjectNote('插件挂载跑通了'), 'done');
  assert.equal(classifyProjectNote('这个方案有点风险'), 'issue');
});
