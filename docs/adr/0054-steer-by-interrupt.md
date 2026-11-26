# ADR-0054：非原生引擎的「插队」= 打断续发

- 状态：已采纳
- 日期：2026-11-24
- 相关：ADR-0043（插队按引擎能力降级）、ADR-0023（回合看门狗）、ADR-0058 后续（opencode 待接入）

## 背景

插队的宿主机制在 ADR-0043 时就已经完整了：`SendMode = "now" | "queue" | "steer"`、内存队列、
最小撤回窗口（`STEER_MIN_HOLD_MS`）、step 边界注入（`tool_end` / `usage.final`）、可撤回的待发行、
输入框上的三按钮，全都在。

但只有 pi 真的能用：`PI_CAPABILITIES.steer = true`（走 SDK 的 `streamingBehavior: "steer"`），
而 codex / dsh / opencode / claude 的能力位全写死 `steer: false`，于是用户点「插队」会被
静默降级成排队并弹一句「这个引擎不支持插队」。

用户 2026-11-24 要求补上这四家。

## 决策

给这四家实现**打断续发**，并在能力位上把它和 pi 的原生插队区分开：

```
steer: true, steerMode: "interrupt"
```

语义：**打断当前轮 → 把这条消息作为下一轮立刻发出**。

- codex：`turn/interrupt` 等 `turn/completed`，然后 `turn/start`；
- ACP 三家（dsh / opencode / claude）：`session/cancel` 等 `session/prompt` settle，再发下一条。

pi 保持 `steerMode: "native"`（不写该字段时按 `native` 处理，兼容老快照与旧前端）。

## 为什么不能照 pi 那样做

pi 的 `streamingBehavior: "steer"` 是**同一轮内插入**：turn 不结束，模型下一次采样就看到这句话。
codex 的 app-server JSON-RPC 和 ACP 的 `session/prompt` 都没有等价语义 ——
一个会话同时只能跑一条 prompt。

绕过 ACP 去拿厂商原生能力（opencode 的 HTTP `session.abort`、codex 更底层的 turn 语义）被否掉：
会与引擎自己的 TUI/Desktop 双写会话、抢写锁，还要各自维护一套事件映射，收益不抵成本。

## 实测证据（codex-cli 0.171.0，`scripts/probe-interrupt.mts`）

| 问题 | 结果 |
| --- | --- |
| 工具正在跑时 `turn/interrupt` | `turn/completed(status=interrupted)` 约 **34–84ms** 到达 |
| 被打断的工具会不会补 `tool_end` | **不会**（所以工具卡必须由宿主收尾，见下） |
| settle 之后立刻 `turn/start` | 成功，约 0.6–0.9s 完成一轮 |
| **回合在飞时再发一条 `turn/start`** | **不报错、不排队** —— 静默覆盖 adapter 的 `active` 槽：上一轮 promise 永不 resolve，且它的 `turn/completed` 会被路由到新那一轮的监听器（实测 8s 不返回） |

最后一行是这条路的真风险：所以加了单飞守卫（见下），**先有守卫再谈插队**。

## 实现要点（按踩坑顺序）

1. **单飞守卫**（`server/engine/codex.ts` 的 `sendMessage`）：`active.has(sessionId)` 就抛
   `这个会话已经有回合在跑`。有它，插队实现写错最坏是「插队失败」；没它，最坏是「整个会话永久 busy」。
2. **`interruptAndSettle`**（`EnginePort` 新增可选方法）：打断并**等这一轮落定**，5s 超时返回 false。
   codex 等 `turn/completed`；不实现的引擎由队列层 `interrupt` + 轮询 `isTurnRunning` 兜底。
3. **不自己再发一条**：插队项**留在队列里**，由回合收尾的排空当下一轮发出
   （`shiftQueued: queue.shiftSteerFirst`）。理由：落盘、看门狗、流式显示全链都已挂在排空那条路上，
   再写一条发送路径就是「重复 user 消息 / 两个 assistant id 互相覆盖」这类 bug 的源头。
4. **排空时插队优先**（`shiftSteerFirst`）：interrupt 档的插队项在注入前一直留在队列里，
   若队列里先排着普通排队消息，`shift` 会把它先发出去 —— 用户点了插队却在跑之前排的那条。
5. **提示语要认账**：`interruptReasonOf` 区分「插队造成的 interrupted」与用户点停止 / 看门狗超时，
   前者说「已插队：当前步骤停了，接着处理你刚发的那句」，而不是「回合已中断」（那句像出错了）。
6. **被打断的工具卡必须收尾**：引擎不补 `tool_end`，`settleRunningTools` 在回合收尾时把还挂在
   `running` 的工具块补成 `status: "interrupted"`（新增状态，中性色 + 「已打断」，不是红色的 `failed`）。

## 已知差异（对用户如实呈现）

- pi 的插队是「同一轮多一句」，transcript 上不留分界；
- interrupt 档是「这一轮停下，下一轮开始」，transcript 上**必然**有一条被标成已打断的收尾。
  输入框的 `title` 按 `steerMode` 分别写文案，不把两者混为一谈。

## 风险与残留

- 打断正在跑的工具 = 那个操作被掐掉（写了一半的文件、跑一半的命令）。所以保留了最小撤回窗口，
  用户在**打断发生前**能取消；打断后工具卡明确显示「已打断」，不假装完成了。
- 队列项仍只在内存里（ADR-0030 的已知缺口），进程重启会丢 —— 本次未改。
- `INTERRUPT_SETTLE_MS = 5000` 超时就降级成排队并明说，不让用户对着「已插队」空等。

## 落地顺序

1. **codex**（已落地）：单测 `steer-interrupt` / `tool-interrupted`；
2. **opencode**（已落地）；
3. **dsh**（已落地）；
4. **claude**（已落地）。

四家全部通过真引擎集成测试 `tests/integration/steer-interrupt-engines.test.ts`
（表驱动，没装 CLI 的那项自动跳过）。以后接新引擎：往表里加一行 + 在 builtin.ts 开 `steerMode`。

现在只剩 pi 是 `steerMode: "native"`（真插队），其余四家统一是 `"interrupt"`（打断续发）。

## 各引擎实测差异（同一套机制，每家脾气不同）

| | codex 0.171.0 | opencode v2.3.2 | dsh 0.2.0-rc.2 | claude 2.1.301 |
| --- | --- | --- | --- | --- |
| 打断 → settle | 34–84ms | 65ms | 21ms | 147ms |
| 被打断的工具会补 `tool_end`？ | **不会** | 会（补一个被取消的） | 会（补一个 failed 的） | **不会** |
| 在飞时再发一条 | **静默覆盖 active 槽**（8s 不返回） | 对端拒（`Session already has an active ACP prompt`） | 对端拒（`a prompt is already in flight`） | **静默覆盖 active 槽**（8s 不返回） |
| settle 后立刻续发 | 0.6–0.9s 成功 | 1.5s 成功 | 0.7s 成功 | 0.85s 成功 |

两条结论：

1. **单飞守卫四家都要**（不只是 codex）：codex 与 claude 会静默覆盖 active 槽 —— 这是唯一会导致
   「会话永久 busy」的失败模式；dsh 与 opencode 虽然对端会拒，自己拦一下更快、文案也不依赖对端版本。
2. **`settleRunningTools` 对四家都无害且对 half 家必需**：codex 与 claude 不补 `tool_end`，
   不兜底就会留一张永远转圈的工具卡；opencode 与 dsh 会自己补，该函数幂等所以不会改坏它们。

这张表就是为什么不能“统一抽象成一次 `interrupt()` 调用”：各家在“打断之后工具怎么收尾”上不一致。
