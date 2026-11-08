/**
 * v1.8 第三处借鉴：提示词版本。
 * 前辈改了 prompts/*.md 之后，我应当在下一轮注入里看到一行「文本变了」，
 * 而不是悄悄换了语气、自己也说不清为什么。第一次记录只存不提示。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { takePromptNotice, trackPromptVersions } from '../lib/persona.js';
import { makeTempStore } from './helpers.js';

function makePromptDir(t, bodies = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-soul-prompts-'));
  t.after(() => rmSync(dir, { recursive: true, force: true, maxRetries: 3 }));
  const paths = {
    persona: join(dir, 'persona.md'),
    interactionPolicy: join(dir, 'interaction-policy.md'),
    memoryPolicy: join(dir, 'memory-policy.md'),
    workPolicy: join(dir, 'work-policy.md'),
  };
  for (const [key, filePath] of Object.entries(paths)) {
    writeFileSync(filePath, bodies[key] ?? `# ${key}\n初始文本\n`, 'utf8');
  }
  return { dir, paths };
}

test('提示词版本：第一次只记录指纹，不打扰', (t) => {
  const { store } = makeTempStore(t);
  const { paths } = makePromptDir(t);
  const first = trackPromptVersions(store, paths);
  assert.deepEqual(first.changed, []);
  assert.equal(first.notice, '');
  const saved = JSON.parse(store.metaGet('prompts.digests'));
  assert.equal(typeof saved.persona, 'string');
  assert.equal(saved.persona.length, 12);
});

test('提示词版本：改过的文件出现在提示里，没改的不出现', (t) => {
  const { store } = makeTempStore(t);
  const { paths } = makePromptDir(t);
  trackPromptVersions(store, paths);
  writeFileSync(paths.persona, '# persona\n改过的文本\n', 'utf8');
  const second = trackPromptVersions(store, paths);
  assert.deepEqual(second.changed, ['persona']);
  assert.match(second.notice, /人格内核/);
  assert.doesNotMatch(second.notice, /互动策略/);
  store.metaSet('prompts.notice', second.notice);
  assert.match(takePromptNotice(store), /提示词已更新/);
  // 取过一次就清掉，不会每轮都念
  assert.equal(takePromptNotice(store), '');
});

test('提示词版本：文本写回原样时不再算变更', (t) => {
  const { store } = makeTempStore(t);
  const { paths } = makePromptDir(t);
  trackPromptVersions(store, paths);
  const before = JSON.parse(store.metaGet('prompts.digests')).persona;
  writeFileSync(paths.persona, '# persona\n临时改一下\n', 'utf8');
  trackPromptVersions(store, paths);
  writeFileSync(paths.persona, '# persona\n初始文本\n', 'utf8');
  const again = trackPromptVersions(store, paths);
  assert.deepEqual(again.changed, ['persona']);
  assert.equal(JSON.parse(store.metaGet('prompts.digests')).persona, before);
});

test('提示词版本：文件全缺时安静返回', (t) => {
  const { store } = makeTempStore(t);
  const result = trackPromptVersions(store, {});
  assert.deepEqual(result.changed, []);
  assert.equal(result.notice, '');
  assert.equal(takePromptNotice(store), '');
});
