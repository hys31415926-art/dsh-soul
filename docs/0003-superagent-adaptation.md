# 0003 · 从 dsh-superagent 借什么，怎么接到 soul 上

读的是 `deepseek-ai/dsh-superagent-prototype`（研究原型，MIT，只有一个提交：`feat: add the dsh-superagent research prototype`）。本地副本在 `C:\Users\HP\Desktop\work\_ref\dsh-superagent-prototype-main`。

## 一、它到底在做什么

一句话：**给一个 GitHub 仓库配一个不下班的机器人同事**——它盯 Issue / PR / CI / 可选飞书群，被允许的人开口才干活，自己开一个会话、一个目录去改代码，答在原对话里（通常是开 PR），面板只列「需要人」的东西。

核心判据不是「能做多少」，而是**「花了人多少注意力」**：

- 只在被请求、或团队写了规则时才动手；没人要的活，默认只记录「我本来会做什么」（`observe` 模式）。
- 只在有人必须行动、或结果能派上用场时说话；干活的中间过程闭麦。
- 一次只问一个具体问题，用结构化字段，不让问题淹在长报告里。
- 按影响停手，不按工作量停手；不要为了不问人而绕过限制。

## 二、领域模型（值得看的部分）

| 概念 | 一句话 | 对我们有意义的点 |
| --- | --- | --- |
| Source | 事件流，带自己的读位点与机器人身份 | 重启不重放事件；「Bot 自己的消息」在进入领域前就丢掉 |
| Trigger | 一个不可变事件 | **幂等单位**：同一个 Trigger 接两次只产生一个工单 |
| Thread | 按时间排的 Trigger 序列 | 同时最多一个 Eval 在跑，避免并发判断打架 |
| Eval | 两层判断：Gate（确定性准入）+ Assessment（模型研判） | 准入先于模型，模型不碰权限 |
| Mandate | 一次接单授予的：策略版本、范围、强度、命中的规则、发起人身份 | **不可变**；只有人喊停或策略失效才撤销；恢复前要重新校验 |
| Ticket | 一段被授权的工作 | 自己定义状态，不跟着执行器走 |
| Assignment | 工单与某个执行器实例的绑定 | 一个工单可以换多次执行器 |
| Subscription | 工单与会话的「订阅」关系 | 后续讨论自动进这个工单，不需要人再 @ 一次 |
| Policy | 带版本号的规则 + 每个 Source 的白名单 / 准入表 / accept 模式 | 规则一变，正在跑的 Eval 作废重排 |

被明确否掉的概念（`docs/001-domain.md` 的 Rejected 表）比留下的概念更有信息量：不做跨 Source 的身份映射、不让 Eval 自己排延时、不给 Eval 加「等待/撤销」状态、不允许工单状态跟着宿主会话走、策略变更不取消在跑的工单只投递变更通知。

## 三、执行侧值得抄的几个机制

1. **阶段（stage）由「在等谁」决定**：`person/answer`＞`person/review`＞`person/blocked|failed`＞`working/queued`＞`idle`＞`working`，从上往下取第一个命中。面板只按这个顺序排。
2. **Report 六态**：`progress` / `waiting` / `ready` / `blocked` / `failed` / `dropped`，结束与恢复全看报告，不看自由文本。
3. **先存后做**：任何「决定之后要做的事」先落库再执行，失败退避重试（2s 起翻倍到 1min；频道消息 5s 翻倍到 300s），同工单同会话的消息保序。
4. **读位点与幂等**：Source 记读到哪了，消息进历史前先认领，重启用恢复提示让执行器先自检。
5. **人工槽位**：并发上限之外留一个槽位给「人直接插话」，保证新活不能挡住人。

## 四、和 soul 的错位（先说清楚，别硬接）

它不是记忆插件：没有「长期记忆」「人格」「关系连续性」，只有工单台账。soul 也不是机器人：没有多并发执行器、没有跨会话授权、没有 Source。**直接把 Ticket / Subscription / Eval 搬进 soul 会变成过度设计**——soul 的场景是一个人跟一个助手，没有「谁有权让谁干活」的问题。

真正可迁移的是四个**判断层**的概念，而不是它的执行机器：

- Mandate：一条记录「为什么可以这样」的授权凭据；
- Policy version：规则文本有版本，变了要通知；
- Stage / Report：状态由「在等谁」决定，不由执行器自报；
- Attention budget：任何输出先算它花人多少注意力。

## 五、落到 soul 上的适配方案

### 5.1 记忆加授权凭据（低成本，收益最高）

现在 `memories.source` 只有 `user-explicit` / `auto`，`soul_judge` 只有 right / wrong。加一个 `mandate` JSON 列（可空）：

```json
{ "strength": "explicit|inferred", "basis": "user-said|rule:xxx|extracted", "policy_version": "p12", "by": "qq:2524316903" }
```

写入路径：`soul_remember`（explicit）、抽取管线（inferred + 规则名）、`soul_judge` 结算（结果是判断来源，不入记忆库）。
读侧：`/soul why` 直接回答「这条凭什么被写、当时依据哪版规则」。这正好补上现在「记忆从哪来」的黑盒。

### 5.2 项目条目加 stage，默认只显示「等人」

`project_items` 已有 `kind / state / acceptance / depends_on`，缺的是「在等谁」。加 `stage`（person 等你 / agent 我在跑 / blocked 卡住）与 `report`（progress / waiting / ready / blocked / failed / dropped）。落地上先做了字段与 `/soul item` 标记：`/soul projects` 把等人的项展开，健康项压成一行计数（「健康：在跑 N」），没有先写一个按 stage 过滤的默认视图——那要等真实使用数据再定。

### 5.3 规则与人格版本化

`prompts/persona.md`、`memory-policy.md`、`interaction-policy.md`、`work-policy.md` 现在改动无痕。存 `meta` 里记 hash + 版本号，注入块带一行「策略版本变了」只在变化那一轮出现一次。这样对应 superagent 的 Policy change → Input 投递，而且不违反注入快照「文本尽量不变」的约束。

### 5.4 注意力预算统一口径

soul 现在有两套预算：`injectBudget`（字符）和 knock 的 `pressure`（想说话强度）。superagent 的判据可以并进来：**先问「这条输出花谁多少注意力、他能不能据此行动」**，再决定进注入块还是进 knock。具体规则：

- 记忆进注入块 = 花注意力但换上下文质量，只在「这一句用得上」时进（现有三级注入已经做了，补一条「无用则静默」）；
- knock = 纯消耗，只在有内容、且对方可能想接时发（现在有冷落/PID，缺「内容价值」这一项）。

### 5.5 会话 → Thread 的订阅（可选，第二阶段）

superagent 最有用的日常机制是 Subscription：后续讨论自动归到工单，人不用再点名。soul 的等价物是 `session_states.active_project_id` + 项目条目，但现在是「一轮一个活跃项目」。可以扩成「这个会话订阅了哪几个项目」，抽取时按订阅自动挂靠，减少 `soul_projects add` 的手动调用。

## 六、建议的落地顺序

1. `mandate` 列 + `/soul why` 展示（只写读两侧小改，不动抽取）；
2. `project_items.stage/report` + `/soul projects` 默认过滤（纯展示与排序）；
3. `prompts` 版本 hash + 变化提示（一次性的注入行）；
4. knock 加「内容价值」判据；
5. 会话订阅项目（依赖 1–2 的数据形状稳定后再说）。

前 3 步都不改抽取与检索的核心路径，回归面小；后 2 步会动到注入与主动消息，建议单独一轮做，并配 `/soul plan` 对照。

## 七、明确不做

- 不做 Ticket / Assignment / Executor 那套并发执行机器（soul 不跑多会话执行）；
- 不做跨 Source 身份映射；
- 不做 `auto` 自动接单（soul 的等价物是自动写记忆，已经用置信度 + 候选池控住，不需要再叠一层 accept 模式）；
- 不把 panel 的整套 UI 搬过来（命令行 `/soul` 足够，超过就是负担）。

## 八、v1.9 补记：双层裁决作为「外置骨骼」

前七条把 superagent 的**可解释性**搬过来了（凭据、在等谁、版本、内容价值）。这一条搬的是它的**判断形状**：Eval 分两层——gate 是确定性的（谁在等、准不准进），assessment 是可解释的（值不值得、急不急）。这两层都不在模型嘴里，而在代码里，所以叫外置骨骼。

落点 `lib/core/eval.js`（纯函数，不碰库）：

- `gateItem(item, { now })` → `{ pass, strength, reason }`。strength 三档：`explicit`（人标了「我在推」）、`inferred`（没标状态但有优先级）、`not-admitted`（在等人、卡住、做完、或者什么都没标）。
- `assessItem(item, { now })` → `{ score, matched }`，0–1。加分项：优先级（1/2/3+ → 0.2/0.3/0.4）、挂了多久（≥3 天 +0.2、≥7 天 +0.3）、写了验收条件 +0.15；扣分项：有前置 −0.05。matched 是给人看的理由短语。
- `evaluateItem(item, { mode })` → `{ decision, strength, score, matched, why }`。decision 五态：`accept / observe / wait / ignore / unavailable`。
- `rankItems(items, { mode })` → 排序后的 `{ item, verdict }`，accept 在前，同档按分数。

接入点：`/soul next` 现在走 `rankItems`，每条后面带一行「判据」（比如「优先级 2、挂了 3 天」）；分组也从「有没有标 stage」变成「裁决结果是什么」。

模式用 `/soul accept observe|auto` 切，存在 `meta.soul.acceptMode`：

- `observe`（默认）：`inferred` 的事只记「本来会做」，在 `/soul next` 里单独列一行，不动手；
- `auto`：`inferred` 且分数 ≥ 0.5 才算数，进「该推的」。

和 §7 里「不做 auto 自动接单」不冲突：那里的 auto 指**外部事件**（GitHub 上的 issue）自动变成工单，而这里的 auto 只在**已经写进项目档案的条目**上生效——档案本来就只有人写进来的东西，没有外部入口，所以它给的是「优先级够高的要不要排前面、标成可接」，不是「我给自己招活」。**它只改排序和标注，不会触发执行；soul 没有执行器。**

护栏没变：`explicit` 不需要打分直接算数；`not-admitted` 一律不动；分数低不等于没价值，只是不着急，`observe` 那条会一直留着。

## 九、v1.9 补记：第 5 步落地（会话订阅项目）

`session_subscriptions(session_id, project_id, created_at)`，主键 `(session_id, project_id)`，新库由 `BASE_SCHEMA` 建、老库同样幂等建（`SCHEMA_VERSION = 17`；v17 同时删除一直没人读写的 `relation_history` 死表）。

规则只有一条：**会话只订阅一个项目时**，`rememberMemory` 没拿到 `projectId` 就自动挂过去；订阅 0 个或 2 个以上都不挂——多个订阅靠猜只会挂错，宁可不挂。显式传了 `projectId` 的照显式走，订阅不覆盖。

命令：`/soul subscribe` 看当前订阅，`/soul subscribe <项目名>` 订上，`/soul subscribe off` 全清。`store.singleSubscriptionProject(sessionId)` 是这个判据的唯一出口，别处不要各写一遍。


