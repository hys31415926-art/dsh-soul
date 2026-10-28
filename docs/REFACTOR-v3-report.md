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

- 检测「这说法/这句/这股劲…我要了/记下了/往后照着来」：若本轮用户消息没有触发落库，自动把用户本轮原句写 positive 样本（score 0.8），并生成 active 的 `adopted_phrase` 规则。
- 检测「拉了就是拉了/确实拉了/不狡辩/刚才那句确实垮」：若本轮没有规则落库，自动记负面闭环。
- 负评时把上一轮助手回复写 negative 样本，并对最相似的 positive 样本扣 0.35；两次扣到 ≤0.1 自动停用（score=-1, kind=disabled），锚点永不再选。
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
- 在快照上通过真实 hooks 事件总线跑 3 回合：
  1. 用户原话「这股劲搁别人身上，三天就散。」+ 助手自采纳 → positive score 0.8、adopted_phrase active；
  2. 用户「刚才那句太垮了，拉了」+ 助手自认错 → 上一样本 0.8 → 0.45 → -1（disabled），锚点数为 0，flat_tone candidate 证据 1；
  3. 用户「刚才那句又端着，太油了」+ 助手「知道了，说人话」 → flat_tone 升 active，evidence_count 2。
- 注入侧实测：`renderContextBlock` 同时出现两条 active 规则；被停用的 negative 样本没有进入注入块。
- 快照用完即删，live 库未被测试回合污染；live 的 style 仍为 0，符合「历史回合未触发新钩子」的边界。

## 5. 测试结果

| 位置 | tests | pass | fail | 退出码 |
| --- | --- | --- | --- | --- |
| 源码 | 187 | 187 | 0 | 0 |
| web | 187 | 187 | 0 | 0 |
| desktop | 187 | 187 | 0 | 0 |
| headless | 187 | 187 | 0 | 0 |

源码全量耗时约 12.3s。desktop 的 `prompts/persona.md` 保持「称呼用「前辈」」，测试断言兼容前辈与历史写法，因此三份运行态全绿。

## 6. 同步与回滚

- 同步前备份：`C:\Users\HP\dsh-plugins\_deploy-backups\20261028-v3-final\{web,desktop,headless}`（lib、prompts、tests、package.json）。
- 已把源码的 `lib`、`prompts`、`tests`、`package.json` 覆盖到三份运行态。
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
- live 库的 style_examples / style_rules 仍是 0，原因是历史回合没有触发新的反馈钩子；从下一次真实夸/骂开始才会沉淀。风格闭环已由单测和 live 库快照上的真实事件链证明。
- 历史回填仍可能提取出与当前称呼冲突的旧偏好；本次只回填最近 5 个回合，未做全库批量回填。全库回填前建议先筛掉旧称呼相关回合，或回填后人工复核。

## 9. 常用命令

- `/soul reextract 20`：重置最近 20 个回合并后台重跑。
- `/soul rules list`：查看规则及状态。
- `/soul rules disable <id>` / `promote <id>` / `rollback <id>`：停用、启用、回滚。
- `soul_style_feedback`：模型显式上报 good / bad / rule。
