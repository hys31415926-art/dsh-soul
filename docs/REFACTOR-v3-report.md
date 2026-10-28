# dsh-soul v3 修复报告：四条链路与真实库验证

日期：2026-10-28
源码：`C:\Users\HP\dsh-plugins\dsh-soul`
真实库：`C:\Users\HP\.dsh\dsh-soul\soul.db`
运行态：`C:\Users\HP\.dsh\profiles\{web,desktop,headless}\node_modules\dsh-soul`

## 1. 修复前的真实故障

直接在 live 库取证，不是看代码猜：

| 指标 | 值 |
| --- | --- |
| turns | 200 |
| 带 extracted_at 的 turns | 200（全部标了已抽取） |
| memories | 16（其中 1 条 candidate） |
| style_examples | 0 |
| style_rules | 0 |
| schema | 8 |

另外发现根因 E：OneBot QQ 会话 `onebot-private-2524316903-mvo1c5sm` 有 105 个 turns，user_text 全为空。旧 `captureUserMessage` 只接受 `source.kind === 'user'`，而 QQ 用户消息走 `plugin:dsh-onebot`，导致这些回合从源头上没有用户原话。

## 2. 根因与对应修复

### A. LLM 返回解析被 think 块/围栏卡死

`lib/memory/llm-client.js`

- 解析前剥掉 `<think>…</think>` / `<thinking>…</thinking>`。
- 优先取 markdown `json` 围栏；顶层数组以 `[` 开头时优先按数组截取，避免被 `{…}` 截成对象。
- 失败返回 `invalid-json`，交给上层记录，不再静默当成功。

### B. 抽取失败也被标记为已完成

`lib/memory/extraction.js`

- 只有模型调用成功、JSON 合法并真正落库后才写 `extracted_at`。
- 失败时写 `meta.extraction.last_error`（reason：timeout / invalid-json / 其他），回合保持未抽取，下一轮或重启可补。
- `/soul reextract [条数]` 可手动重置最近 N 个回合并后台重跑；未挂载抽取控制器时明确提示。
- 历史回填改用 `store.turnsWindowAt({ sessionId, turn, limit })`，按目标回合截断窗口，不再拿会话最新回合凑证据。

### C. 证据校验要求逐字完全一致

`lib/memory/evidence.js`、`lib/memory/semantic.js`

- 精确 `includes` 失败后，用「去标点/空白归一化 + 字符 bigram overlap ≥ 0.55」回退匹配。
- 模型返回的 `evidenceQuote` 现在会先验真（归一化后必须是原话子串，至少 4 字），再用 `quoteSupportsContent`（bigram overlap ≥ 0.12）确认它确实支撑改写后的 content；不通过才回落到本地找证据。
- `projectUpdates` 也要求 evidenceQuote。

### D. 语义抽取范围过窄

`lib/memory/semantic.js`

- 归一化后接受 `styleRules` 与 `styleExamples` 两类结果，且两者都必须带真实证据。
- 新增近重复合并：同 type、active/candidate 中字符 bigram Jaccard ≥ 0.45 时合并进已有记忆并加证据，不再长出新条。
- 碎片过滤：过短、断句残缺、把祈使句误判成 profile/fact 的结果会被拒绝并计数。

### E. QQ 用户消息没进库

`lib/hooks.js`

- `captureUserMessage` 接受 `source.kind === 'user'` 与 `plugin:dsh-onebot`，仍排除 `source.form === 'relay'`。
- 只对以后回合生效；历史 105 轮没有用户原话，无法凭空重建，这一点在报告里明确说明。

## 3. 学习闭环

### 3.1 反馈识别

`lib/style-signal.js`

- `MAX_SIGNAL_CHARS` 从 40 放宽到 300，按分句/子句检测，跳过代码块和引用。
- 转折词（但是/不过/可是/然而）只否决 praise，不再一刀切；转折后的子句仍参与 correction 判断。
- `CORRECTION_RE` 扩充真实口语：拉了、拉胯、垮了、没内味、味儿不对、太端着、太油、爹味、说教、说人话、正常点、太假、复读机、套路等。
- 分类：mechanical_tone / self_analysis_apology / over_questioning / formulaic_progress / flat_tone / over_intimate + explicit_rule。
- `analyzeFeedbackSignal` 返回 signal、category、explicit、strength、rule；明确指令 strength=1.5，直接 active。

### 3.2 助手自采纳与自认错

`lib/hooks.js`

- 助手自采纳不再充当「用户认可」证据：只把用户原句写 `borrowed` 参考样本（score 0.5），并用 `candidateOnly` 生成 adopted_phrase 候选规则。
- 助手自认错同样只生成 flat_tone 候选规则，不写 negative 样本、不扣分；助手不能靠自评给自己发证据。
- 用户明确夸奖才写 positive；用户明确批评才写 negative，并且只对「上一轮真正注入过」或「文字高度重合」的 positive 归责；同一 turnId 只扣一次。
- 泛化批评没有可归责样本时不扣分，只更新规则证据；不随机挑最近/最高分样本顶罪。
- 短「垮了」「拉了」也会生成规则：首次 candidate，第二次独立回合升 active，规则为「直白自然接话，不端架子、不套公文腔与空洞金句」。
- `soul_style_feedback` 工具（第 15 个工具）支持 good / bad / rule 三种动作，让模型可以显式落库。

### 3.3 规则与锚点的注入纪律

- `activeStyleRules` 默认 limit 6，按同场景优先、evidence_count DESC、updated_at DESC、id DESC 排序，避免 P1 挤占记忆预算。
- `renderContextBlock` 只注入 active 规则，candidate/superseded/disabled 不注入；positive 锚点再过一遍禁用表达；negative 永不注入。
- 注入顺序：规则 → 情绪 → 最近回顾 → 关系 → 项目 → 判断 → 记忆 → 自我 → 画像 → 语体锚点 → 未决问题。
- 禁用表达统一由 `lib/output-guard.js` 提供，支持 config.forbiddenPatterns 扩展；代码块和行内代码不清洗。

## 4. 真实库验证

### 4.1 历史回填演练（快照库）

- 快照：`C:\Users\HP\Desktop\work\.tmp_v3_copy.db`
- 对象：`session-e3e35486-7f10-4be8-9f61-d03e83cd35a6`，limit 8
- 结果：reset 8，runs 5，ok 5，failed 0，skipped 3（短句/无意义回合），memories 15 → 21。
- 新建 6 条，主题包括三份运行态同步、录屏留思考过程、缩短思考链省 token、技能切换研究、游戏思考留档、以开心为主不过度工程化。
- 近重复合并把最初的 4 条相关重复压到 2 条。

### 4.2 live 库真实回填

- 回填前备份：`C:\Users\HP\.dsh\dsh-soul\soul.db.bak-v3-backfill-20261028-171719`
- 只对最近 5 个回合（turn 46–50）回填，避开历史里「旧称呼」歧义回合。
- 结果：reset 5，runs 2，ok 2，failed 0，skipped 3。
- memories：16 → 20（active 19、candidate 1）；新增 id 117–120：
  - 117 录屏并保留思考过程，之后用自己的声音配音做视频
  - 118 缩短思考链，减少 token 消耗
  - 119 研究游戏技能切换
  - 120 游戏过程思考留档
- schema 8，PRAGMA quick_check = ok，memories 中旧姓名/旧称呼命中 0。

### 4.3 风格闭环

- `tests/learning-loop.test.js` 三条真实事件链全部通过：
  1. 用户抛金句 → 助手自采纳 → positive 0.8、adopted_phrase active；
  2. 用户连续两次负评 → positive 扣到 disabled、锚点为空、flat_tone 第二回合 active；
  3. soul_style_feedback good/bad/rule 三种动作落库。
- `tests/hooks.test.js` 17/17 通过，含 QQ 通道 user_text 落库。
- `tests/semantic.test.js` 24/24 通过，含 evidenceQuote 验真、近重复合并、按目标回合截断窗口。

### 4.4 live 库快照上的真实事件链

- 用 `store.backupFile()` 从真实桌面库复制 WAL checkpoint 后的快照；快照原有 201 turns / 13 sessions / 20 memories，schema 8，style_examples/style_rules 均为 0。
- 在快照上通过真实 hooks 事件总线跑 3 回合（下列是 v3 当时语义；v3.1 已改为自采纳只落 borrowed、自认错只提候选，不再直接产生 positive/negative）：
  1. 用户原话「这股劲搁别人身上，三天就散。」+ 助手自采纳 → positive score 0.8、adopted_phrase active；
  2. 用户「刚才那句太垮了，拉了」+ 助手自认错 → 上一样本 0.8 → 0.45 → -1（disabled），锚点数为 0，flat_tone candidate 证据 1；
  3. 用户「刚才那句又端着，太油了」+ 助手「知道了，说人话」 → flat_tone 升 active，evidence_count 2。
- 注入侧实测：`renderContextBlock` 同时出现两条 active 规则；被停用的 negative 样本没有进入注入块。
- 快照用完即删，live 库未被测试回合污染；当时 live 的 style 仍为 0，符合「历史回合未触发新钩子」的边界。v3.1 已用 replay 回放 live 历史，见第 10 节。

## 5. 测试结果

| 位置 | tests | pass | fail | 退出码 |
| --- | --- | --- | --- | --- |
| 源码 | 193 | 193 | 0 | 0 |
| web | 193 | 193 | 0 | 0 |
| desktop | 193 | 193 | 0 | 0 |
| headless | 193 | 193 | 0 | 0 |

源码全量耗时约 12.7s。desktop 的 `prompts/persona.md` 保持「称呼用「前辈」」，测试断言兼容前辈与历史写法，因此三份运行态全绿。

v3.1 新增/改写的关键测试：同回合 user/assistant 双负评只扣一次、第二个独立回合才降为 disabled、相似度不足且未注入过不扣分、上一回合注入过的样本可归责、自采纳只落 borrowed 不产生 positive、自认错候选不占用回合证据位（用户随后对同一回合的批评仍能计证据）、`/soul replay` 回放历史且重复回放不重复落样本、borrowed 不覆盖已有 positive。

## 6. 同步与回滚

- v3 同步前备份：`C:\Users\HP\dsh-plugins\_deploy-backups\20261028-v3-final\{web,desktop,headless}`（lib、prompts、tests、package.json）。
- v3.1 同步前备份：`C:\Users\HP\dsh-plugins\_deploy-backups\20261028-v31\{web,desktop,headless}`（lib、tests、package.json）。
- v3 已把源码的 `lib`、`prompts`、`tests`、`package.json` 覆盖到三份运行态；v3.1 只覆盖 `lib`、`tests`、`package.json`，保留 desktop 自定义的 `prompts/persona.md`。
- 回滚方式：保留 live 库备份 `soul.db.bak-v3-backfill-20261028-171719`；部署副本从上述备份目录恢复；源码侧未执行 `git reset --hard`。
- 当前运行的 DSH 进程仍加载旧模块，注入标题/新守卫/新 render 文案要重启宿主或开新会话后完全生效；数据库里的记忆和规则已经即时可读。

## 7. 约束合规

- 保留现有 SQLite 表：在 v8 基础上增量加列，没有删表重建。
- 旧测试：只按新行为更新了 schema 7→8、旧提示词断言、工具数量、称呼兼容断言；其余保持。
- 不在主回复链路加同步二次 LLM 重试：抽取仍是后台异步队列，失败不阻塞回复。
- 没有 `git reset --hard`。
- 不是只交报告：上述文件均已落盘并有真实测试结果。

## 8. 已知边界

- 历史 105 条 QQ 回合没有 user_text，无法补出用户原话；不会伪造。
- v3 时 live 库的 style_examples / style_rules 为 0，原因是历史回合没有触发新的反馈钩子。v3.1 已用 `/soul replay` 回放 200 个历史回合，得到 3 条规则（1 active、2 candidate）和 2 个样本；用户原话为空的旧回合无法补出原话，只能从 assistant_text 的自我采纳/自认错得到候选。
- 历史回填仍可能提取出与当前称呼冲突的旧偏好；本次只回填最近 5 个回合，未做全库批量回填。全库回填前建议先筛掉旧称呼相关回合，或回填后人工复核。

## 9. 常用命令

- `/soul reextract 20`：重置最近 20 个回合并后台重跑。
- `/soul rules list`：查看规则及状态。
- `/soul rules disable <id>` / `promote <id>` / `rollback <id>`：停用、启用、回滚。
- `soul_style_feedback`：模型显式上报 good / bad / rule。
- `/soul replay [条数]`：回放最近 N 个历史回合的语体反馈，默认 20。

## 10. v3.1 第二轮复审修正（2026-10-28）

第二轮复审指出三个代码级问题：同一回合被扣两次、负评归责靠子串命中不可靠、历史反馈没有回放。本次不重写学习系统，只把证据链和归责链修到可解释。

### 10.1 根因与修复

**A. 同一回合双重扣分**

- 根因：`captureStyleSignal`（user/message）和 `captureAssistantSelfFeedback`（assistant/message）都会对上一回合扣分；一轮负评把样本从 0.8 扣到 0.45 再扣到 -1（disabled），停用得太快，行为和证据不匹配。
- 修复：turn meta 新增 `styleHandledTurnId` / `styleHandledSignal`。用户反馈先处理并标记上一回合；助手自评发现该回合已被用户反馈处理，直接跳过。`penalizeStyleExamples` 再以 `last_penalty_turn_id` 做第二道幂等，同一 turnId 只扣一次。

**B. 负评归责不准**

- 根因：旧实现只查 `kind='positive'`，用 `includes` 子串匹配，真实批评几乎命中不了；命中不了时又回退到最近/最高分样本，等于随机找一条顶罪。
- 修复：只对两种样本归责——文字 bigram 相似度 ≥ 0.30 的样本，或 `last_used_at >= injectedSince`（上一轮确实注入过）且场景匹配/全局的最近使用样本。没有匹配就返回空数组并记 debug 日志，不扣任何分。`renderContextBlock` 只在锚点真正进入注入块时调用 `markStyleAnchorsUsed`，保证 `last_used_at` 不是「查过」而是「注入过」。

**C. 历史反馈没有回放**

- 根因：live 库 200 个历史回合里已有用户夸奖/批评和助手自采纳/自认错，但钩子只在未来回合生效，历史反馈永远不落账。
- 修复：新增 `lib/memory/style-replay.js` 的 `replayStyleFromTurns`，按 turns 顺序回放用户反馈和助手自评；用户反馈作用于上一回合的 assistant_text，已处理过的回合不重复处理。新增 `/soul replay [条数]` 命令，默认回放最近 20 个回合，最多 200。

### 10.2 数据与规则

- `SCHEMA_VERSION` 8 → 9；`style_examples` 增量加 `last_penalty_turn_id INTEGER NOT NULL DEFAULT 0`，没有删表重建。
- `upsertBehaviorRule` 增加 `candidateOnly`：助手自采纳/自认错只能提候选，`gain=0`，不会靠自评把规则刷成 active；用户明确指令仍可直接 active。
- 用户原话不再混进助手 positive 样本：自采纳只写 `kind='borrowed'`；助手 positive/negative 只表示助手自己的表达被用户认可/批评。

### 10.3 live 库回放

- 回放前备份：`C:\Users\HP\.dsh\dsh-soul\soul.db.bak-v31-replay-20261028-182633`（1,306,624 bytes）。
- 回放前：200 turns，schema 8，style_rules 0，style_examples 0。
- 回放结果：turns 200，praise 1，corrections 3，rules 5，samples 2，penalties 0，skipped 0。
- 回放后：schema 9，style_rules 3（active 1、candidate 2），style_examples 2。
  - active #1：chat / flat_tone / evidence 2——直白自然接话，不端架子、不套公文腔与空洞金句。
  - candidate #2：work / over_questioning / evidence 1——能自己判断的直接做，只在关键处问一两个必要问题，不用反问收尾。
  - candidate #3：chat / adopted_phrase / evidence 1——沿用前辈认可的说法与劲头，不改成公文腔或空洞金句。
- 历史 13:18 / 13:19 的「这说法我要了」「行，拉了就是拉了」两回合 user_text 为空（旧 OneBot 通道没落用户原话），回放只能从 assistant_text 自评补出 adopted_phrase 候选和 flat_tone 证据；没有可归责 positive，因此 penalties=0，符合「无匹配不扣分」。
- 副作用边界：negative 样本较长，但 negative 永不进入注入块；它只作为批评记录存在。

### 10.4 测试

- 全量：源码 193/193 pass，web 193/193，desktop 193/193，headless 193/193，四份退出码均为 0。
- 新增/改写覆盖：
  - 自采纳不产生 positive，只产生 borrowed 样本和 candidate 规则；
  - 自认错不扣分，只产生 candidate 规则；
  - 自认错候选不占用回合证据位，用户随后对同一回合的批评仍能补证据并升 active；
  - 同 turnId 只扣一次，第二个独立回合才 disabled；
  - 无相似/无注入匹配时不扣分；
  - 上一轮注入过的样本可被归责（`attribution='injected'`）；
  - 历史回放只处理一次，重复回放不重复扣分/加证据。
- 源码全量耗时约 12.7s。

### 10.5 部署与回滚

- v3.1 同步前备份：`C:\Users\HP\dsh-plugins\_deploy-backups\20261028-v31\{web,desktop,headless}`。
- 已同步 `lib`、`tests`、`package.json` 到 web / desktop / headless；desktop 的 `prompts/persona.md` 保持「前辈」口径，未覆盖。
- 回滚：恢复上述备份目录；live 库可用 `soul.db.bak-v31-replay-20261028-182633` 回到回放前状态。源码没有执行 `git reset --hard`。

### 10.6 仍未验证的能力边界

- 没有跑真实模型对话验收：本次验证的是事件链、数据库状态、注入块和命令输出，不是「模型看到规则后一定改口」。
- 流式输出的中途拦截仍取决于宿主事件能力；本次只保证回合结束时清洗和记录，不声称能撤回已经流到 UI 的 token。
- replay 只能回放库里已有的 turns；user_text 为空的旧回合无法恢复用户原话，也不会伪造。
