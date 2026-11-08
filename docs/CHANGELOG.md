# 更新记录

版本号以 `package.json` 为准。这里只记「行为变了」的部分，纯重构不记。

## 1.9.0

**DSH 0.2.2 适配 + 判断层落地 + 去冗余**（schema 17）

> 1.7.2 之后有 v1.8（判断层）与 v1.9（双层裁决、会话订阅）两个开发阶段；这次合并为 1.9.0 发布，1.7.2 未单独发版。

### DSH 0.2.2 适配

- 修技能加载失败：宿主的 `skills.register()` 只做宽松校验，`skill` 工具真正 `get()` 时才要求 `source` 是非空字符串。缺了就会「列表里看得见、一加载报 `loaded skill "soul-workflow" source must be a string`」。注册对象补 `source: 'dsh-soul'`，并把这条约束写进测试；已在 0.2.2 运行进程里实际加载通过。
- 对照 0.2.1 / 0.2.2 的 `dsh-skill`、`dsh-commands`、`dsh-system-prompt`、`dsh-tools`、`dsh-llm`、`dsh-agent`、`dsh-session`：soul 用到的 `ctx.get/on`、system prompt 段落、tools/commands/skills 注册接口都没变；0.2.2 新增的实验包与 soul 无关，没有跟进。

### 判断层（v1.8）

- 记忆带授权凭据：`memories.mandate` 记「凭什么写这条」（explicit / inferred、依据、策略版本、来源），`/soul why #id` 与 `/soul diagnose memory:#id` 能回答。旧记忆没有凭据就留空，不按 `source` 反推——猜出来的凭据比没有更糟。
- 项目条目带「在等谁」：`project_items.stage`（person / agent / blocked）与 `report`（progress / waiting / ready / blocked / failed / dropped）；`soul_projects` 的 `waiting`、`item-report` 可直接标，项目条目不再只有「open/done」。
- 规则有版本：`prompts/*.md` 挂载时算 hash，改了会在下一轮注入块里提示一次（`trackPromptVersions` / `takePromptNotice`），不用猜「这版规则到底加载没有」。
- 明确没搬：Ticket / Assignment / Executor、跨 Source 身份映射、外部事件自动接单；soul 没有执行器，也不打算有。

### 双层裁决与会话订阅（v1.9）

- 新增 `lib/core/eval.js`：`gateItem`（确定性准入：在等人、卡住、做完、没标的先拦）/ `assessItem`（优先级、挂了多久、有没有验收条件打分）/ `evaluateItem` / `rankItems`。决策五态 `accept / observe / wait / ignore / unavailable`，判据是代码里的短语，不是模型自述。
- `/soul next` 改为先过闸门再排序，每条带一行「判据」（如「优先级 2、挂了 3 天」）。
- `/soul accept observe|auto`：只改 `/soul next` 的排序与标注——`observe` 把推断出来的事单独列「本来会做」，`auto` 让高分的进「该推的」；**不会自己开新活**。命令文案与 `/soul next` 页脚同步说清楚。
- 会话订阅项目：`session_subscriptions(session_id, project_id, created_at)`。只订阅一个项目时，抽取出的记忆没带 `projectId` 就自动挂过去；订阅 0 个或 2 个以上都不挂，多个订阅靠猜只会挂错。`/soul subscribe` 查看，`/soul subscribe <项目名>` 订上，`/soul subscribe off` 全清。

### 去冗余（schema 17）

- 删 `relation_history` 死表：建表起就没有读写方；BASE_SCHEMA 不再建，v17 迁移 `DROP INDEX IF EXISTS relation_history_time; DROP TABLE IF EXISTS relation_history`，旧库升级前照常备份。
- 删 9 个零调用 Store 方法与 5 个随之无用的 prepared statement；删 13 个零引用导出；删两个死配置键 `enhancedExtraction`、`sensitivePolicy`。
- `emotionJudge` 从「只显示不生效」改成真正能关：`config.emotionJudge === false` 时不再调用 `emotion.consider`。
- evidence 从只写不读变成能上屏：`/soul why #id`、`/soul diagnose memory:#id` 显示最近一条证据原文与时间；curate 改调 `pruneEvidence`，保留期口径不变（至少 180 天）；`memory_history` 增加 180 天清理，不再只增不减。
- 删 `metrics/style` JSONL 整条链（采集模块、hooks 记录、配置键、测试）；这类只写不读的指标文件不再占盘。
- `Config` schema 与 `DEFAULT_CONFIG` 对齐到 62 键、默认值全等：补上 7 个代码在读但用户配不到的键，补上 3 个语义检索默认值，新增 `tests/config-alignment.test.js` 锁死。
- `/soul help` 的 `input.hint` 补全为实际注册的 35 个子命令，不再漏 today / journal / mood / rules / replay / sleep / next / accept / subscribe / item。
- 测试 253 → 280：新增 v17 迁移（新库无表、旧库删表）、`emotionJudge:false`、why/diagnose 证据展示、curate 历史/证据清理、配置对齐；删掉只测 metrics/style 的 `tests/style-metrics.test.js`。

## 1.7.2

**实测修正：被比较与斗嘴的意图、规则按主题去重、情绪指向的本地兜底**

- 补两个意图：`lib/core/conversation-policy.js` 新增 `COMPARISON_RE`（「你看看人家」「你就是不如它」「比人家差」）与 `TEASE_RE`（「笨蛋」「真菜」「就这」「你行不行」），分别产出 `comparison` 与 `tease`。原来这两个一个是闲聊一个是情绪，都被压成 `casual`/`chat`，被比较时可能按轻松接一句，斗嘴时反而调出情绪规则。`scene.js` 里比较落 `emotional`（别按轻松接），斗嘴落 `chat`（就是闲聊，不单开格，免得旧样本兜不住）。
- `EMOTION_RE` 的「不开心」放宽成「不(开心|高兴|爽)」：原来「我真的有点不高兴」识别不到，因为正则写死了「不开心」三个字。
- 规则注入改按**主题**去重，不再靠字面相似度：新增 `lib/core/rule-topics.js`，把规则归到 `questioning / catchphrase / mechanical / sweetness / directness / length` 六类，同一类只留 `evidence_count` 最高的一条。真实库里 #34/#35/#39 三条同义规则分属 `flat_tone / general / self_analysis_apology`，字符集 Jaccard 只有 0.2，任何字面阈值都合并不了，调阈值只会误伤。现在取 6 条 → 去重 → 切 3 条，注入不再出现三条说同一件事。
- 情绪指向加本地兜底：`lib/emotion.js` 新增 `topicFromText()`，模型没给 topic 且情绪强度 `>= 0.12` 时，从原话里取最长实词段（≤12 字）顶上；取不到就空着，不编。原来 topic 完全依赖模型返回值，实测真实库里一直是空串，等于这个字段白加。
- 修一个**新装用户才会踩的 bug**：`store.js` 的迁移只在 `user_version > 0` 时跑，而 `BASE_SCHEMA` 的 `emotion` 建表没有 `topic` 列，所以全新库第一次写情绪直接 `ERR_SQLITE_ERROR: table emotion has no column named topic`。建表语句补上 `topic`，并新增 `ensureEmotionColumns()` 做缺列兜底。
- 测试 246 → 253：新增 `tests/scene-intent-rules-topic.test.js`（斗嘴/比较分类、场景映射、主题归类、注入去重、本地兜底 topic、撞车只说一次）。
- 互动节奏补丁 v1：只动 `prompts/interaction-policy.md` 三处——「每轮先选一个主要目的」整节换成「接话与对话节奏」（先接住眼前最明确的互动，不再先归类再组织一条最合适的回复；允许短答、允许说完就停、不硬凑第二个动作、不刻意表演随性）；场景里的「日常闲聊」改成从眼前正在发生的事接话并补上版权边界；「回应前的轻量判断」收窄成「复杂情况才做轻量判断」，普通寒暄不再走五连问。`work-policy.md`、工具执行、备份、测试、回滚与汇报要求一律不动。人格注入从 3727 → 4147 字符，仍在 6000 预算内。新增 `tests/interaction-rhythm.test.js`（6 项）锁住这三处替换与工作态约束。行为前后对照需重启 DSH 后执行，见 `reports/interaction-rhythm-v1-acceptance.md`。

## 1.7.1

**审查修正：人格里的固定轨迹、偏好型反馈、场景粒度**

- 人格内核删掉「被凶会小小委屈一下然后马上回来」。那是一句写死的情绪轨迹，读完就照着演；现在只在边界里保留了「会不高兴」，怎么处理留给当轮判断。同理，「被要求测试」不再要求「像朋友一样接一句」，改成不自检、不报状态、不表演人格；「日常闲聊：轻松、软、可以黏一点」改成不绑定语气的说法。
- 语体反馈多一条通道：`lib/style-signal.js` 新增 `STYLE_PREFERENCE_RE`。以前 `analyzeFeedbackSignal` 只认「夸」和「六类批评」，`if (!isPraise && !correctionHit) return null` 会让「再活泼一点」「不用那么端着」「允许主动换话题」这类方向性要求整句丢掉——它们只能靠语义管道偶发地变成一条 preference 记忆，进不了语体链路。现在返回 `signal: 'preference'`、`category: 'style_preference'`，`captureStyleSignal` 与 `style-replay` 只给它建规则，**不**给它存负样本、**不**扣分（那句话未必错，只是不够对路）。
- 没命中任何类别的批评不再冒充 `mechanical_tone`：默认类别改 `general`，默认规则改成「按对方指出的地方改，别自行扩大到别的方面」。以前所有不认识的批评都被记成「机械腔」，同类底下堆着互不相干的规则。
- 场景格细分：新增 `lib/core/scene.js`，把意图映射成 `work / chat / intimate / emotional / test / feedback` 六格。原来 `WORK_KINDS.has(kind) ? 'work' : 'chat'` 把亲近、情绪、被检验、反馈全压进 chat，六类互相冲突的规则同时注入。读取时 `sceneFallbacks()` 让细格退回 chat（旧数据全在 chat 和 work 里），`store.activeStyleRules()` 与 `selectStyleAnchors()` 都接受 `fallbackScenes`。
- 情绪指向的提示词补了三条：常见填「前辈」或具体那件事；同一件事要沿用同一个 topic；确实没有指向才留空。`topic` 列本身在 1.7.0 就有了。
- 测试 240 → 246：新增 `tests/style-preference-scene.test.js`（偏好三通道、批评不被偏好吞掉、六格映射、细格退回 chat 兜底、细格优先、话题换了 topic 跟着换）。

## 1.7.0

**人格与学习闭环**（schema 12，`emotion` 加 `topic`）

- 情绪多一个指向：`emotion.topic`（≤16 字），渲染成「我现在的心情：{label}（{topic}，{reason}）」。以前只有 `reason`，读起来是一次性的原因句；现在能表达「还是因为这件事」。`smooth()` 改为一层状态：新判定不给原因/指向时保留旧的，情绪归零时一起清空，避免 valence 已经是 0 还挂着旧原因。
- 语体样本收紧：正向锚点必须是助手自己说过的原话。只出现在用户话里的样本降成 `borrowed`（留档但不进注入）；「接下来我立三条规矩：1. …」这类布置任务的句子不再进原句库。
- 记忆写入加校验：第一人称原话（「我爱你所以说什么都无所谓」）不直接贴成长期记忆；推测出来的情绪（「他觉得你差并为此难受」）置信度压到 0.6 以下，落候选；6 字以下的残片拒收；近义记忆合并时两种归一化取较大相似度。
- 行为规则做近义去重：`findNearDuplicateRule`（字符 bigram Jaccard ≥ 0.62）在 `upsertBehaviorRule` 里先于新建生效，换句话说的同一条反馈不再各存一条。
- 人格文件去掉「十五到二十五字」「最多一个破折号」「语气词自然带着：呀、嘛、啦」这类硬约束；「不排条目」加了「除非对方要的本来就是结构化产出」的例外。

## 1.6.0

**记忆唤醒链路可观测**（schema 11，新增 `wake_log` 表）

- 每轮 `turn/end` 落一行元数据：会话/回合、检索模式与路径、缓存命中、候选池与注入的 ID、被淘汰的 ID 与原因码、段落字数、预算用量、是否渲染、降级标记、耗时。**不存正文、不存提示词、不存 token**。
- `wake_log` 独立生命周期：`curate()` 里保留 30 天或 5000 行（先到者），不新开定时器。
- `selectMemories()` 新增返回 `considered` / `excluded`（每条 `{id, reason}`，上限 60）/ `overBudgetIds`；`filtered` 新增 `typeQuota`。淘汰原因从此分得清：没找到 / 没过状态类型窗口 / 同类配额 / 单条预算 / 渲染预算 / 整段移除 / 硬长度上限。
- `renderContextBlock()` 新增可选 `input.report` 收集器（返回值仍是字符串，老调用方不用改）与 `input.dryRun`（预览不写 `meta['retrieval.last']`、不记锚点使用）。报告里 `rendered` 是布尔，`chars` 才是长度。
- `/soul why` 改成只答历史（读 `wake_log`，没有再退回 `meta['retrieval.last']`）；另开 `/soul plan [这句话]` 做纯函数预算预览；`/soul diagnose [turn:<id>|memory:#<id>] [--text]` 看单轮或单条记忆的链路；`/soul check` 只读一致性检查（连接 / schema / 必要表与索引 / FTS5 / 孤立向量 / 改口自洽 / 唤醒日志），只报告不修复。
- `/soul status` 多两行：唤醒日志行数与最近一次（路径、降级）。
- 测试 218 → 231：新增 `tests/wake-log.test.js`（落库读回、淘汰原因、dryRun 不写观测、一致性检查失败路径、裁剪上限、hooks 收尾写一行、诊断/预览/检查命令）。

## 1.5.1

- 修掉一个长期静默降级：Windows 上 `sharp` 的预编译二进制坏了（`.node` 加载报 `ERR_DLOPEN_FAILED: The specified module could not be found`），`transformers.js` 一 import 就失败，于是向量模型永远加载不起来、语义检索长期退回字面检索，只在 `soul.log` 里刷一行 warn。`sharp` 现在是显式依赖（`^0.34.5`），README 补了排查与修法。
- `/soul status` 与 `soul_status` 工具新增一行「语义检索」：已加载 / 懒加载未触发 / 降级（带原因），并给出已建索引条数。降级从此能自己看见，不用翻日志。
- 实测（本地 bge-small-zh-v1.5，CPU）：首次加载 428ms，512 维；「屋里别太冷」对「空调别开太低」余弦 0.6129，对无关句 0.3185；第二次调用 4ms。

## 1.5.0

**检索路由**（`lib/memory/retrieval.js` 的 `planRetrieval()`）

- 检索词默认只取当前用户消息（`queryMode = current_message`）。以前把「当前消息 + 未决问题」硬拼，最容易答非所问。
- `guarded_companion`：只有在有陪伴线索（累 / 晚安 / 想你 / 心情…）**且**当前话题有实质内容时才扩展检索。
- `companion_augmented`：保留旧行为（总拼未决问题），不推荐。
- 问「在干嘛 / 吃了吗」这类眼下状态：只看最近 `statusWindowDays`（默认 7）天，且只允许画像 / 事实 / 情景三类进来。
- 问「以前 / 之前 / 小时候」：把被取代的旧值也放进候选。

**单值改口与多值并存**（新增 `lib/memory/attributes.js`，写入时由 `store.applyAttributeRules()` 执行）

- 单值属性（住址 / 职业 / 公司 / 学校 / 生日 / 手机 / 邮箱 / 身高体重 / 家乡 / 星座）：写入新值时旧值标 `superseded`，`superseded_by` 指回新值，旧值保留以支持过去时提问。
- 多值属性（习惯 / 喜欢讨厌 / 约定 / 打算）：新旧并存，绝不互相取代。
- 用户明确要求记住的旧值，不会被一条低置信度的新说法顶掉。

**睡眠维护**（`store.curate()` 扩写）

- 顺序：裁剪原始回合 → 近重复合并 → 低价值聚合 → 衰减 → 归档。
- 近重复合并：同类型、字符 bigram 相似度 ≥ 0.8，只留被用得多的那条。
- 低价值聚合：`importance ≤ 0.35` 的同类型记忆攒够 3 条，压成一条「近况汇总」后归档原文。纯本地规则，不调模型。
- 六条护栏：`source = user-explicit`、`importance ≥ 0.8`、`hits ≥ 5`、关系 / 项目类、标签含 self / 核心 / 身份 / 约定 / 家人 / 纪念、7 天内更新过 —— 不衰减、不归档。
- 结果写 `meta['curation.report']`；`/soul sleep` 手动触发并打印各项条数。

**检索缓存与可观测**

- 检索结果缓存 60 秒，key 含记忆库指纹（条数 + 最大 `updated_at`）与全部检索参数；命中后仍重读记录并重判可见性，不凭旧快照注入。
- 每轮写 `meta['retrieval.last']`（模式 / 路径 / 缓存 / 条数字数 / 判断依据），跳过检索的轮次也记一笔。
- 新增 `/soul why [这句话]`：这一轮会怎么检索；新增 `/soul sleep`：手动跑睡眠维护。
- 注入块新增一段【以前的情况：只能当「以前」说，别当现在】，用于被取代的旧值。

## 1.4.0

**语义抽取的预算与退避**（`lib/memory/extraction.js`）

- 失败不再无限重试：写 `turns.extract_attempts / next_extract_at`，按 30s → 2min → 10min → 30min → 1h 阶梯退避，达到 `extractMaxAttempts`（默认 5）后降为每天一次。
- 补做遗留回合带冷却（`extractRecoverCooldownMs`，默认 10 分钟）与批量上限（`extractRecoverBatch`，默认 3）。
- 每小时自动调用上限 `extractMaxCallsPerHour`（默认 12）：超了队列挂起、一分钟后再来，不丢活也不空转。
- 成功标记会清空退避；`/soul reextract` 重置时一并清退避。
- 背景：此前失败回合不标 `extracted_at`，每个 `llm.onRoute` 都会把它捞回来重试，启动阶段能刷上百条「补做 1 个遗留回合」，并和用户第一条消息抢同一个模型路由。

**注入三级**（`usageOf()` + `renderInjectedMemories()`）

- 注入块按「能不能说出口」分三段：【可以自然提起】/【只影响语气，不要复述内容】/【拿不准／较旧，别当事实说】。

## 1.3.1

- 学习证据链：同一回合不重复扣分；负评只归责真正注入过或文字高度重合的样本，无匹配不扣分；助手自评只提候选，不给自己发认可。
- `/soul replay` 可回放历史反馈。

## 1.2.0

- 跨会话接话：距上一条消息超过 `recapWindowMinutes`（默认 30）分钟，再开口时把上次最后几轮原话接回来。
- 本地语义检索：bge-small-zh（512 维，ONNX），装不上自动退回字面检索。
