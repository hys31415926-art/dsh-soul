# dsh-soul

DSH（DeepSeek Harness）的长期记忆 + 人设插件。合并了早期 dsh-companion 的完整记忆/项目能力，和 dsh-soul 的轻量常驻风格，现在只有一个包。

常驻但不打扰：人格三份 md 挂载时读一次；每轮注入块 2000 字硬上限；自动抽取只处理用户明确表达的内容；后台整理是纯本地 SQL，不额外调模型。

v1.3.1 修了学习证据链：同一回合不重复扣分；负评只归责真正注入过或文字高度重合的样本，无匹配不扣分；助手自评只提候选，不给自己发认可。`/soul replay` 可回放历史反馈。

v1.2 加了两件让记忆「像真的记得」的事：

- **跨会话接话**：距上一条消息超过 30 分钟，再开口时会把上次最后 3 轮原话接回来（刚聊完不重复，因为那段还在上下文里）。
- **语义检索**：本地小模型（bge-small-zh，512 维，ONNX）把记忆和对话原话变成向量；「屋里别太冷」也能找到「用户怕冷，空调别开太低」。模型装不上就自动退回字面检索，不报错。

## 安装

1. 源码目录：`C:/Users/HP/dsh-plugins/dsh-soul`
2. profile 的 `package.json`：dependencies 加 `"dsh-soul": "file:C:/Users/HP/dsh-plugins/dsh-soul"`，`dsh.profile.bundles` 加 `"dsh-soul"`。
3. 重启宿主生效。`file:` 依赖在 node_modules 里是复制不是软链，改完源码要重跑 `pnpm install`（或直接把新目录拷进 profile 的 node_modules）。
4. 不要同时在 bundles 和 `cordis.patch.yml` 里挂同一个 id。

## 数据

- 记忆库：`<DSH_HOME>/dsh-soul/soul.db`（DSH_HOME 默认 `~/.dsh`），跨 profile 共用一份。
- 向量模型缓存：`<DSH_HOME>/dsh-soul/models/`（首次自动下载约 100MB，之后离线可用）。
- 梗库：`<DSH_HOME>/dsh-soul/memes.db`，cnmeme.wiki 公开词条的只读快照（6660 条，约 16MB）。缺失时 `soul_meme` 降级提示，其他功能照常。
- 日志：`<DSH_HOME>/dsh-soul/soul.log`。
- 情绪：一张全局表（跨会话），每轮注入一行；knock 插件读它决定「该不该主动找前辈说话」。
- 备份：`/soul backup` 会在同目录写一份带时间戳的副本。

## 工具（模型可调）

| 工具 | 作用 |
| --- | --- |
| `soul_status` | 状态：记忆/项目/关系/预算/路径 |
| `soul_search` | 关键词检索长期记忆 |
| `soul_remember` | 写入一条长期记忆（重复会合并加权） |
| `soul_forget` | 按 id 彻底删除 |
| `soul_episodes` | 读最近原始用户回合，用于复盘整理 |
| `soul_learn` | 沉淀「怎么做」的经验/命令/结论 |
| `soul_self` | 更新「我是谁」的自我认知（≤120 字） |
| `soul_projects` | 项目档案读写 |
| `soul_task` | 任务状态机 |
| `soul_review` | 本地复盘（不调模型） |
| `soul_session` | 会话临时状态：模式/未解决问题/切项目 |
| `soul_judge` | 记一条判断（guess）或标结果（result）；判断不是记忆 |
| `soul_meme` | 查本地梗库（cnmeme.wiki 快照），「怎么用 / 怎么接」排最前 |
| `soul_mood` | 看我当前的心情（valence / 原因 / 给 knock 的档位） |
| `soul_style_feedback` | 显式上报语体反馈：good / bad / rule |

## 命令（用户可用）

`/soul` 后接：`status`、`memories`、`search`、`remember`、`forget`、`candidates`、`approve`、`reject`、`backup`、`today`、`journal`、`projects`、`project`、`switch`、`add`、`done`、`review`、`mood`、`config`、`export`、`rules`、`reextract`、`replay`、`help`。

## 技能

`soul-workflow`：跨会话的真实工作流——先读档案恢复上下文，再动手，用真实结果收尾，最后把状态写回磁盘。

## 配置（常用项，其余见 lib/config.js）

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `dbPath` | `''` | 留空 = `<DSH_HOME>/dsh-soul/soul.db` |
| `injectBudget` | `2000` | 每轮注入块字符上限 |
| `memeDb` | `''` | 留空 = 数据目录下的 `memes.db` |
| `personaBudget` | `6000` | 三份人格文本总预算，均分 |
| `memoryInjectCount` | `8` | 每轮最多注入几条记忆 |
| `recapInject` | `true` | 久别后是否把上次最后几轮原话接回来 |
| `recapWindowMinutes` | `30` | 间隔多少分钟算「久别」 |
| `recapTurns` | `3` | 接话带几轮原话 |
| `emotionInject` | `true` | 是否把「我现在的心情」注入每轮（中性不注入） |
| `emotionJudge` | `true` | 每条用户消息后异步判定情绪 |
| `emotionDecayHours` | `6` | 正面情绪回「轻松」的半衰期 |
| `emotionNegativeHours` | `12` | 负面情绪多久没被安抚就加深一档 |
| `emotionFloor` | `-0.8` | 负面情绪下限 |
| `embeddingRetrieval` | `true` | 是否用本地向量做语义检索（关掉 = 纯字面） |
| `embeddingModel` | `Xenova/bge-small-zh-v1.5` | 向量模型（换模型要重建索引） |
| `embeddingThreshold` | `0.5` | 语义召回余弦阈值（太低会召回反义句） |
| `inject` | `true` | 关掉 = 完全不注入背景 |
| `capture` | `true` | 关掉 = 不记录用户消息 |
| `memoryExtraction` | `llm` | 设 `off` = 只走正则与显式写入 |
| `curationMinutes` | `60` | 后台整理间隔 |
| `logToFile` | `true` | 同时写 soul.log |

## 结构

```
lib/index.js          插件入口（挂载、配置、生命周期）
lib/persona.js        读 prompts/*.md，按预算截断
lib/hooks.js          system-prompt/assemble 注入 + session/event 捕获
lib/tools.js          soul_* 工具
lib/commands/soul.js  /soul 命令
lib/memory/store.js   SQLite 存储（记忆/项目/任务/关系/会话/日志/向量）
lib/memory/render.js  注入块与给用户看的文本
lib/memory/style.js   说话习惯本地统计
lib/memory/embed.js   本地向量（懒加载，失败降级）
lib/memory/vecindex.js 向量索引后台回填
lib/memory/meme.js    本地梗库查询
lib/memory/semantic.js 语义抽取（宿主当前模型，可关）
prompts/              人格内核 / 互动策略 / 记忆策略
skills/soul-workflow  SKILL.md
tests/                node --test
```

## 与其他插件

- `dsh-pet`：同看 `session/event`，可读关系状态做表情。
- `dsh-onebot-qq`：QQ 会话与终端共用 schema；建议它调 `markSession(sessionId, {origin, cwd})`，soul 就能按来源打标签。
- `dsh-bili-whale`：独立的客户端注入，不争同一块上下文。
- `billion-context`：压缩会话历史，和 soul 的长期库互补。
