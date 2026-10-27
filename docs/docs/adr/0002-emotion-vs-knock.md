# ADR 0002 — 情绪归 soul，主动性归 knock

- 状态：已采纳（2026-10-26）
- 相关：soul v1.3（emotion 模块）、dsh-knock v0.1.0

## 背景

主人要求「一个会主动找我的机制」：隔一段时间没说话，就自己发一条 QQ；情绪会影响主动性的强弱（闹别扭就不想发，开心就多发）。可选做法有两种：

1. 全部塞进 soul：soul 既存情绪又负责定时发消息。
2. 拆成两层：soul 存情绪、判情绪；knock 单独一个插件，读 soul 的情绪，决定发不发、发什么。

## 决策

选 2。soul 负责「我现在是什么心情」，knock 负责「这种心情下要不要主动开口」。

- **soul 侧**：`emotion` 表（全局单行：valence、label、reason、updated_at）；每轮对话后异步判一次，平滑融合、随时间衰减；每轮注入一行「我现在的心情：…」；`soul_mood` 工具可查。soul 不依赖 knock。
- **knock 侧**：独立包 `dsh-knock`，只读 `soul.db`（最近互动、最近 3 轮、记忆、情绪），自己维护状态机与类 PID，只在「够格」时生成并发送，发完写回 soul 的 turns（session `knock`）。
- **档位换算**：soul 的 valence → knock 的 3 档（normal / glum / angry），只在 knock 内部换算，不写回 soul。

## 理由

- **职责分离**：情绪是记忆/人格层的东西，会影响每一轮怎么说话；主动性是行为层的东西，只在「该不该开口」这一个时刻有用。混在一起会让 soul 每轮都背着定时器和发送逻辑。
- **可拆**：拆掉 knock，soul 只剩「有心情但不主动」，这是可以接受的降级；反过来把情绪塞进 knock，soul 就没法在被动回复里带心情。
- **避免循环依赖**：knock 读 soul 的库是单向依赖（只 attach 打开），soul 完全不知道 knock 存在。
- **失败隔离**：knock 的发送失败、模型失败都不影响 soul 的主流程；soul 的情绪判定失败也不影响 knock 继续按时间跑。

## 后果

- knock 需要配置 `soulDbPath`，且必须和 soul 的 dbPath 指向同一文件（当前都是 `~/.dsh/dsh-soul/soul.db`）。
- 情绪判定在 soul 里是「异步、可失败、失败不改旧值」，所以 knock 拿到的可能是几小时前的心情——这符合「情绪不该突变」的要求。
- 闹脾气档位不落盘、只做换算：如果以后想要「档位也随时间加深」，要在 soul 的 evolve 里加，而不是在 knock 里加。
- 换 embedding 模型时 knocket 无需变动（knock 不做向量检索）。
