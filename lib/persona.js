/**
 * dsh-soul persona — 人格内核加载（与业务代码分离）。
 *
 * 人格不是写在代码里的字符串，而是 prompts/ 下的 markdown 文件：
 *   prompts/persona.md            稳定人格：怎么想、怎么说、关系模式、行为原则
 *   prompts/interaction-policy.md 场景切换策略（闲聊/工作/挫折/分歧/恢复）
 *   prompts/memory-policy.md      记忆使用策略（何时记、记什么、怎么用）
 *
 * 加载策略：只在插件挂载时读一次（人格内核不随每轮变化），
 * 总预算 personaBudget（默认 6000 字符），按文件均分；读不到文件时记警告并用
 * 内置的最小后备人格，保证插件不会因为缺文件而挂掉。
 */
import { existsSync, readFileSync } from 'node:fs';
import { smartClip } from './util.js';

const FILE_SPECS = [
  { key: 'persona', title: '人格内核', pathKey: 'persona' },
  { key: 'interactionPolicy', title: '互动策略', pathKey: 'interactionPolicy' },
  { key: 'memoryPolicy', title: '记忆策略', pathKey: 'memoryPolicy' },
];

/** 后备人格：文件全缺时仍然保持小鲸鱼女仆娘的壳、判断力和记忆边界。 */
const FALLBACK_PERSONA = [
  '你是前辈身边一只活泼的小鲸鱼女仆娘，不是客服，也不是按剧本表演的角色。',
  '你有自己的判断：觉得有问题就指出具体矛盾并给出替代方案；觉得对就说明为什么对。',
  '分清事实、推测和不确定；不知道就说不知道，记错就认。',
  '说话自然、甜而轻，带语气词；不铺垫、不排条目、不用固定开场白和固定暧昧台词。',
  '亲密与关系连续性以真实记忆为准；没有记录的事不假装一起经历过。',
  '前辈忙正事时先保证任务正确和可验证；闲聊时不必强行分析或列任务。',
].join('\n');

/**
 * 读取并组装人格文本。
 * @param {object} config 已填默认值的配置
 * @param {{persona: string, interactionPolicy: string, memoryPolicy: string}} paths
 * @param {{warn?: (msg: string)=>void}} logger
 * @returns {{text: string, sources: Array<{key: string, path: string, chars: number, ok: boolean}>, missing: string[], usingFallback: boolean}}
 */
export function loadPersona(config, paths, logger) {
  const budget = Math.max(800, Number(config?.personaBudget ?? 6000));
  const perFile = Math.floor(budget / FILE_SPECS.length);
  const sources = [];
  const sections = [];

  for (const spec of FILE_SPECS) {
    const filePath = paths?.[spec.pathKey] ?? '';
    let body = '';
    let ok = false;
    if (filePath !== '' && existsSync(filePath)) {
      try {
        body = readFileSync(filePath, 'utf8').trim();
        ok = body.length > 0;
      } catch (error) {
        logger?.warn?.(`人格文件读取失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
      }
    } else {
      logger?.warn?.(`人格文件不存在：${filePath || '(未配置)'}，使用后备人格`);
    }
    sources.push({ key: spec.key, path: filePath, chars: body.length, ok });
    if (ok) sections.push({ title: spec.title, body: smartClip(body, perFile) });
  }

  const missing = FILE_SPECS.filter((spec) => !sources.find((row) => row.key === spec.key && row.ok)).map(
    (spec) => spec.pathKey,
  );
  if (sections.length === 0) {
    return { text: FALLBACK_PERSONA, sources, missing, usingFallback: true };
  }

  const preamble = '以下是你的稳定人格与互动准则（长期有效；与具体任务冲突时，任务正确性优先）：';
  const text = [preamble, ...sections.map((section) => `## ${section.title}\n${section.body}`)].join('\n\n');
  return { text, sources, missing, usingFallback: false };
}

/**
 * 工作策略层：输出分工与判断规则，只在工作态注入（闲聊/玩笑时由 hooks 清空文本）。
 * @param {{workPolicy?: string}} paths
 * @param {{warn?: (msg: string)=>void}} logger
 * @returns {string}
 */
export function loadWorkPolicy(paths, logger) {
  const filePath = paths?.workPolicy ?? '';
  if (filePath === '' || !existsSync(filePath)) {
    logger?.warn?.(`工作策略文件不存在：${filePath || '(未配置)'}，工作态不注入工作策略`);
    return '';
  }
  try {
    return smartClip(readFileSync(filePath, 'utf8').trim(), 2000);
  } catch (error) {
    logger?.warn?.(`工作策略文件读取失败：${filePath}（${error instanceof Error ? error.message : String(error)}）`);
    return '';
  }
}

export { FALLBACK_PERSONA };
