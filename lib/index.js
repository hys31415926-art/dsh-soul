/**
 * dsh-soul — DSH 长期伙伴 Agent 插件入口。
 *
 * 设计要点（与 m00001 任务书一致）：
 *   · 不修改 DSH 核心，不另起独立服务；一切能力构建在宿主公开扩展点上：
 *       · 人格      → systemPrompt.section（静态 section，只加载一次）
 *       · 动态上下文 → system-prompt/assemble 事件（每轮按需注入记忆/项目/关系）
 *       · 记忆写入   → session/event 记录原始回合；turn/end 后由语义抽取（宿主当前模型）
 *                      产出结构化记忆/项目日志，经程序侧证据校验后落库（lib/memory/semantic.js）
 *       · 生产力     → ctx.tools 注册 soul_* 工具（复用宿主文件/终端/搜索能力）
 *       · 管理入口   → /soul 命令（commands 服务可用时）
 *       · 工作流     → soul-workflow 技能（skills 服务可用时）
 *   · 人格与业务代码分离：人格文本来自 prompts/*.md，挂载时读一次。
 *   · 长期记忆落在 DSH_HOME 下的 SQLite（默认 <DSH_HOME>/dsh-soul/soul.db），
 *     与会话记录解耦，重启/换会话/上下文压缩后仍可检索。
 *   · 所有可选能力都做了缺失降级：宿主没装 commands/skills 时只记警告，不让插件挂掉。
 *
 * 成本模型：注入块硬上限 injectBudget（默认 2000 字符）；语义抽取每回合最多一次轻量模型调用
 * （默认 900 maxTokens、15s 最小间隔、全局串行，失败即降级），后台整理只做本地 SQL。
 */
import { copyFileSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_CONFIG, resolvePaths } from './config.js';
import { createLogger } from './logger.js';
import { loadPersona, loadWorkPolicy } from './persona.js';
import { openStore } from './memory/store.js';
import { installHooks } from './hooks.js';
import { createLlmClient } from './memory/llm-client.js';
import { createEmbedder } from './memory/embed.js';
import { syncEmbeddings } from './memory/vecindex.js';
import { registerTools } from './tools.js';
import { registerCommand } from './commands/soul.js';
import { registerSkill } from './skill.js';
import { openMemeDb } from './meme.js';
import { createEmotionTracker } from './emotion.js';
import { createStyleRecorder } from './metrics/style.js';

const packageRoot = dirname(dirname(fileURLToPath(import.meta.url)));

/**
 * 合并前的记忆库（旧 dsh-companion / 旧 dsh-soul）不继承：先备份成
 * `<db>.pre-merge-<ts>.bak`，再删掉主库与 WAL，由新插件重建空库。
 *
 * 判断依据是 meta 里有没有 plugin.version：
 * - 没有 → 是合并前的库（或从未初始化），归档一次；
 * - 有（任何版本号）→ 已经是本插件的库，一律保留，表结构升级交给 MIGRATIONS。
 * 早期实现比对了版本号，结果每次升级都会把整库归档重建，40 轮历史和记忆被清空——已修。
 */
function archivePreviousDb(dbPath, logger) {
  try {
    if (!existsSync(dbPath)) return false;
    let initialized = false;
    try {
      const db = new DatabaseSync(dbPath, { readOnly: true });
      try {
        const rows = db.prepare("SELECT v FROM meta WHERE k = 'plugin.version'").all();
        initialized = rows.length > 0;
      } finally {
        db.close();
      }
    } catch {
      initialized = false;
    }
    if (initialized) return false;
    const stamp = new Date().toISOString().replace(/[:.]/g, '-');
    const archive = dbPath + '.pre-merge-' + stamp + '.bak';
    copyFileSync(dbPath, archive);
    for (const suffix of ['', '-wal', '-shm']) {
      const file = dbPath + suffix;
      if (existsSync(file)) rmSync(file, { force: true });
    }
    logger.info('检测到合并前的记忆库，已备份到 ' + archive + ' 并重建空库');
    return true;
  } catch (error) {
    logger.warn('旧库备份/重建失败，继续尝试直接打开：', error?.message ?? error);
    return false;
  }
}

let z;
try {
  ({ default: z } = await import('@deepseek-ai/schemastery'));
} catch (error) {
  console.error(
    '[dsh-soul] 挂载失败：缺少 peer 依赖 @deepseek-ai/schemastery —— 插件必须装在 DSH profile 内（pnpm add / 复制到 profile 的 node_modules），不能孤立复制 lib/。',
  );
  throw error;
}

export const name = 'dsh-soul';
export const inject = ['systemPrompt', 'tools'];

export const Config = z.object({
  // ── 存储 ────────────────────────────────────────────────
  dbPath: z.string().default('')
    .description('记忆库路径；留空 = <DSH_HOME>/dsh-soul/soul.db'),
  // ── 注入 ────────────────────────────────────────────────
  personaSection: z.boolean().default(true)
    .description('是否把人格内核注册为 system prompt section（关掉后人格文件不会注入）'),
  inject: z.boolean().default(true)
    .description('是否每轮按需注入长期记忆/项目状态/关系状态'),
  injectBudget: z.number().default(2000)
    .description('每轮注入块字符预算（默认 2000，中文约 ~1200 token；900 会偏紧，3000+ 适合项目很多时）'),
  memoryInjectCount: z.number().default(8)
    .description('每轮注入最多几条长期记忆（默认 8）'),
  recapInject: z.boolean().default(true)
    .description('距上一条消息够久时，是否把上次最后几轮原话接回来（跨会话接话）'),
  recapWindowMinutes: z.number().default(30)
    .description('间隔多少分钟算「久别」，超过才注入上次聊天（默认 30）'),
  recapTurns: z.number().default(3)
    .description('接话时带几轮原话（默认 3 轮，最多 6 条消息）'),
  emotionInject: z.boolean().default(true)
    .description('是否把「我现在的心情」注入每一轮（中性时不注入；给 knock 提供情绪来源）'),
  emotionJudge: z.boolean().default(true)
    .description('是否在每条用户消息后异步判定情绪（关掉后情绪只按时间演化，不再更新）'),
  emotionDecayHours: z.number().default(6)
    .description('正面情绪回到「轻松」的半衰期（小时，默认 6）'),
  emotionNegativeHours: z.number().default(12)
    .description('负面情绪多久没被安抚就加深一档（小时，默认 12）'),
  emotionNegativeStep: z.number().default(0.06)
    .description('每次加深多少（0-1，默认 0.06）'),
  emotionFloor: z.number().default(-0.8)
    .description('负面情绪的下限（默认 -0.8，不会无限恶化）'),
  embeddingRetrieval: z.boolean().default(true)
    .description('是否用本地向量做语义检索（换种说法也能想起相关记忆）；关掉退回纯字面'),
  embeddingModel: z.string().default('Xenova/bge-small-zh-v1.5')
    .description('本地向量模型（transformers.js 模型 id；换模型需要重建索引）'),
  embeddingThreshold: z.number().default(0.5)
    .description('语义召回的余弦阈值（0-1，默认 0.5；太高会漏，太低会召回反义句）'),
  candidateHits: z.number().default(2)
    .description('自动抽取的候选记忆重复出现几次后自动转正（默认 2）'),
  candidateConfirmLimit: z.number().default(3)
    .description('用户说「就这么办/对，就是这样」时，最多把几条本会话候选转正（默认 3）'),
  correctionThreshold: z.number().default(0.22)
    .description('相似度达到多少视为「用户纠正的旧版本」，纠正时取代旧记忆（0-1，默认 0.22）'),
  conflictThreshold: z.number().default(0.5)
    .description('相似度达到多少视为「同一件事的新旧版本」，写入时取代旧版本（0-1，默认 0.5）'),
  nearDuplicateThreshold: z.number().default(0.7)
    .description('相似度达到多少视为重复表述，只强化旧条目而不新增（0-1，默认 0.7）'),
  enhancedExtraction: z.string().default('heuristic')
    .description('（v0.5 兼容字段，已不参与写记忆）回合结束增强抽取；v0.6 起改由 memoryExtraction 的语义抽取负责'),
  memoryExtraction: z.string().default('llm')
    .description('语义记忆抽取：llm = 用宿主当前模型做结构化抽取（默认）；off = 关闭（只记回合摘要）'),
  extractWindowTurns: z.number().default(3)
    .description('每次语义抽取看最近几个回合（用户原话 + 助手行为 + 工具调用）'),
  extractDebounceMs: z.number().default(2500)
    .description('回合结束后等多久再发起抽取（毫秒）：连续回合会合并成一次'),
  extractMinIntervalMs: z.number().default(15000)
    .description('同一时刻全局串行；两次抽取之间至少间隔多少毫秒（控成本）'),
  extractMaxTokens: z.number().default(900)
    .description('抽取调用最多生成多少 token（默认 900）'),
  extractTimeoutMs: z.number().default(30000)
    .description('抽取调用超时（毫秒），超时即降级，不阻塞对话'),
  extractProvider: z.string().default('')
    .description('抽取用模型提供方（留空 = 跟当前会话同一路由）'),
  extractModel: z.string().default(''),
  extractRecoverHours: z.number().default(72)
    .description('抽取用模型（留空 = 跟当前会话同一模型）'),
  consensusExtraction: z.boolean().default(true)
    .description('是否识别多轮讨论后的共识/拍板，写成候选记忆与项目决定（本地规则，不调模型）'),
  consensusMinTurns: z.number().default(2)
    .description('会话里至少已记录几个真实回合后，才把一句「就这么定」当作共识（默认 2）'),
  projectInject: z.boolean().default(true)
    .description('是否注入当前项目状态'),
  projectInjectRelevance: z.boolean().default(true)
    .description('只在与当前话题相关时注入项目状态（v0.3 默认开；关掉则每轮都注入）'),
  projectAutoUpdate: z.boolean().default(true)
    .description('是否把对话里识别出的决策/待办/问题自动写进项目档案'),
  relationMemory: z.boolean().default(true)
    .description('是否注入关系连续性状态（称呼、尺度、共同梗、边界）'),
  styleRuleInject: z.boolean().default(true)
    .description('是否注入从反馈里沉淀的 active 行为规则（candidate/superseded/disabled 永不注入）'),
  forbiddenPatterns: z.array(z.union([z.string(), z.object({ key: z.string().default(''), pattern: z.string(), flags: z.string().default('u') })])).default([])
    .description('额外禁用的表达（用于输出守卫与正向样本过滤）；字符串按字面匹配，{key,pattern,flags} 按正则'),
  // ── 记忆写入 ────────────────────────────────────────────
  capture: z.boolean().default(true)
    .description('是否从会话事件中抽取并写入长期记忆'),
  retentionDays: z.number().default(30)
    .description('原始回合保留天数（超期在后台整理时裁剪）'),
  // ── 能力开关 ────────────────────────────────────────────
  tools: z.boolean().default(true)
    .description('是否注册 soul_* 工具'),
  commands: z.boolean().default(true)
    .description('是否注册 /soul 管理命令（需要宿主 commands 服务）'),
  skill: z.boolean().default(true)
    .description('是否注册 soul-workflow 技能（需要宿主 skills 服务）'),
  // ── 人格文件 ────────────────────────────────────────────
  personaPath: z.string().default('prompts/persona.md')
    .description('人格内核文件，相对包根目录或绝对路径'),
  interactionPolicyPath: z.string().default('prompts/interaction-policy.md')
    .description('场景互动策略文件'),
  memoryPolicyPath: z.string().default('prompts/memory-policy.md')
    .description('记忆使用策略文件'),
  workPolicyPath: z.string().default('prompts/work-policy.md')
    .description('工作策略文件：只在工作态注入（闲聊回合由 hooks 清空）'),
  personaBudget: z.number().default(6000)
    .description('三个提示文件合计字符预算（默认 6000）'),
  // ── 梗库 ────────────────────────────────────────────────
  memeDb: z.string().default('')
    .description('本地梗库路径（cnmeme.wiki 公开快照）；空 = <数据目录>/memes.db'),
  // ── 运维 ────────────────────────────────────────────────
  styleMetrics: z.boolean().default(true)
    .description('逐回合记录语体指标到数据目录 metrics/*.jsonl（本地、零模型调用，用来对比人格/注入改动前后的差别）'),
  curationMinutes: z.number().default(60)
    .description('后台整理间隔（分钟）：衰减旧记忆、裁剪原始回合；0 = 关闭'),
  logLevel: z.string().default('info')
    .description('日志级别 debug/info/warn/error'),
  logToFile: z.boolean().default(true)
    .description('是否把日志写入数据目录下的 soul.log'),
  sensitivePolicy: z.string().default('skip')
    .description('敏感信息策略：skip = 不写入长期记忆'),
});

/** 读取插件自身版本（失败不影响挂载）。 */
function pluginVersion() {
  try {
    const raw = readFileSync(join(packageRoot, 'package.json'), 'utf8');
    return String(JSON.parse(raw)?.version ?? '0.1.0');
  } catch {
    return '0.1.0';
  }
}

export function apply(ctx, config) {
  const cfg = { ...DEFAULT_CONFIG, ...(config ?? {}) };
  const paths = resolvePaths(cfg, packageRoot);
  const logger = createLogger({ ctx, file: paths.logFile, level: cfg.logLevel, toFile: cfg.logToFile });
  const version = pluginVersion();
  const disposers = [];
  const closed = { value: false };

  const dispose = () => {
    if (closed.value) return;
    closed.value = true;
    for (const fn of disposers.splice(0).reverse()) {
      try { fn(); } catch (error) {
        logger.warn(`资源释放失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    }
    try { store?.close(); } catch { /* 关闭失败不抛出 */ }
  };

  let store;
  try {
    archivePreviousDb(paths.dbPath, logger);
    store = openStore(paths.dbPath);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`记忆库初始化失败：${paths.dbPath}（${message}）`);
    throw new Error(`dsh-soul: 记忆库初始化失败（${paths.dbPath}）：${message}`);
  }

  try {
    store.metaSet('plugin.version', version);
    store.metaSet('last_loaded_at', String(Date.now()));
    logger.info(`已挂载 v${version}；记忆库 ${paths.dbPath}；数据目录 ${paths.dataDir}`);

    // 1) 人格内核：静态 section，挂载时注册一次；宿主重载时整体重建。
    const personaInfo = loadPersona(cfg, paths.prompts, logger);
    if (personaInfo.missing.length > 0) {
      logger.warn(`人格文件缺失：${personaInfo.missing.join(', ')}${personaInfo.usingFallback ? '（已用后备人格）' : '（其余文件正常加载）'}`);
    }
    if (cfg.personaSection) {
      disposers.push(
        ctx.effect(() => {
          let order = 1;
          try {
            order = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 1;
          } catch { /* 旧版本没有该常量时退化到 1 */ }
          return ctx.systemPrompt.section({
            name: 'dsh-soul:persona',
            order,
            text: personaInfo.text,
          });
        }, 'dsh-soul:persona-section'),
      );
    } else {
      logger.info('personaSection=false：人格内核不注入 system prompt');
    }

    // 1.5) 工作策略层：输出分工与判断规则，只在工作态出现。
    // 文本常驻 section；闲聊回合由 hooks 把 text 清空，宿主渲染时会丢弃空 section。
    const workPolicyText = loadWorkPolicy(paths.prompts, logger);
    if (workPolicyText !== '') {
      disposers.push(
        ctx.effect(() => {
          let order = 2;
          try {
            order = ctx.systemPrompt.getSectionOrder('DEPLOYMENT_PERSONA_PREFIX') + 2;
          } catch { /* 旧版本没有该常量时退化到 2 */ }
          return ctx.systemPrompt.section({
            name: 'dsh-soul:work-policy',
            order,
            text: workPolicyText,
          });
        }, 'dsh-soul:work-policy-section'),
      );
      logger.info(`工作策略层：已加载 ${workPolicyText.length} 字（仅工作态注入）`);
    } else {
      logger.info('工作策略层未加载：工作态不会注入输出分工与判断规则');
    }

    // 2) 语义抽取的模型客户端（监听 llm/stream 拿当前会话路由；不可用时只降级不报错）。
    const llm = createLlmClient(ctx, cfg, logger);
    disposers.push(() => llm.dispose());
    logger.info(
      `语义抽取：${cfg.memoryExtraction === 'off' ? '关闭' : 'llm'}（模型客户端${llm.available ? '已就绪' : '待首次会话请求捕获路由'}，恢复窗口 ${cfg.extractRecoverHours}h）`,
    );
    store.metaSet('extraction.enabled', cfg.memoryExtraction === 'off' ? 'off' : 'llm');

    // 3) 本地向量（语义检索）：懒加载，装不上就退回字面；启动后后台回填索引。
    const embedder = cfg.embeddingRetrieval === false
      ? null
      : createEmbedder({ model: cfg.embeddingModel, cacheDir: join(paths.dataDir, 'models'), logger });
    if (embedder) {
      logger.info(`语义检索：开（模型 ${cfg.embeddingModel}，阈值 ${cfg.embeddingThreshold}）`);
      const timer = setTimeout(() => {
        syncEmbeddings(store, embedder.embed, {
          logger,
          turnDays: Math.max(7, Number(cfg.retentionDays) || 30),
        }).catch((error) => logger.warn('向量索引回填失败：', error?.message ?? error));
      }, 3000);
      timer.unref?.();
      disposers.push(() => clearTimeout(timer));
    } else {
      logger.info('语义检索：关（只做字面检索）');
    }

    // 4) 动态上下文 + 会话写入钩子 + 语义抽取调度 + 情绪判定。
    const emotion = createEmotionTracker({ store, config: cfg, logger, llm });
    disposers.push(() => emotion.dispose());
    const metrics = createStyleRecorder({
      dir: paths.dataDir,
      tag: `v${version}`,
      enabled: cfg.styleMetrics !== false,
      logger,
    });
    if (metrics.enabled) logger.info(`语体指标：开（${join(paths.dataDir, 'metrics')}）`);
    const hooksDisposer = installHooks(ctx, store, cfg, logger, llm, embedder, emotion, { metrics });
    disposers.push(hooksDisposer);

    // 3) 生产工具（复用宿主的文件/终端能力，不新增权限绕过）。
    if (cfg.tools) {
      const memeDb = openMemeDb(paths.memeDb, logger);
      if (cfg.memeDb || existsSync(paths.memeDb)) {
        logger.info(memeDb ? `梗库已加载：${paths.memeDb}` : `梗库缺失或打不开：${paths.memeDb}（soul_meme 降级）`);
      }
      disposers.push(registerTools(ctx, store, cfg, paths, personaInfo, version, memeDb, emotion));
    } else {
      logger.info('tools=false：soul_* 工具未注册');
    }

    // 4) /soul 管理命令。
    if (cfg.commands) {
      disposers.push(registerCommand(ctx, {
        store,
        config: cfg,
        paths,
        personaInfo,
        version,
        logger,
        emotion,
        extraction: hooksDisposer?.extraction ?? null,
      }));
    }

    // 5) soul-workflow 技能。
    if (cfg.skill) {
      disposers.push(registerSkill(ctx, { paths, logger }));
    }

    // 6) 后台整理：挂载时补一次，之后按间隔执行（unref 不阻塞宿主退出）。
    const curate = () => {
      try {
        const result = store.curate({ retentionDays: Number(cfg.retentionDays) || 30 });
        if (result && (result.prunedTurns > 0 || result.archived > 0)) {
          logger.debug(`后台整理：裁剪回合 ${result.prunedTurns} 条，归档记忆 ${result.archived} 条`);
        }
      } catch (error) {
        logger.warn(`后台整理失败（${error instanceof Error ? error.message : String(error)}）`);
      }
    };
    curate();
    const minutes = Number(cfg.curationMinutes ?? 0);
    let timer = null;
    if (Number.isFinite(minutes) && minutes > 0) {
      timer = setInterval(curate, Math.max(5, minutes) * 60_000);
      timer.unref?.();
      disposers.push(() => { if (timer) clearInterval(timer); });
    }

    return dispose;
  } catch (error) {
    dispose();
    const message = error instanceof Error ? error.message : String(error);
    logger.error(`启动失败：${message}`);
    throw new Error(`dsh-soul: 启动失败（${message}）`);
  }
}

export { openStore };
