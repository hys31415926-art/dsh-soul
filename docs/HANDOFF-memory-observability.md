# 交接文档：记忆可观测（v1.6）与每日复盘（v1.7）

> 写于 2026-10-29。上一轮（v1.5.1）已交付并推送；本文档是下一轮工作的完整前置说明。
> 读者假设：你**没有任何本轮上下文**，只拿到这个仓库和这台机器。看完这一份就能开工。

## 1. 一句话现状

记忆写、存、检、注四个环节都在跑，但**只有聚合计数，没有逐条归因**；所以「你怎么不记得」这件事没法定位到具体步骤。下一轮的全部目标就是把这条链路变成可指认的，再在它之上加一个「每天最多改一点、必须有证据、可回滚」的复盘器。

## 2. 仓库、运行副本与数据

| 类型 | 路径 |
| --- | --- |
| 源码仓库 | `C:\Users\HP\dsh-plugins\dsh-soul`（origin `https://github.com/hys31415926-art/dsh-soul.git`，分支 `main`） |
| 运行副本 | `C:\Users\HP\.dsh\profiles\desktop\node_modules\dsh-soul`（**实体拷贝，不是软链**） |
| 数据库 | `C:\Users\HP\.dsh\dsh-soul\soul.db`（另有 `soul.db.bak-v<旧schema>-<时间戳>` 备份） |
| 向量模型 | `C:\Users\HP\.dsh\dsh-soul\models\Xenova\bge-small-zh-v1.5\`（约 114MB，本地离线可用） |
| 运行日志 | `C:\Users\HP\.dsh\dsh-soul\soul.log` |
| 宿主 profile 配置 | `C:\Users\HP\.dsh\profiles\desktop\cordis.yml` + `cordis.patch.yml`（补丁层，优先生效） |

基线状态（开工前用它确认没跑偏）：`HEAD = af53a24`、`package.json = 1.5.1`、tag `v1.5.0` / `v1.5.1`、schema **v10**、`node --test "tests/*.test.js"` → **218 pass / 0 fail**（约 12s）、工作树干净。

生产库现状（2026-10-29）：`memories` 41 条（active 31）、`embeddings` memory 31 / turn 181、`turns` 200、`meta` 里已有 `schema.version=10`、`extraction.*`、`curation.last`、`curation.report`、`retrieval.last`。

**改完之后一定要做两件事**：`cp -rf` 同步到运行副本，然后**重启 dsh**（模块是启动时加载的，不重启等于没改）。

## 3. 已经有的能力（不要重复实现，直接复用）

- **确定性维护**：`store.curate()` 已扩写为「裁剪回合 → 近重复合并（bigram ≥ 0.8）→ 低价值聚合（importance ≤ 0.35 且同类型满 3 条）→ 衰减 → 归档」，带六条护栏（`source=user-explicit`、`importance ≥ 0.8`、`hits ≥ 5`、关系/项目类、标签含 self/核心/身份/约定/家人/纪念、7 天内更新过）。由 `lib/index.js` 的 `curationMinutes`（默认 60 分钟）调度，手动触发是 `/soul sleep`。
- **检索路由**：`lib/memory/retrieval.js` 的 `planRetrieval()` —— `current_message`（默认）/ `guarded_companion` / `companion_augmented`，含状态问句窗口（`statusWindowDays` 默认 7）、时间窗口、类型白名单、`includeSuperseded`（问「以前」才带旧值）。
- **过滤计数（骨架已有）**：`selectMemories()` 返回 `filtered = { wrongStatus, wrongType, tooOld, duplicate, overBudget }`，路径 `path = literal|popular|vector`，缓存 `cache = hit|miss`。
- **单轮观测（仅有最后一次）**：`meta['retrieval.last']`，`/soul why [这句话]` 可读模式/检索词/窗口/白名单/是否带旧值。
- **三级注入**：`usageOf()` → `mention`（可自然提起）/ `tone`（只影响语气）/ `uncertain`（拿不准别当事实）/ `past`（已被取代的旧值，标明只能当「以前」说）。
- **单值改口**：`lib/memory/attributes.js`，写新值时旧值标 `superseded` + `superseded_by`，多值属性并存。
- **抽取预算与退避**：每小时 12 次调用、每批 3 个回合、阶梯退避 30s→2min→10min→30min→1h、第 5 次后每天一次；`turns` 表有 `extract_attempts` / `next_extract_at`。
- **规则状态机**：`style_rules` 的 `active/candidate/superseded/disabled`，`evidenceCount` 去重加分，命令 `/soul rules promote|disable|rollback`。
- **向量健康可见**（v1.5.1）：`/soul status` 显示「语义检索：已加载 / 懒加载未触发 / 降级（原因）+ 已建索引 N 条」；启动 3 秒自动 `syncEmbeddings` 回填。
- **证据链**：`lib/memory/semantic.js` 的 `findEvidenceQuote` / `verifyProvidedEvidence` / `quoteSupportsContent`，记忆必须能在原文里找到出处。

**完全没有的**：按 turn/memory ID 的逐条诊断、`overBudgetIds`（预算裁掉了哪几条）、索引一致性检查、每日复盘调度、待确认建议队列、`persona.md` 差异建议。

## 4. 待做：P0–P5

### P0 版本号与埋点（半天）
- 版本语义先对齐（见 §6 待拍板）。建议 `1.6.0`（可观测）/ `1.7.0`（每日复盘），tag 保持单调递增，不要在 1.5.1 之后跳 3.x。
- 新表 `wake_log`（纯元数据，**不存原文**）：`id, turn_id, session_id, at, version, mode, path, cache, candidates_json, filtered_json, injected_ids, over_budget_ids, section_chars_json, budget_used, budget_total, rendered, degraded, ms`。
- `selectMemories()` 额外返回被淘汰条目的 `{id, reason}` 列表；`pack()` 记 `overBudgetIds`。
- 验收：跑一轮真实对话后 `wake_log` 有一行，且 `injected_ids` 与 `retrieval.last` 不矛盾。

### P1 诊断命令与一致性检查（1 天）
- `/soul diagnose [memory:<id> | turn:<id>]`：默认最近一轮，只打 ID / 原因码 / 长度 / 阶段；加 `--text` 才显示正文（有长度上限）。
- `/soul check`：只读一致性检查——开库、schema 版本、必要表、`hasFts`、向量覆盖（**memory 应全覆盖；turn 只要求保留窗口内**，不能机械要求条数相等）、孤儿向量（`ref_id` 已不在）、`superseded` 状态自洽。返回明确失败状态，不做任何修复。
- `/soul status` 增两到三行：最近写入时间、最近唤醒时间与是否降级、最近一次预算淘汰概况。
- 验收：人为制造 5 种故障（不存在 / 没召回 / 被过滤 / 预算裁掉 / 已注入），诊断能分别说清。

### P2 端到端测试（1 天）
覆盖任务书第七节 A–D：写入 → 关库 → 重开 → 检索 → 渲染 → 诊断追到同一条；索引缺失/降级路径；预算不足的省略原因；「已接入宿主但模型是否利用」必须标为未知，不能算成功。

### P3 每日复盘骨架（1–2 天）
- 调度状态存 `meta`：`daily_review.<YYYY-MM-DD>` → `pending|running|completed|completed_no_changes|failed`，带 pid/startedAt 做进程内互斥（**不做分布式锁**，现场单进程单库）。
- 自然日按本地时区；启动时只做一次「是否补跑上一日」判断，**绝不扫历史日期、绝不连续补跑多天**。
- **价值闸门**：当天没有未被计过数的反馈事件（`style_examples` / 负评样本 / `judgments`）→ 直接 `completed_no_changes`，**一次模型调用都不发**。
- 硬上限：`maxModelCalls=1`、`maxInputChars=8000`、`maxOutputChars≈2000`，失败只退避不重试第二遍。
- 默认 `dryRun=true`：只产报告不落变更。
- 复用 `index.js` 现有定时器与 `disposers`，`unref()`，卸载/退出必须清干净。

### P4 提议落地（1–2 天）
- 复盘**不拥有写入权**：它只产 proposal。
  - 行为规则 → 写进既有 `style_rules.candidate`，走 `promote/disable/rollback`，证据计数复用现有 `evidenceCount`（**同一事件重复读不得重复加分**，v1.3.1 修过一次，别再犯）。
  - 记忆歧义 → 新表 `review_queue`（提议合并/归档，**不自动删**，保留原始来源）。
  - 报告 → `meta['daily_review.<date>.report']`。
- 命令：`/soul review run|last|proposals|approve <id>|reject <id>`。
- **候选过期**：7 天无新证据的 proposal 自动 `superseded`（待拍板）。

### P5 人格差异建议（可选，最后）
`persona.md` 只生成 diff 建议 + 审计记录，**不落盘**；应用必须人工确认。

## 5. 红线（违反就不要合并）

1. 不建第二套权威记忆库、不建第二套人格/规则系统；一切落地走既有状态机。
2. 不复刻 `curate()` 的职责——确定性维护已在跑，只补它没碰的「歧义进队列」。
3. 模型不能直接删数据；自动操作优先「归档 / 标失效 / 合并」，不永久删除。
4. 稳定身份事实、长期偏好、关系边界、关键项目决定、已验证规则：**不因时间或「最近没被用到」失效**。必须区分「最近没用」与「已经不再有效」。
5. 模型自评 / 道歉 / 承诺**不是用户认可的证据**。
6. 没有证据时正确结果就是「不变」；不许为了定时任务编学习成果。
7. 默认不在生产日志记录完整对话、完整系统提示词、token。
8. 程序只能证明「已渲染并交给宿主」，不能声称「模型已收到并用了它」——文档与报告都要写清楚。
9. 生产库操作前先复制备份；迁移会写 `soul.db.bak-v<旧>-<ts>`；测试一律用临时库。
10. 不擅自 `git push`（用户点头再推）。

## 6. 需要先拍板的三件事（上一轮已问，等答复）

1. **版本号**：接着 `1.6.0` / `1.7.0` 走，还是直接跳 `3.2` / `3.3` 对齐任务书？（建议前者，tag 单调。）
2. **每日复盘默认开关**：建议默认**关**（`dailyReview.enabled=false`），先用 `/soul review run` 手跑一周看报告有没有料，再开定时。
3. **候选过期**：7 天无新证据自动 `superseded`，同意吗？不同意就会永久躺在 candidate 里变死数据。

## 7. 工程环境陷阱（这台机器上亲测会踩，照做能省两小时）

- **`ops_bash` 的 command 载荷约 6.5KB 就被截断**：11KB 的 heredoc 会写在语句中间断掉并报 `warning: here-document at line 1 delimited by end-of-file`。**每块 ≤3KB，写完立刻 `wc -l` + `tail -1` 校验。**
- **`/tmp` 与 node 不一致**：bash 里 `/tmp` = `C:\Users\HP\AppData\Local\Temp`，但 node 里写 `/tmp/x.js` 会解析成 `C:\tmp\x.js`（ENOENT）。要把临时文件先 `cp` 到仓库目录再用相对路径。
- **ESM 不接受 `C:/...`**：`ERR_UNSUPPORTED_ESM_URL_SCHEME`。临时脚本放进仓库目录用相对 import。
- **`ops_replace` 在本仓库匹配不到**（返回 matched 0）。改用 node 脚本做**单行锚点**替换（`t.replace(anchor, next)`，anchor 里不带换行），或 heredoc 整段重写。
- **`package.json` 带 BOM**：`JSON.parse` 会报 `Unexpected token '﻿'`。先 `.replace(/^\uFEFF/u, '')`。
- **`robocopy` 在 git-bash 里调不通**（返回 rc=16 并只吐用法横幅）。同步用 `cp -rf "$SRC/lib/." "$DST/lib/"`。
- **git 要用 `ops_bash` 跑**：PowerShell 里 `git status` 会返回空输出 + exit 1。
- **跑测试用引号包 glob**：`node --test "tests/*.test.js"`；`node --test tests\` 会 MODULE_NOT_FOUND。
- **`makeTempStore(t)` 返回 `{ store, path, dir }`**，要解构 `const { store } = makeTempStore(t)`（直接当 store 用会 `store.stats is not a function`）。
- **临时库不跑迁移**：`initSchema` 的迁移循环被 `if (version > 0)` 包着，全新库只走 `CREATE TABLE`。**新列必须同时写进基础建表语句**，否则测试库没有列（v1.4 踩过：`no such column: next_extract_at`）。
- **不要对 npm 全局目录做递归 grep**（`C:\Users\HP\AppData\Roaming\npm\node_modules\@deepseek-ai\dsh`）：会超时并重置会话。
- **`sharp` 是向量模型的隐形硬依赖**：报 `Could not load the "sharp" module using the win32-x64 runtime` 时，模型和 transformers.js 都是好的，坏的是 `@img/sharp-win32-x64` 的 `.node`（`ERR_DLOPEN_FAILED`）。修法：`npm install sharp --no-audit --no-fund` 后覆盖进运行副本。

## 8. 测试与验收命令

```bash
cd /c/Users/HP/dsh-plugins/dsh-soul
node --test "tests/*.test.js"                 # 全量：基线 218 pass
node --test "tests/retrieval-v15.test.js"     # 单文件冒烟
git log --oneline -3 && git status --porcelain
```

真实库验证（**永远拿副本**，不动生产库）：

```bash
cp /c/Users/HP/.dsh/dsh-soul/soul.db /c/Users/HP/Desktop/work/probe.db
# 再用 new DatabaseSync(path, { readOnly: true }) 只读查询，或 openStore(副本路径)
```

部署与生效：

```bash
SRC=/c/Users/HP/dsh-plugins/dsh-soul; DST=/c/Users/HP/.dsh/profiles/desktop/node_modules/dsh-soul
cp -rf "$SRC/lib/." "$DST/lib/" && cp -rf "$SRC/tests/." "$DST/tests/" && cp -rf "$SRC/docs/." "$DST/docs/"
cp -f "$SRC/package.json" "$SRC/README.md" "$SRC/GLOSSARY.md" "$DST/"
# 然后重启 dsh；用 /soul status 看版本号是否变了来确认加载了新副本
```

## 9. 术语与关键位置索引

| 想改什么 | 去哪里 |
| --- | --- |
| 建表 / 迁移 / 状态机 | `lib/memory/store.js`（`SCHEMA_VERSION` 顶部、`MIGRATIONS` 末尾、`initSchema`） |
| 检索路由与候选 | `lib/memory/retrieval.js`（`planRetrieval` / `selectMemories` / `usageOf` / `rankScore`） |
| 注入渲染与预算 | `lib/memory/render.js`（`renderContextBlock` / `budgetPlan` / `renderInjectedMemories` / `renderStatus`） |
| 抽取预算与退避 | `lib/memory/extraction.js` |
| 单值改口 | `lib/memory/attributes.js` + `store.applyAttributeRules()` |
| 命令 | `lib/commands/soul.js`（`registerCommand`，`/soul` 全部子命令） |
| 工具面 | `lib/tools.js`（`soul_*`） |
| 装配与定时器 | `lib/index.js`（`curationMinutes`、`syncEmbeddings`、`disposers`） |
| 配置默认值 | `lib/config.js`（`DEFAULT_CONFIG`）+ `lib/index.js` 的 schema |

## 10. 交接检查清单

- [ ] `git log --oneline -3` 与 §2 基线一致；`node --test "tests/*.test.js"` 218 pass
- [ ] 读一遍 §3，确认要做的功能不在「已经有了」列表里
- [ ] §6 三件事有答复（没有就按建议默认值做，并在报告里标注「按建议默认」）
- [ ] 每完成一个 P，跑测试 + 同步运行副本 + 写 CHANGELOG
- [ ] 交付报告按任务书最后一节逐项填：审计 / 链路 / 配置 / 结构化输出示例 / 清理安全规则 / 文件清单与迁移 / 测试命令与数量 / 调度与幂等结果 / 真实模型是否调用 / 部署与关闭方法

## 11. 关于本文件

本文档是**规划与交接**，不含已实现代码。它已作为独立提交落在本地 `main`（提交信息以 `docs:` 开头，见 `git log`），但**未推送到远端**——推不推由用户决定。

上一轮已实现并推送的内容：`v1.5.0`（检索路由 / 单值改口 / 睡眠维护 / 缓存与可观测）、`v1.5.1`（语义检索不再静默降级 + `/soul status` 显示向量状态）。下一轮的 `1.6.0` / `1.7.0` 尚未开工。
