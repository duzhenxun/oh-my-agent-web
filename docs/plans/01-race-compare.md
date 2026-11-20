# 计划 01:多引擎并跑对比(Race / Compare)

- **状态**:计划中,未实现
- **体量**:大(需要引擎多实例并存,是三项里架构改动最大的一项)
- **依赖**:无
- **相关现状**:`server/engine/switchable.ts`、`server/session/engine-switch.ts`、`server/session/fork-session.ts`、`server/files/git-info.ts`、`server/engine/fake.ts`

## 1. 目标与非目标

**目标**:同一个 prompt 同时派给 2–3 个引擎,每个跑在独立的 `git worktree` 里;结果并排展示(状态、耗时、token、成本、改动文件、结论摘要);用户采纳其中一个结果后回到主工作区,其余丢弃。

**非目标**(v1 不做):

- 不做跨引擎的会话状态共享。每条 lane 仍是一个普通的引擎会话,会话文件仍归引擎所有。
- 不自动解决合并冲突,冲突只报告、交给用户。
- 不替代「分叉」。分叉是同引擎、同上下文的延续;并跑是同一任务的多次独立尝试。

## 2. 现状约束(决定方案形状)

| 约束 | 证据 | 含义 |
|---|---|---|
| 引擎是全局单槽 | `server/engine/switchable.ts` 的 `createSwitchableEngine` 只持有一个 `EnginePort` | 并跑需要引擎实例池,每条 lane 一个实例(或一个可多会话的实例) |
| 切引擎时回合在飞会被拒绝 | `server/session/engine-switch.ts` 文件头注释 | 并跑绕开切换流程,不能复用「切引擎」入口 |
| 引擎作用域状态 | 会话、模型、审批、provider 表都按引擎划分 | 每条 lane 需要自己的模型/审批视图 |
| 没有 worktree 代码 | 全仓库 grep 仅命中 `.git` 文件兼容与注释 | 需要从零实现 worktree 管理 |
| 分叉只能同引擎 | `fork-session.ts` 依赖引擎的 `createSession({fork})` | 「同上下文派给不同引擎」需要把源会话转成文本重新注入 |
| 审批按会话 | `snapshot/state.ts` 的 `approvalByConversation` | 各 lane 审批互不干扰,可以接受 |

## 3. 方案

### 3.1 核心思路

每条 lane = **一个 worktree + 一个引擎会话**。lane 只写自己的 worktree,主工作区在采纳前完全不动。这样并跑的写入风险被隔离在 worktree 里,也让「采纳」成为唯一会改动主工作区的动作。

### 3.2 模块划分

```
server/files/worktree.ts          git worktree 的 add / list / remove / prune,diffstat,生成 patch
server/race/engine-pool.ts        按引擎名持有实例;为 lane 分配实例;回收
server/race/race-runner.ts        编排:建 worktree → 建会话 → 发同一 prompt → 订阅每条 lane 的回合事件
server/race/race-store.ts         对比记录的元数据(<dataDir>/races/<id>.json,tmp+rename 原子写)
server/race/race-routes.ts        HTTP 路由(挂在 authMiddleware 之后)
server/race/race-adopt.ts         采纳 / 丢弃
web/src/components/CompareView.tsx       右侧面板的对比视图(一个 PanelItem 类型 compare)
web/src/components/CompareStartDialog.tsx 发起对比:选引擎(2–3)、选 prompt、显示预估成本
web/src/components/CompareCard.tsx        单条 lane 的卡片
tests/race/*.test.ts
```

### 3.3 数据与目录

- worktree 路径:`<dataDir>/races/<raceId>/<engine>/`,分支名 `race/<raceId>-<engine>`,基于主工作区当前 HEAD 创建。
- 对比记录只保存元数据(raceId、prompt、lane 列表、每条 lane 的 conversationId、状态、采纳结果)。会话内容仍由引擎落盘,与「引擎文件是事实源」的硬规则一致。
- lane 的会话在侧边栏隐藏:按 raceId 过滤,并且 worktree 路径**不得**加入 `piProjects`(否则会在侧边栏多出一个项目)。

### 3.4 运行流程

1. 前端 `POST /api/races`:`{ prompt, engines: ["pi","claude"], workspace }`,服务端校验 2–3 条、引擎可用、工作区是 git 仓库且有提交。
2. 对每条 lane:`worktree.add()` → `enginePool.acquire(engine)` → `engine.createSession({ workspace: worktreePath })` → `sendMessage(prompt)`。
3. 订阅 lane 的回合事件(已有 `turn_end` 事件按 conversationId 派发,见 `server/session/turn-events.ts`),更新 lane 状态:`running / done / failed / interrupted`。
4. 每条 lane 结束后计算:耗时、token/成本(复用 `session-stats` 对该会话的统计)、`git diff --stat` 改动文件数、最后一条 assistant 文本作为结论摘要。
5. 用户采纳:见 3.5。丢弃:`worktree.remove(--force)` + 删分支 + 更新记录。

### 3.5 采纳

默认方案:**生成 patch 再应用**。

- 对 lane worktree 执行 `git diff HEAD` + 未跟踪文件清单,生成 patch(包含新增文件)。
- 在主工作区先复用 `checkoutBranch` 的脏检查:主工作区有未提交改动时,先提示用户,不强行覆盖。
- `git apply --3way` 应用到主工作区;冲突则保留 patch 文件并报告,不自动解决。
- 不在 lane 分支上做 commit,提交仍由用户或 agent 决定(保持「web 端不提交」的既有原则)。

备选方案(待决策,见第 6 节):在 lane 分支 commit 后 `merge --squash`。

### 3.6 引擎实例池

这是本计划的最大风险点,需要先做 Phase 0 验证:

- pi:进程内 SDK,同一实例是否能并发管理多个会话(`pi-sdk` 内部按 sessionId 管理,需确认并发回合互不干扰)。
- claude / codex / opencode:子进程或 JSON-RPC 型适配,理论上可多实例,但要确认各自的并发上限与认证方式。
- codex 的 writer lock(`port.ts` 的 `parkSession`):并跑时可能冲突,需要验证。

池的形态:`Map<engineName, EnginePort[]>`,每条 lane 独占一个实例直到 lane 结束;主槽 `SwitchableEngine` 保持不变,服务用户正在看的会话。

## 4. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 验证** | 写一个脚本:在两个 worktree 中同时跑 pi 与 fake 引擎;确认 pi 同实例并发、claude/codex 多实例可行、codex writer lock 行为 | 结论写入本文档第 6 节;决定实例池形态 |
| **P1 worktree** | `server/files/worktree.ts` + 单测(用临时 git 仓库) | 创建/列出/删除/patch 生成全部通过;空仓库、无提交、脏工作区均有明确错误 |
| **P2 编排** | `engine-pool.ts`、`race-runner.ts`、`race-store.ts`、路由;用 `fake.ts` 引擎跑通端到端 | 两条 fake lane 并发完成,记录正确落盘,重启后可恢复列表 |
| **P3 采纳/丢弃** | `race-adopt.ts`,冲突与脏工作区的处理 | 采纳无冲突 patch 成功;冲突时主工作区未被改坏 |
| **P4 前端** | 发起对话框、对比视图、卡片;右侧面板挂载 | 浏览器测试:发起 → 两条并排 → 采纳 |
| **P5 收尾** | 孤儿 worktree 启动时清理(对比记录缺失的目录);成本预估;lane 数上限;文档与 README 对比矩阵加一行 | 异常退出后重启能清理孤儿 worktree |

## 5. 测试策略

- **单测**:worktree 模块全部用临时 git 仓库;patch 生成与应用用固定夹具。
- **集成**:用 `server/engine/fake.ts`(脚本化引擎,零 token)跑完整流程,避免真实模型成本。
- **真实引擎冒烟**:P0 之后手工跑一次 pi + claude,记录结果。

## 6. 风险与待决问题

**风险**

- `node_modules`、`.env` 等被 gitignore 的文件不在 worktree 里,lane 中的构建和测试可能直接失败。备选:对大目录做符号链接(需评估副作用)。
- N 条 lane = N 倍 token 与成本。发起前必须显示预估,并限制 2–3 条。
- 并跑时各引擎的认证与并发限制不同(例如订阅类账号的并发额度)。
- worktree 中的 pi 会话按 cwd 分目录,与主库的会话列表对不上,需要过滤。

**待决问题(需要你拍板)**

1. 采纳方式:默认 patch 应用(不提交),还是在 lane 分支 commit 后 merge?
2. 是否允许 claude 与 codex 同时参与,还是 v1 只允许 pi 与一个其他引擎?
3. lane 的审批模式默认值:`allow`(与全局一致)还是 `ask`(更安全但需要逐条确认)?
4. 对比记录的保留期限(建议 30 天后自动清理 worktree,保留元数据)。

## 7. 验收标准(整体)

- 两个引擎同时完成同一任务,各自的改动只出现在各自的 worktree 中,主工作区在采纳前无变化。
- 采纳后主工作区与直接在 lane 中完成的改动一致;丢弃后无残留 worktree 与分支。
- 异常退出后重启,孤儿 worktree 被识别并可清理。
