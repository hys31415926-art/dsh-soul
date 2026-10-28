# 更新记录

版本号以 `package.json` 为准。这里只记「行为变了」的部分，纯重构不记。

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
