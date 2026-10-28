/**
 * dsh-soul config — 运行期路径解析与默认值。
 *
 * 真正的 Schema 在 lib/index.js（需要 top-level await 加载 @deepseek-ai/schemastery）。
 * 这里只放与 DSH 上下文无关的路径计算，供 index / 命令 / 测试共用。
 */
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { defaultDbPath } from './util.js';

/** 与 Config 默认值保持一致（测试与命令展示用）。 */
export const DEFAULT_CONFIG = Object.freeze({
  dbPath: '',
  personaSection: true,
  inject: true,
  injectBudget: 2000,
  queryMode: 'current_message',
  statusWindowDays: 7,
  memoryInjectCount: 8,
  memoryGapMinutes: 30,
  profileInject: true,
  // 记忆质量：候选机制 + 相似度阈值（这些值越低越激进，见 README「记忆质量」一节）
  candidateHits: 2,
  candidateConfirmLimit: 3,
  correctionThreshold: 0.22,
  conflictThreshold: 0.5,
  nearDuplicateThreshold: 0.7,
  enhancedExtraction: 'heuristic',
  // 语义记忆抽取（v0.6）：turn/end 后用宿主当前模型做结构化抽取，程序侧校验后落库；
  // 'off' 关闭抽取，'llm' 为默认。模型不可用时降级为程序侧项目工作日志，不猜测写记忆。
  memoryExtraction: 'llm',
  extractWindowTurns: 3,
  extractDebounceMs: 2500,
  extractMinIntervalMs: 15000,
  extractMaxTokens: 900,
  extractTimeoutMs: 30000,
  extractProvider: '',
  extractModel: '',
  extractRecoverHours: 72,
  // 多轮讨论后的共识/拍板：本地规则识别，不调模型（需要已有讨论上下文才记录）
  consensusExtraction: true,
  consensusMinTurns: 2,
  projectInject: true,
  projectInjectRelevance: true,
  projectAutoUpdate: true,
  relationMemory: true,
  capture: true,
  retentionDays: 30,
  tools: true,
  commands: true,
  skill: true,
  personaPath: 'prompts/persona.md',
  interactionPolicyPath: 'prompts/interaction-policy.md',
  memoryPolicyPath: 'prompts/memory-policy.md',
  workPolicyPath: 'prompts/work-policy.md',
  personaBudget: 6000,
  judgmentInject: true,
  styleRuleInject: true,
  forbiddenPatterns: [],
  // 跨会话接话：距上一条消息超过 recapWindowMinutes，就把上次最后 recapTurns 轮原话接回来。
  recapInject: true,
  recapWindowMinutes: 30,
  recapTurns: 3,
  // 本地梗库（cnmeme.wiki 公开快照）。空 = <数据目录>/memes.db；库缺失时工具降级，不影响插件运行。
  memeDb: '',
  // 情绪（v1.3）：一条全局状态，每轮注入一行；knock 插件读它决定「现在该不该开口」。
  // 时间演化：正面按 emotionDecayHours 半衰期回 0；负面每沉默 emotionNegativeHours 加深 emotionNegativeStep。
  emotionInject: true,
  emotionJudge: true,
  emotionDecayHours: 6,
  emotionNegativeHours: 12,
  emotionNegativeStep: 0.06,
  emotionFloor: -0.8,
  emotionSmoothAlpha: 0.3,
  emotionMaxStep: 0.3,
  emotionDebounceMs: 2000,
  emotionTimeoutMs: 15000,
  curationMinutes: 60,
  logLevel: 'info',
  logToFile: true,
  sensitivePolicy: 'skip',
});

/**
 * 解析插件运行期会用到的所有路径。
 * @param {object} config 已通过 Schema 默认值填充的配置
 * @param {string} packageRoot 插件包根目录（lib/ 的上一层）
 */
export function resolvePaths(config, packageRoot) {
  const dbPath = config?.dbPath ? resolve(String(config.dbPath)) : defaultDbPath();
  const dataDir = dirname(dbPath);
  return {
    packageRoot,
    dbPath,
    dataDir,
    logFile: join(dataDir, 'soul.log'),
    prompts: {
      persona: resolvePromptPath(config?.personaPath, packageRoot),
      interactionPolicy: resolvePromptPath(config?.interactionPolicyPath, packageRoot),
      memoryPolicy: resolvePromptPath(config?.memoryPolicyPath, packageRoot),
      workPolicy: resolvePromptPath(config?.workPolicyPath, packageRoot),
    },
    skill: join(packageRoot, 'skills', 'soul-workflow', 'SKILL.md'),
    memeDb: config?.memeDb ? resolve(String(config.memeDb)) : join(dataDir, 'memes.db'),
  };
}

/** 相对路径按包根目录解析；绝对路径原样使用。 */
export function resolvePromptPath(value, packageRoot) {
  if (typeof value !== 'string' || value.trim() === '') return '';
  return isAbsolute(value) ? value : resolve(packageRoot, value);
}
