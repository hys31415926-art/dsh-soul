/** v2 学习闭环：输出守卫、行为规则、提示词正向化、注入优先级（可验证工程事实）。 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { makeCtx, makeSession, makeTempStore, testConfig, userMessageEvent } from './helpers.js';
import { openStore } from '../lib/memory/store.js';
import {
  findForbidden,
  recordGuardHits,
  sanitizeAssistantOutput,
} from '../lib/output-guard.js';
import { analyzeFeedbackSignal, classifyFeedbackSignal } from '../lib/style-signal.js';
import { addStyleExample, selectStyleAnchors } from '../lib/memory/style-examples.js';
import { enrichTurn } from '../lib/memory/extract.js';
import { applySemanticResult } from '../lib/memory/semantic.js';
import { renderContextBlock } from '../lib/memory/render.js';
import { loadPersona } from '../lib/persona.js';
import { installHooks } from '../lib/hooks.js';

const ROOT = fileURLToPath(new URL('..', import.meta.url));
const NL = String.fromCharCode(10);
const FENCE = String.fromCharCode(96, 96, 96);
const readPrompt = (name) => fs.readFileSync(join(ROOT, 'prompts', name), 'utf8');

test('输出守卫：清洗代码之外的禁用套话，保留代码原样', () => {
  const raw = ['好的，收下了。', FENCE + 'js', 'const a = "收下了";', FENCE, '我查了一下，就这样。'].join(NL);
  const result = sanitizeAssistantOutput(raw);
  assert.equal(result.changed, true);
  assert.ok(result.text.includes('const a = "收下了"'));
  assert.ok(!result.text.split(NL)[0].includes('收下了'));
  assert.ok(!result.text.includes('我查了一下'));
  assert.deepEqual(result.hits.map((hit) => hit.key).sort(), ['banned_phrase_shou_xia_le', 'banned_query_narration']);
  assert.equal(findForbidden('我保证以后不这样').length, 1);
  assert.equal(sanitizeAssistantOutput('好的，收下了，，。').text, '好的。');
});

test('输出守卫：支持 config 扩展正则，并把命中累计进 guard_hits', (t) => {
  const { store } = makeTempStore(t);
  const result = sanitizeAssistantOutput('这个粉红大象又来了', { config: { forbiddenPatterns: ['粉红大象'] } });
  assert.equal(result.text, '这个又来了');
  assert.equal(result.hits.length, 1);
  recordGuardHits(store, result.hits, { now: 123 });
  recordGuardHits(store, result.hits, { now: 456 });
  const stats = store.stats().guardHits;
  assert.equal(stats.total, 2);
  assert.equal(stats.lastAt, 456);
});

test('行为规则：同 turnId 不重复计证据，第二个独立回合才转 active', (t) => {
  const { store } = makeTempStore(t);
  const input = {
    rule: '直接说事和判断，少用客服式开场',
    scene: '',
    category: 'mechanical_tone',
    turnId: 7,
    weight: 1,
  };
  const first = store.upsertBehaviorRule(input);
  assert.equal(first.status, 'candidate');
  assert.equal(first.evidenceCount, 1);
  const again = store.upsertBehaviorRule(input);
  assert.equal(again.counted, false);
  assert.equal(again.evidenceCount, 1);
  const second = store.upsertBehaviorRule({ ...input, turnId: 8 });
  assert.equal(second.status, 'active');
  assert.equal(second.evidenceCount, 2);
});

test('行为规则：显式指令直接 active、下一轮注入；disable 后消失，重开库仍持久', (t) => {
  const { store, path } = makeTempStore(t);
  const saved = store.upsertBehaviorRule({
    rule: '被指出问题时直接给修正后的结论，跳过自我检讨',
    scene: '',
    category: 'self_analysis_apology',
    isExplicit: true,
    turnId: 3,
  });
  assert.equal(saved.status, 'active');
  assert.ok(saved.evidenceCount >= 1.5);

  const config = testConfig({ relationMemory: false, inject: false, styleAnchor: false, projectInject: false });
  const rendered = renderContextBlock({ store, config, sessionId: 's', query: '帮我改一下这段代码' });
  assert.ok(rendered.includes('这轮先这样做'));
  assert.ok(rendered.includes(saved.rule));

  store.setStyleRuleStatus(saved.id, 'disabled');
  const hidden = renderContextBlock({ store, config, sessionId: 's', query: '帮我改一下这段代码' });
  assert.ok(!hidden.includes(saved.rule));

  store.close();
  const reopened = openStore(path);
  t.after(() => { try { reopened.close(); } catch { /* closed */ } });
  assert.equal(reopened.findStyleRule(saved.id).status, 'disabled');
  const afterReopen = renderContextBlock({ store: reopened, config, sessionId: 's', query: '帮我改一下这段代码' });
  assert.ok(!afterReopen.includes(saved.rule));
});

test('行为规则：rollback 回滚新规则并恢复上一条 superseded', (t) => {
  const { store } = makeTempStore(t);
  const oldRule = store.upsertBehaviorRule({ rule: '直接说结论，不铺垫背景', scene: '', category: 'mechanical_tone', isExplicit: true, turnId: 1 });
  const newRule = store.upsertBehaviorRule({ rule: '先给判断，再给一条关键理由', scene: '', category: 'mechanical_tone', isExplicit: true, turnId: 2 });
  assert.equal(store.findStyleRule(oldRule.id).status, 'superseded');
  const result = store.rollbackStyleRule(newRule.id);
  assert.equal(result.restored.id, oldRule.id);
  assert.equal(store.findStyleRule(oldRule.id).status, 'active');
  assert.equal(store.findStyleRule(newRule.id).status, 'superseded');
});

test('样本库：命中禁用表达拒收；negative 永不进锚点', (t) => {
  const { store } = makeTempStore(t);
  assert.equal(addStyleExample(store, { text: '好的，收下了，我查了一下。', scene: 'chat' }), null);
  const positive = addStyleExample(store, { text: '这个我想了一下，确实得先把缓存那层拆开看。', kind: 'positive', scene: 'chat' });
  addStyleExample(store, { text: '这句太生硬了，像说明书一样冷冰冰。', kind: 'negative', scene: 'chat' });
  const anchors = selectStyleAnchors(store, { scene: 'chat', limit: 4 });
  assert.deepEqual(anchors.map((item) => item.id), [positive.id]);
  const rendered = renderContextBlock({
    store,
    config: testConfig({ relationMemory: false, inject: false, projectInject: false }),
    sessionId: 's',
    query: '随便聊聊',
  });
  assert.ok(rendered.includes('确实得先把缓存那层拆开看'));
  assert.ok(!rendered.includes('像说明书一样冷冰冰'));
});

test('抽取：助手口径的承诺套话不能借「下一步」进入候选记忆', () => {
  const blocked = enrichTurn({ assistantText: '下一步：我会盯着这个任务，弄好了告诉你。' });
  assert.deepEqual(blocked, []);
  const kept = enrichTurn({ assistantText: '下一步：先跑一遍全量测试，再看失败项。' });
  assert.equal(kept.length, 1);
  assert.ok(kept[0].content.includes('全量测试'));
});

test('抽取：语义抽取结果里的助手套话不落库', (t) => {
  const { store } = makeTempStore(t);
  const stats = applySemanticResult(store, {
    result: { memories: [{ type: 'fact', content: '好的，收下了', confidence: 0.9 }], projectUpdates: [], rejected: [] },
  });
  assert.equal(stats.created.length, 0);
  assert.ok(stats.rejected >= 1);
  assert.equal(store.listMemories().some((memory) => memory.content.includes('收下了')), false);
});

test('语体信号：40 字以上、分句的批评仍能识别并归类，显式指令强度更高', () => {
  const long = '你这次回复真的太像说明书了，一上来就分点列条，语气冷冰冰的，看着就像客服模板。以后别再这么写了，我要的是正常聊天。';
  assert.ok(long.length > 40);
  const implicit = analyzeFeedbackSignal('又像说明书了，冷冰冰的');
  assert.equal(implicit.signal, 'correction');
  assert.equal(implicit.category, 'mechanical_tone');
  assert.equal(implicit.explicit, false);
  const explicit = analyzeFeedbackSignal(long);
  assert.equal(explicit.signal, 'correction');
  assert.equal(explicit.category, 'mechanical_tone');
  assert.equal(explicit.explicit, true);
  assert.ok(explicit.strength >= 1.5);
  assert.equal(classifyFeedbackSignal('这句说得好，但是我觉得这个方案还有几个问题需要一起看一下比如缓存失效和重试策略'), null);
});

test('行为规则：P1 默认最多取 6 条，按证据权重与更新时间倒序', (t) => {
  const { store } = makeTempStore(t);
  const saved = [];
  for (let i = 1; i <= 7; i += 1) {
    saved.push(store.upsertBehaviorRule({
      rule: `规则 ${i}：直接说清楚这一条的具体要求`,
      scene: '',
      category: `test_category_${i}`,
      isExplicit: true,
      turnId: i,
      weight: 1 + i / 10,
      now: 1000 + i,
    }));
  }
  const active = store.activeStyleRules({ scene: 'chat' });
  assert.equal(active.length, 6);
  assert.deepEqual(active.map((rule) => rule.rule), saved.slice(1).reverse().map((rule) => rule.rule));
});

test('提示词：称呼统一、无固定播报、无引号禁词表，System Prompt 不出现「收下了」', () => {
  const files = ['persona.md', 'interaction-policy.md', 'memory-policy.md', 'work-policy.md'];
  const all = files.map((name) => readPrompt(name)).join(NL);
  assert.ok(all.includes('前辈'), '提示词应统一称呼为「前辈」');
  assert.ok(!all.includes('主人'), '提示词不该再出现旧称呼「主人」');
  assert.ok(!all.includes('人格层只负责壳'));
  assert.ok(!all.includes('这块好了，下块做什么'));
  assert.ok(!all.includes('收下了'), '提示词里不该出现带引号的禁用词');
  assert.ok(all.includes('不使用固定播报句式'));

  const persona = loadPersona(testConfig(), {
    persona: join(ROOT, 'prompts', 'persona.md'),
    interactionPolicy: join(ROOT, 'prompts', 'interaction-policy.md'),
    memoryPolicy: join(ROOT, 'prompts', 'memory-policy.md'),
  });
  assert.equal(persona.usingFallback, false);
  assert.ok(persona.text.includes('小鲸鱼女仆娘'));
  assert.ok(!persona.text.includes('收下了'));
});

test('hooks 闭环：用户批评生成正向规则而不是记骂人原话；助手输出被清洗并计数', (t) => {
  const { store } = makeTempStore(t);
  const ctx = makeCtx();
  installHooks(ctx, store, testConfig(), { debug() {}, info() {}, warn() {}, error() {} });
  const session = makeSession('s-feedback');
  ctx.emit('session/event', session, {
    type: 'turn/start',
    data: { turn: 1 },
  });
  const assistantMessage = {
    type: 'assistant/message',
    data: { message: { role: 'assistant', content: [{ type: 'text', text: '好的，收下了。我查了一下。' }] } },
  };
  ctx.emit('session/event', session, assistantMessage);
  assert.equal(assistantMessage.data.message.content[0].text.includes('收下了'), false);
  assert.equal(store.stats().guardHits.total, 2);

  store.recordTurn({ sessionId: 's-feedback', turn: 1, userText: '随便聊聊', assistantText: '好的。' });
  ctx.emit('session/event', session, userMessageEvent('以后别这么像说明书了，开头别铺垫，冷冰冰的。'));
  const rules = store.listStyleRules();
  assert.equal(rules.length, 1);
  assert.match(rules[0].rule, /直接|结论|修正/);
  assert.equal(store.listMemories().some((memory) => memory.content.includes('说明书')), false);
});
