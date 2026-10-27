import { readFileSync, writeFileSync, renameSync, existsSync, mkdirSync, cpSync } from 'node:fs';
import { join } from 'node:path';

const root = 'C:/Users/HP/Desktop/work/soul-build';
const read = (p) => readFileSync(join(root, p), 'utf8');
const write = (p, s) => writeFileSync(join(root, p), s, 'utf8');

function patch(file, pairs) {
  let text = read(file);
  for (const [from, to] of pairs) {
    if (!text.includes(from)) throw new Error(`${file}: 找不到片段 >>> ${from.slice(0, 80)}`);
    text = text.replace(from, to);
  }
  write(file, text);
  console.log('patched', file);
}

// ── 2. render.js：合并注入块标题 + 风格/自我认知段 ────────────────
patch('lib/memory/render.js', [
  [
    "import { buildStyleHint, classifyTurn, hasSubstantiveQuery, projectRelevance, shouldIncludeOpenQuestion } from '../core/conversation-policy.js';",
    "import { buildStyleHint, classifyTurn, hasSubstantiveQuery, projectRelevance, shouldIncludeOpenQuestion } from '../core/conversation-policy.js';\nimport { styleSummaryOf } from './style.js';",
  ],
  [
    "  const styleHint = buildStyleHint(intent, queryText, state);",
    "  const styleHint = buildStyleHint(intent, queryText, state);\n  const soulStyle = styleSummaryOf(store);\n  const selfModel = String(store.metaGet('soul.selfModel') ?? '').trim();",
  ],
  [
    "  const hasAnything = relationText !== '' || projectText !== '' || memText !== '' || includeQuestion || styleHint !== '';",
    "  const soulBits = [];\n  if (soulStyle !== '') soulBits.push(`主人的说话习惯（本地统计，只用来调语气，不是人设）：${soulStyle}`);\n  if (selfModel !== '') soulBits.push(`我对自己的认知（随时间微调，别当固定人设背）：${clip(selfModel, 90)}`);\n  const soulText = soulBits.length > 0 ? soulBits.join('\\n') : '';\n\n  const hasAnything = relationText !== '' || projectText !== '' || memText !== '' || includeQuestion || styleHint !== '' || soulText !== '';",
  ],
  [
    "  if (relationText !== '') sections.push({ key: 'relation', text: relationText, budget: plan.relation });",
    "  if (relationText !== '') sections.push({ key: 'relation', text: relationText, budget: plan.relation });\n  if (soulText !== '') sections.push({ key: 'soul', text: soulText, budget: 200 });",
  ],
  [
    "  const header = '【dsh-soul · 背景资料】以下是长期记忆、项目档案与关系设定里可能与当前这句话相关的一小部分。它们只用来帮你理解背景、调整语气：多数时候不需要提到、复述或汇报；主人没有问起的事，不要主动展开。与当前对话冲突时，以主人当前的说法为准。';",
    "  const header = '【soul · 我记着的】以下是我对这段关系的长期记忆、项目档案和相处习惯里可能与当前这句话相关的一小部分。它们只用来帮你理解背景、调整语气：多数时候不需要提到、复述或汇报；主人没有问起的事，不要主动展开。与当前对话冲突时，以主人当前的说法为准。';",
  ],
  [
    "    `dsh-soul v${version} — ${store.path}`,",
    "    `soul v${version} — ${store.path}`,",
  ],
]);

// ── 3. hooks.js：每轮记一次说话习惯 ──────────────────────────────
patch('lib/hooks.js', [
  [
    "import { createExtractionController } from './memory/extraction.js';",
    "import { createExtractionController } from './memory/extraction.js';\nimport { recordStyle } from './memory/style.js';",
  ],
  [
    "    store.setSessionState(sessionId, { lastUserText: clip(text, 200) });",
    "    store.setSessionState(sessionId, { lastUserText: clip(text, 200) });\n    // 说话习惯统计（句长/表情/口头禅）：本地零成本，只用来调语气，不写长期记忆。\n    try { recordStyle(store, text); } catch { /* 统计失败不影响对话 */ }",
  ],
]);

// ── 4. tools.js：新增 soul_episodes / soul_learn / soul_self ─────
patch('lib/tools.js', [
  ["import { clip } from './util.js';", "import { clip, formatTime } from './util.js';"],
  [
    "  register(defineTool({\n    name: 'soul_session',",
    `  register(defineTool({
    name: 'soul_episodes',
    description: '读最近的原始用户回合（跨会话，新的在前），每条含当时的用户原话和你的回答摘要。用于「复盘一下」「整理记忆」：先看原始回合，再决定哪些值得沉淀；平时不用调。',
    parameters: {
      limit: { type: 'number', description: '读取条数，默认 20，最多 50' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => true,
    execute: async (args) => {
      const limit = Math.min(50, Math.max(1, Number(args.limit ?? 20)));
      const turns = store.recentTurns(limit);
      const lines = [];
      for (const turn of [...turns].reverse()) {
        lines.push(\`[\${formatTime(turn.createdAt)}] 用户：\${clip(turn.userText ?? '', 120)}\`);
        if (turn.assistantText) lines.push(\`  你回：\${clip(turn.assistantText, 60)}\`);
      }
      return { count: turns.length, text: lines.length > 0 ? lines.join('\\n') : '（还没有记录）' };
    },
  }));

  register(defineTool({
    name: 'soul_learn',
    description: '把一条可复用的做法/结论沉淀进知识库（例如「某插件的安装步骤」「某报错的根因」「某命令的正确用法」）。和 soul_remember 分工：事实记人和事，这里记怎么做。重复沉淀同一标题会合并命中次数，不会增生。',
    parameters: {
      title: { type: 'string', required: true, description: '简短标题（≤30 字），用于检索与去重' },
      body: { type: 'string', required: true, description: '结论正文：命令、路径、判据，尽量具体' },
      tags: { type: 'string', description: '空格分隔的标签，可选' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args, exec) => {
      const title = String(args.title ?? '').trim();
      if (title === '') throw new Error('soul_learn: title 不能为空');
      const body = String(args.body ?? '').trim();
      if (body === '') throw new Error('soul_learn: body 不能为空');
      const saved = store.rememberMemory({
        type: 'fact',
        content: clip(\`\${title}｜\${body}\`, 500),
        tags: \`knowledge \${String(args.tags ?? '')}\`.trim(),
        source: 'tool',
        confidence: 0.75,
        sessionId: sessionIdOf(exec) || undefined,
      });
      return { id: saved.id, text: \`沉淀 #\${saved.id}：\${clip(title, 60)}（第 \${saved.hits} 次命中）\` };
    },
  }));

  register(defineTool({
    name: 'soul_self',
    description: '更新「我是谁」的自我认知：一段≤120 字的话，写自己这段时间的定位、语气、边界与还在学的东西。会随记忆块一起注入，所以要短、要具体，别写成口号。',
    parameters: {
      text: { type: 'string', required: true, description: '自我认知正文（≤120 字）' },
    },
    output: textOutput((value) => value.text),
    isConcurrencySafe: () => false,
    execute: async (args) => {
      const text = String(args.text ?? '').trim();
      if (text === '') throw new Error('soul_self: text 不能为空');
      store.metaSet('soul.selfModel', clip(text, 120));
      return { text: \`自我认知已更新：\${clip(text, 120)}\` };
    },
  }));

  register(defineTool({
    name: 'soul_session',`,
  ],
]);

// ── 5. 文件/目录改名 ─────────────────────────────────────────────
if (existsSync(join(root, 'lib/commands/companion.js'))) renameSync(join(root, 'lib/commands/companion.js'), join(root, 'lib/commands/soul.js'));
if (existsSync(join(root, 'skills/companion-workflow'))) renameSync(join(root, 'skills/companion-workflow'), join(root, 'skills/soul-workflow'));
console.log('renamed commands/soul.js, skills/soul-workflow');
