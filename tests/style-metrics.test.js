/** 语体指标：把「说话变味」变成可比对的数（lib/metrics/style.js）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { replyMetrics, fingerprint, createStyleRecorder } from '../lib/metrics/style.js';

test('电报体：无句末标点、空格黏连、句长被拉到整段', () => {
  const m = replyMetrics('嗯 不急 我看一下 晚点说 你先放着');
  assert.equal(m.noPunct, 1);
  assert.ok(m.gluePer100 > 0);
  assert.ok(m.avgSent > 10);
  assert.equal(m.bullets, 0);
});

test('正常话：有句末标点、无空格黏连、句子是短的', () => {
  const m = replyMetrics('主人，这个我先看过了。问题不在人格文件，是在注入的位置。我晚点把数拿给你看。');
  assert.equal(m.noPunct, 0);
  assert.equal(m.gluePer100, 0);
  assert.ok(m.avgSent < 30);
  assert.equal(m.sents, 3);
});

test('清单化能数出来：项目符号与标题各归其位', () => {
  const m = replyMetrics('结论：\n- 注入位置错了\n- 样本是零\n## 下一步\n改 pre-step');
  assert.equal(m.bullets, 2);
  assert.equal(m.headers, 1);
  assert.equal(m.lines, 5);
});

test('太短的应答不进统计', () => {
  assert.equal(replyMetrics('行'), null);
  assert.equal(replyMetrics('   '), null);
});

test('fingerprint 逐字敏感：改动一个字就换指纹', () => {
  assert.notEqual(fingerprint('注入块 A'), fingerprint('注入块 B'));
  assert.equal(fingerprint('同一段'), fingerprint('同一段'));
});

test('记录器：一行一条 JSONL，带注入指纹与任务态', (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-metrics-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = createStyleRecorder({ dir, tag: 'vtest', enabled: true });
  const entry = recorder.record({
    sessionId: 'onebot-private-1',
    turn: 7,
    origin: 'qq',
    intent: 'work',
    userText: '改一下这个脚本',
    injection: '【soul · 我记着的】关系背景……',
    reply: '主人，这个我改好了。跑了两遍都过。',
  });
  assert.equal(entry.tag, 'vtest');
  assert.equal(entry.regime, 'work');
  assert.equal(entry.origin, 'qq');
  assert.ok(entry.inj.chars > 5);
  assert.equal(entry.out.chars, 17);
  assert.equal(entry.out.sents, 2);
  const month = entry.t.slice(0, 7).replace('-', '');
  const file = join(dir, 'metrics', `style-${month}.jsonl`);
  const lines = readFileSync(file, 'utf8').trim().split('\n');
  assert.equal(lines.length, 1);
  assert.equal(JSON.parse(lines[0]).out.chars, 17);
});

test('关闭时一条都不写', (t) => {
  const dir = mkdtempSync(join(process.cwd(), '.tmp-metrics-off-'));
  t.after(() => rmSync(dir, { recursive: true, force: true }));
  const recorder = createStyleRecorder({ dir, enabled: false });
  assert.equal(recorder.record({ reply: '这是一句足够长的正常回复。' }), null);
  assert.equal(existsSync(join(dir, 'metrics')), false);
});
