/**
 * v0.5 回归：修复「被指出问题 → 分析自己 → 认错 → 保证 → 反问」的机械回应模式。
 *
 * 这些断言只检查可验证的工程事实，不依赖模型自评：
 *  1. 对话方式被吐槽的句子会被识别为 feedback，且不注入背景资料；
 *  2. 工作请求、普通闲聊不会被误判成 feedback；
 *  3. 三条提示词里确实写入了行为约束（且没有把手误变成「禁词表」）。
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { classifyTurn } from '../lib/core/conversation-policy.js';
import { renderContextBlock } from '../lib/memory/render.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const readPrompt = (name) => fs.readFileSync(path.join(ROOT, 'prompts', name), 'utf8');

const FEEDBACK_SENTENCE = '你说话怎么又像说明书了？我说一句你分析一句，然后认错又保证，最后还反问我。';

function fakeStore(overrides = {}) {
  return {
    getRelation: () => ({
      turns: 20,
      firstSeen: Date.now() - 86_400_000 * 5,
      tone: '允许更亲密/暧昧一些',
      boundaries: '不要把一次玩笑固化成关系偏好',
      sharedTerms: '哦耶耶接歌',
    }),
    getSessionState: () => ({ activeProjectId: 1, lastUserText: '', openQuestion: '要不要更新' }),
    projectSnapshot: () => ({
      project: { name: 'dsh-soul', goal: '交付插件', stage: '阶段三', status: 'active', lastTouchedAt: Date.now() },
      byKind: { todo: [{ content: '改提示词' }], decision: [] },
    }),
    sessionCount: () => 2,
    metaGet: () => '',
    metaSet: () => {},
    ...overrides,
  };
}

test('被吐槽说话方式 → feedback（轻对话），不误判成工作请求', () => {
  const intent = classifyTurn(FEEDBACK_SENTENCE, {});
  assert.equal(intent.kind, 'feedback');
  assert.equal(intent.light, true);
  assert.equal(intent.work, false);
  assert.equal(classifyTurn('你看又来说明了', {}).kind, 'feedback');
});

test('工作请求 / 普通闲聊的意图不被 feedback 抢走', () => {
  assert.equal(classifyTurn('帮我把 README 改一下', {}).kind, 'work');
  assert.equal(classifyTurn('刚在楼下看到一只三花猫，蹲在电动车座上不肯下来。', {}).kind, 'chat');
  assert.equal(classifyTurn('今天天气不错，晒了会儿太阳。', {}).kind, 'casual');
  assert.equal(classifyTurn('在吗？', {}).kind, 'casual');
});

test('feedback 回合不注入背景资料（关系/项目/记忆都不塞），只给最小行为提示', () => {
  const store = fakeStore();
  const text = renderContextBlock({ store, config: {}, sessionId: 's', query: FEEDBACK_SENTENCE });
  assert.ok(text.includes('主人在说你的说话方式本身'));
  assert.ok(!text.includes('项目背景'));
  assert.ok(!text.includes('关系背景'));
  assert.ok(!text.includes('可能相关的旧信息'));
});

test('非 feedback 的工作询问仍然注入背景（确认不是整体关掉）', () => {
  const store = fakeStore({ getSessionState: () => ({ activeProjectId: 1, lastUserText: '', openQuestion: '' }) });
  const text = renderContextBlock({
    store,
    config: { inject: false, relationMemory: false },
    sessionId: 's',
    query: 'dsh-soul 那个项目现在进度怎么样了？',
  });
  assert.ok(text.includes('我记着的'));
  assert.ok(text.includes('项目背景'));
});

test('提示词写进了行为约束，且没有把用户的例子变成「禁词表」', () => {
  const policy = readPrompt('interaction-policy.md');
  assert.ok(policy.includes('不套固定回复结构'));
  assert.ok(policy.includes('被评价'));
  assert.ok(policy.includes('被说「测试一下」'));
  assert.ok(policy.includes('不承诺'));
  assert.ok(!policy.includes('「行 / 认 / 陪 / 收到」'));

  const persona = readPrompt('persona.md');
  assert.ok(persona.includes('小鲸鱼女仆娘'));
  assert.ok(persona.includes('称呼用「主人」'));
  assert.ok(persona.includes('不挂「我改」这种保证'));

  const memoryPolicy = readPrompt('memory-policy.md');
  assert.ok(memoryPolicy.includes('工程要求'));
});

test('L1 身份层瘦身：工作策略拆到独立文件，闲聊回合不出现', () => {
  const persona = readPrompt('persona.md');
  const work = readPrompt('work-policy.md');
  assert.ok(persona.includes('小鲸鱼女仆娘'));
  assert.ok(!persona.includes('输出分工'), 'persona.md 不该再带输出分工');
  assert.ok(!persona.includes('判断规则'), 'persona.md 不该再带判断规则');
  assert.ok(!persona.includes('subagent'), 'persona.md 不该再带工作流转');
  assert.ok(work.includes('输出分工'));
  assert.ok(work.includes('判断规则'));
  assert.ok(work.includes('subagent'));
  assert.ok(persona.replace(/\s/g, '').length <= 500, 'L1 身份层应控制在 500 字以内');
});
