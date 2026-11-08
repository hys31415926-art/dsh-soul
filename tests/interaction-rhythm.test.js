/**
 * 互动节奏补丁 v1 的静态回归：锁住 prompts/interaction-policy.md 的三处替换，
 * 并确认工作态的可靠性约束没有被顺手改掉。
 *
 * 行为层面的前后对照需要重启 DSH 后单独做，这个文件只负责「文本确实换了、
 * 该留的确实还在、注入预算没被撑爆」。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { loadPersona } from '../lib/persona.js';

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const promptPath = path.join(root, 'prompts', 'interaction-policy.md');
const readPrompt = () => readFileSync(promptPath, 'utf8');

test('旧的「每轮先选一个主要目的」整节已被替换', () => {
  const text = readPrompt();
  assert.ok(!text.includes('## 每轮先选一个主要目的'));
  assert.ok(!text.includes('只选一个主要目的回应'));
  assert.ok(text.includes('## 接话与对话节奏'));
  assert.ok(text.includes('先接住眼前最明确的互动'));
  assert.ok(text.includes('不要为了丰富而硬塞第二个动作'));
  assert.ok(text.includes('不要刻意制造错误来表演随性'));
});

test('旧的「回应前的轻量判断」整节已被替换', () => {
  const text = readPrompt();
  assert.ok(!text.includes('## 回应前的轻量判断（只在事情不简单时过一遍'));
  assert.ok(!text.includes('这句话真正想要什么：闲聊、一起想、执行、创作，还是做决定？'));
  assert.ok(text.includes('## 复杂情况才做轻量判断'));
  assert.ok(text.includes('不要把它变成普通聊天的固定流水线'));
  assert.ok(text.includes('不得因为追求自然而跳过必要的执行与核验'));
});

test('日常闲聊 bullet 换成从眼前互动接话，并保留版权边界', () => {
  const text = readPrompt();
  assert.ok(!text.includes('- 日常闲聊：话可以短，也可以就接一句'));
  assert.ok(text.includes('- 日常闲聊：顺着眼前正在发生的事自然接话'));
  assert.ok(text.includes('不长篇复现受版权保护的歌词'));
});

test('工作态约束没被连带改掉', () => {
  const text = readPrompt();
  assert.ok(text.includes('- 任务执行：先确认验收标准和现状，再动手'));
  assert.ok(text.includes('用真实工具结果证明完成，无法验证就说没验证'));
  assert.ok(text.includes('不做跨会话后台值守承诺'));
  // 补丁明确要求：只放松闲聊，不减少工作任务所需的分析、核验与汇报。
  assert.ok(text.includes('只放松闲聊的表达规划'));
  assert.ok(text.includes('不减少明确工作任务所需的分析、核验、工具执行、风险判断、测试与结果汇报'));
});

test('补丁没有引入随机跑题、固定字数、情绪标签这类硬约束', () => {
  const text = readPrompt();
  for (const banned of ['不超过', '必须带', '每轮情绪', '固定口癖']) {
    assert.ok(!text.includes(banned), `不该出现「${banned}」`);
  }
  // 「不要为了显得像活人而随机跑题」是反向约束，允许存在；这里只禁「要求随机跑题」的说法。
  assert.ok(!/要求.{0,6}随机跑题/u.test(text));
});

test('人格注入总预算没被撑破，且三份文件都读到了', () => {
  const paths = {
    persona: path.join(root, 'prompts', 'persona.md'),
    interactionPolicy: promptPath,
    memoryPolicy: path.join(root, 'prompts', 'memory-policy.md'),
  };
  const info = loadPersona({}, paths, { warn() {} });
  assert.equal(info.usingFallback, false);
  assert.deepEqual(info.missing, []);
  // 总预算 6000，按文件均分；这里只保证没触到截断线。
  for (const source of info.sources) {
    assert.ok(source.ok, `${source.key} 应该读到内容`);
    assert.ok(source.chars <= 2000, `${source.key} 单文件超过 2000 字符会被截断`);
  }
  assert.ok(info.text.length > 3000);
  assert.ok(info.text.includes('接话与对话节奏'));
  assert.ok(!info.text.includes('每轮先选一个主要目的'));
});
