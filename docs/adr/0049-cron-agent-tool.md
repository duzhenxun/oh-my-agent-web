# ADR-0049：会话里的 `cron` 工具 —— 用一句话把定时任务建在当前会话里

- **状态**：Accepted（2026-11-21 实现）
- **日期**：2026-11-21
- **相关**：ADR-0010（单文件职责与行数护栏）、ADR-0034（默认审批模式）、ADR-0048（工具包体系，已移除）
- **代码**：`server/cron/tool.ts`（端口 + 默认值）、`server/engine/pi-cron-tool.ts`（pi 工具）、`server/index.ts`（接线）

## 背景

定时任务原来只有一条入口：界面 →「任务」面板 → 编辑器里逐项填（名称、工作区、提示词、cron、时区、跑在哪条会话）。

用户实际的说法是：「我就在这个会话里说一句『每天早上 9 点看一下这个群的 bug』，你直接给我建好，而且就跑在我这个会话里」。

面板填表做不到这件事的**关键**不是表单太麻烦，而是「跑在哪条会话里」这一项：用户不认为这是一项配置，他的心智模型就是「这个任务属于我和你的这次对话」。

ADR-0048 想用「工具包 + MCP」解决「让 agent 能调宿主能力」，但那套体系整体被移除了（要求用户理解工具包、信任哈希、令牌，与实际需求不符）。所以这里走**引擎原生扩展点**：pi 的 `pi.registerTool`，和现有的 `Agent`（子代理）工具同一条路。

## 决策

### 1. 一个 pi 工具：`cron`

`server/engine/pi-cron-tool.ts` 在每个**真会话**（非预热会话）建起来时注册，动作集合：

```
add | list | update | remove | enable | disable | run_now | preview
```

- 只碰任务定义；要立刻跑一次必须显式 `run_now`，不替用户「先跑一下看看」；
- `preview` 只算下次时间，不建任务 —— 模型先用它校验表达式，再 `add`；
- `list` 的输出带 id、频率、下次时间、跑在哪条会话，模型据此回答或接后续操作。

### 2. 默认绑**当前会话**

`scope` 默认 `session` → `sessionId = 当前会话 id`；`mode` 默认 `agent`（能读文件、能干活），`allow_writes` 默认 `false`（只读）。

理由：
- 用户说「在我这个会话里跑」，指的就是**续跑这条会话**：上下文、模型、工作区都还在，跑完的产出回到同一个对话里接着聊；
- 要独立会话就显式 `scope: new`（每次新开），这比反过来「默认新开、想续跑要再说明」少一次纠正。

默认值补齐的规则放在 `server/cron/tool.ts` 的纯函数里（`cronDraftFromArgs` / `cronPatchFromArgs`），能单测、不依赖引擎。

### 3. 端口很窄，引擎不认识 express

`cron/index.ts` 里有 Router，而引擎层会被单测直接 import。所以定义 `CronToolPort`（create/list/update/setEnabled/remove/runNow/preview），宿主在 `server/index.ts` 用 `createCronToolPort(service)` 实现，引擎只 `import type`。

接线顺序是「引擎先建、cron 服务后建」，所以传给引擎的是**惰性 getter**（`cron: () => cronToolPort`），真正取端口发生在建会话时。

### 4. 审批：写操作要问，`list`/`preview` 不问

`approval/scope.ts` 里 `cron` 算「有副作用」（会在我不知道的时候自动跑），风险说明写明这一点；但 `action=list|preview` 特判为只读 —— 每问一句「现在有哪些任务」都弹确认，比不工作更烦人。

无人值守（定时任务自己跑起来）时的策略是 `deny-writes`，所以**定时任务里的 cron 调用会被拒**：不让一个定时任务自己再造定时任务。

## 后果

- 用户可以在对话里说「每天 9 点……」，模型直接用工具建好，结果里带 id / 频率 / 下次时间，用户可以当场纠正（改频率、取消、改成独立会话）。
- 任务的真实存储没有变：还是 `<dataDir>/cron.json`（`jobs` + `runs`），编辑器面板照旧可读写，两边是同一份数据；面板轮询会自动看到 agent 建的任务。
- **只有 pi 引擎有**这个工具：codex / dsh / opencode / claude 走 ACP 或子进程，没有 `registerTool` 这种宿主扩展点。要在那些引擎上提供等价能力，得另开一条路（MCP server 或它们各自的工具配置），不在本 ADR 范围内。
- 工作区校验放宽了一处：`cron` 服务接受的「已登记工作区」现在包含**已打开会话的工作区**（`state.conversations`），否则在另一个目录里开的会话建任务会被 `workspace is not registered` 挡住。
- 回归测试：`tests/unit/cron-tool.test.ts`（默认值、端口、非法表达式/工作区、run_now）。
