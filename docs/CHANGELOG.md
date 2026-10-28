# 更新记录

版本号以 `package.json` 为准。这里只记「行为变了」的部分，纯重构不记。

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
