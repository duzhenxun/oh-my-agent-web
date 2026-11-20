# 计划 03:事件触发自动化(Triggers)

- **状态**:计划中,未实现
- **体量**:中到大。主要难点不在触发本身,而在「无人值守地执行 agent」的安全边界。
- **依赖**:无硬依赖。建议在计划 02 的用量看板之后做,因为无人值守运行需要成本可见。
- **相关现状**:`server/cron/index.ts`、`server/index.ts`(cron 的 `execute`)、`server/session/turn-events.ts`(`turn_end`)、`server/session/turn-finish.ts`、`server/http/auth.ts`(`decide()`)、`server/approval/read-only.ts`、`server/push/push.ts`

## 1. 目标与非目标

**目标**:在现有定时任务之上,增加三类可以驱动 agent 工作的触发器:

- T1 **回合结束链**:某个会话的一轮结束后(且结果正常),自动发送下一条指令(例如「测试失败则修复」)。
- T2 **工作区事件**:git 分支/HEAD 变化,或工作区文件变化(带防抖),触发一次 agent 运行。
- T3 **入站 webhook**:本机脚本、CI 或告警系统通过带 token 的 HTTP 请求触发一次 agent 运行。

每次运行的结果通过 Web Push 通知。

**非目标**

- 不做通用的「工具包 / 工具市场」。ADR-0048 已因过度复杂而移除,本计划只做触发,不引入新的扩展体系。
- 不做多用户权限模型。
- v1 不做 HMAC 签名与重放防护(列为后续项,见第 8 节)。

## 2. 现状约束

| 约束 | 证据 | 含义 |
|---|---|---|
| cron 的执行只是单次文本补全 | `server/index.ts` 的 `createCronService({ execute })` 调用 `completeOnce`,system 提示明确「不声称读取过文件」 | **cron 不能驱动 agent 干活**。必须新增「会话执行」路径,不能只加触发器 |
| cron 无推送 | cron 运行结束后不调用 `pushStore.send` | 需要注入推送回调 |
| cron 持久化 | `<dataDir>/cron.json`,tmp+rename,无 fsync | 对运行记录可接受;触发器的安全相关状态需要更严格 |
| 回合结束有现成事件 | `turn-events.ts` 的 `turn_end` → `context.onTurnEnd(conversationId, reason)` | T1 直接挂在这里,不改引擎适配层 |
| 鉴权对本机无条件放行 | `auth.ts` 的 `decide()`:本机判定 = loopback 地址 + loopback Host | webhook 需要单独的放行分支,且要防止同机反代把远程请求当成本机 |
| 仓库中没有文件监听 | grep 无 `fs.watch` / `chokidar` | T2 需要新增,macOS 上递归 `fs.watch` 行为需要实测 |
| 审批在无人值守下会卡住 | `approval-bridge.ts`:`ask` 模式下请求一直挂起直到 `cancelPending` | 触发器运行必须有明确的审批策略,不能默认 `ask` |
| 已有只读审批 | `server/approval/read-only.ts` | 可作为触发器运行的默认策略 |

## 3. 核心设计

### 3.1 统一的运行器

新增 `server/triggers/trigger-runner.ts`:

```
trigger 事件 ──► 去重/冷却/防环检查 ──► 排队(全局同一时间最多 1 条触发运行)
             ──► 新建会话(或复用指定会话) ──► 发送 prompt ──► 等待 turn_end
             ──► 记录结果 ──► Web Push
```

- 运行的会话与普通会话一样出现在侧边栏,但带 `origin: "trigger:<id>"` 标记,并归入「自动」分组,便于辨认。
- 每次运行的记录存 `<dataDir>/triggers/runs.json`,只保留最近 200 条。
- 复用现有 20 分钟回合超时(`AGENT_WEB_TURN_TIMEOUT_MS`,由 turn-watchdog 执行)。

### 3.2 无人值守的审批策略

这是安全上的关键决定:

- 触发器运行的默认审批模式为 **只读**(`approval/read-only.ts`)。写操作直接拒绝,并在运行结果中说明被拒绝的工具调用。
- 允许写入是触发器上的显式开关,开启时在界面上给出醒目的风险提示。
- 不允许 `ask` 模式:无人在场时它只会挂起。

### 3.3 防环与限流

- **链深度**:T1 的回合链最多 3 层;超过则停止并通知。
- **冷却**:同一触发器两次运行之间至少间隔 30 秒(可配置)。
- **全局并发**:同一时间最多 1 条触发运行,其余排队;队列上限 20(与 cron 一致)。
- **事件合并**:T2 的文件变化在防抖窗口(例如 3 秒)内合并为一次。

## 4. 三类触发器

### T1:回合结束链

- 配置:`{ sourceConversationId, onOutcome: "completed", prompt, maxDepth }`。
- 挂载:`turn-events.ts` 的 `turn_end` 之后,通过 `runtime-types.ts` 增加的 `onTurnEnd` 钩子异步分派。钩子必须异步化,不得阻塞 `turn-finish.ts` 的收尾与队列推进。
- 只在 `reason` 为正常完成时触发,被中断或报错时不触发。
- 链深度通过运行记录中的 `depth` 字段传递。

**注意**:T1 的 prompt 是否在同一会话中继续,还是新开会话?建议默认**同一会话继续**(便于「修复测试」这类上下文连续的场景),并在配置中可选「新会话」。

### T2:工作区事件

- git:每 30 秒轮询 `git rev-parse HEAD`(或 `.git/HEAD` 与 `.git/refs/heads/`),HEAD 变化时触发。选择轮询而非 `fs.watch` 是为了跨平台稳定。
- 文件:对配置的 glob(例如 `src/**/*.ts`)使用 `fs.watch`,排除 `node_modules`、`.git`、`dist`,防抖 3 秒。
- 触发后的运行模式同 T1,默认新会话。

### T3:入站 webhook

- 路由:`POST /api/hooks/:id`,请求头 `Authorization: Bearer <token>`。
- token 存储:`<dataDir>/triggers/tokens.json`,权限 0600,**只存 sha256 摘要**,创建时只显示一次。
- 放行位置:在 `authMiddleware` 中新增分支——路径为 `/api/hooks/*` 且 token 有效时放行,**不走 cookie 登录**。token 无效的请求计入独立的失败计数,超过阈值临时封禁该来源(复用 `login-guard.ts` 的思路,但计数器独立,避免与密码登录互相影响)。
- 请求体上限 64KB;body 作为 prompt 的附加上下文(模板变量,例如 `{{body}}`),不直接拼成指令。
- 远程访问:服务默认只监听 `127.0.0.1`。webhook 从其他机器访问需要 `-H 0.0.0.0` 且已设置访问密码,此时 webhook 仍只靠 token 鉴权。

**安全风险(必须在实现前写入 ADR)**:

- 同机反代的 XFF 与 Host 判定:`decide()` 对 loopback 无条件放行,反代转发的远程请求可能被当成本机。webhook 分支不能依赖 `decide()` 的本机判定,要单独校验 token。
- 暴力枚举 token:限流 + 失败封禁 + 长随机 token(至少 32 字节)。
- 重放:v1 不做。后续可加 `X-Timestamp` + HMAC。

## 5. 分阶段实施

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0 设计评审** | 写 ADR:无人值守审批策略、webhook 鉴权边界、防环规则 | ADR 通过评审 |
| **P1 运行器** | `trigger-runner.ts`、运行记录、并发队列、防环、Web Push 结果通知;用 `fake.ts` 引擎测试 | 触发 → 新建会话 → 完成 → 推送;队列与冷却正确 |
| **P2 T3 webhook** | token 存储、路由、鉴权分支、限流封禁 | 无 token 401;错误 token 多次后封禁;正确 token 触发运行;cookie 登录流程不受影响 |
| **P3 T1 回合链** | `onTurnEnd` 钩子、深度限制 | 正常完成触发下一轮;中断/报错不触发;深度 3 后停止 |
| **P4 T2 工作区** | git HEAD 轮询、文件 watch + 防抖 | 切分支触发一次;批量保存只触发一次 |
| **P5 前端** | 触发器列表与编辑器(可放在 CronPanel 的新标签页)、运行记录、token 生成对话框 | 浏览器测试:创建 webhook → 复制 token → 外部 curl 触发 → 面板显示结果 |

建议顺序:P0 → P1 → P2 → P3 → P4 → P5。T3 的安全风险最高,但它也是「外部系统驱动 agent」的核心价值,所以放在前面、并且单独评审。

## 6. 与现有 cron 的关系

两种方案,待决策:

- **方案 A(推荐)**:新建 `triggers` 模块。定时部分复用 cron 的 cron 表达式解析与时区计算(抽成公共函数),但执行路径分开。cron 保持「单次文本补全」的轻量语义,不被改变。
- **方案 B**:给 `CronJob` 增加 `kind: "text" | "agent"`。复用调度与面板,但 `agent` 类任务的安全策略与 `text` 完全不同,容易混淆。

## 7. 测试策略

- 运行器:用 `fake.ts` 引擎,断言状态流转与推送调用。
- 鉴权:对 `decide()` 与新增的 webhook 分支分别做单测,覆盖:本机请求、反代 XFF 远程请求、无 token、错 token、封禁期内请求。
- 防环:构造 A→B→A 的链,断言深度上限生效。
- 文件 watch:用临时目录写入多次,断言防抖后只触发一次。

## 8. 风险与待决问题

**风险**

- 无人值守 + 写入权限 = agent 可以在用户不在场时修改工作区。默认只读,写入需要显式开启,这是底线。
- 触发器产生的会话大量堆积在侧边栏。需要「自动」分组与自动归档策略。
- 事件风暴(文件保存、CI 重试)。需要防抖、冷却、队列上限三重保护。

**待决问题**

1. 方案 A 还是方案 B(见第 6 节)?
2. T1 默认「同一会话继续」还是「新会话」?
3. webhook 是否要 v1 就做 HMAC 签名,还是 token 足够,HMAC 放到 v2?
4. 触发器运行的成本上限:是否需要「单次运行最大 token」?(依赖计划 02 的用量数据)
5. 运行记录保留 200 条是否足够,还是按天保留?
