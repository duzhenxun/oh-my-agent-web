# 对比：给 coding agent 配 Web 界面的几种做法

> 这份对比的目的是帮你判断「我该用哪个」，不是踩别人抬自己。
> 每条结论都来自对对方仓库的实际核对（README / 依赖 / 源码目录），核实日期 **2026-11-03**；
> 这些项目都在活跃开发，如果你发现哪条过时了，欢迎提 issue 或直接 PR 改掉。
>
> 先放结论：**没有谁是全方位的赢家**。选型的分界线不是「功能多少」，而是三件更底层的事——
> 会话的事实源放在哪、你要不要账号体系、你用的是单个引擎还是好几个。

---

## 一、先看你自己属于哪种情况

| 你的情况 | 更可能适合 |
|---|---|
| 只用 Claude Code，想要一个功能很全、带项目管理的界面 | CloudCLI |
| 只用 Codex CLI | Codex WebUI |
| 只用 pi，且想要 worktree 切换、会话内分支这类 pi 专属操作 | Pi Web |
| **pi / Codex / Claude Code / opencode 混着用**，或不想给每个引擎各装一个界面 | oh-my-agent-web |
| **不想引入数据库和账号体系**，会话只想留在引擎自己的落盘文件里 | oh-my-agent-web / Pi Web |

---

## 二、四个维度横向对比

### 1. 本机运行还是云端

| 方案 | 本机自托管 | 云端 SaaS |
|---|:-:|:-:|
| **oh-my-agent-web** | ✅ 默认只听 `127.0.0.1` | ❌ 没有云端版本 |
| CloudCLI | ✅ 开源自托管 | ✅ 另有 CloudCLI Cloud |
| Codex WebUI | ✅ | ❌ |
| Pi Web | ✅ | ❌（另有一个纯前端、无真实模型的演示站） |

这一条大家都不算短板。真正的差别在下面两条。

### 2. 支持几个引擎

| 方案 | 引擎 |
|---|---|
| **oh-my-agent-web** | **pi / Codex / Claude Code / opencode / DeepSeek Harness**，各跑各的原生 loop |
| CloudCLI | Claude Code / Codex / OpenCode / Cursor CLI |
| Codex WebUI | 仅 Codex CLI |
| Pi Web | 仅 pi |

多引擎不是「同一个 prompt 换个皮」。oh-my-agent-web 里每个引擎走自己的接入方式（pi 用原生 SDK，Codex 走 app-server JSON-RPC，Claude Code / opencode 走 ACP），能力差异由 `server/engine/registry.ts` 的能力矩阵如实呈现——引擎没有的功能，界面直接藏起来，不拿别的引擎的配置冒充。

### 3. 会话存储在哪（最容易被忽略、但最该先想清的一条）

| 方案 | 会话事实源 | 是否另建数据库 |
|---|---|---|
| **oh-my-agent-web** | **就是引擎自己的落盘文件**（JSONL / thread），网页只读它、改名、必要时删它 | **不引数据库，不建账号体系** |
| CloudCLI | 读写 `~/.claude`（会话确实来自引擎） | **另建 SQLite**：存账号、项目、API key、推送订阅、通知偏好等 |
| Codex WebUI | 通过 `codex app-server` | **另建 SQLite**（better-sqlite3 + Drizzle） |
| Pi Web | 读 `~/.pi/agent` 的 session JSONL | 未见独立会话数据库 |

这里要说句公道话：**CloudCLI 和 Pi Web 的会话同样来自引擎的落盘文件**，「读 CLI 自己的会话」并不是 oh-my-agent-web 独有。

真正的区别是——oh-my-agent-web 把「不引数据库」当成一条硬纪律：**除了引擎自己写的文件，它不维护第二份会话副本，也不引入账号 / 凭据 / 订阅之类的存储**。你 `ls` 一下数据目录，看到的就是引擎写的那些文件，没有一层额外的 schema 需要迁移。代价也很直接：多用户、权限、团队协作这类需要账号体系的能力，它**天然不做**。

### 4. 回合中途的交互能力

| 方案 | 中途插话（steer） | 说明 |
|---|---|---|
| **oh-my-agent-web** | ✅（pi 引擎） | pi SDK 的 `streamingBehavior: "steer"`，插话立刻生效、作为下一条指令进入当前回合；其他引擎没这个语义时**降级成排队**，不硬发第二条冲掉活跃回合 |
| opencode | ✅ | opencode 自己的协议里有 `steer` / `queue` 两种投递方式 |
| CloudCLI / Codex WebUI / Pi Web | 未能核实 | 有「中断 / 停止」不等于「不中断地插入当前回合」，两者别混为一谈 |

oh-my-agent-web 在交互上另外多给三样东西：**把一段话圈出来提意见（标注）**、**另开一条不落盘的临时对话问一句就走**、**子代理面板**（pi 引擎）。这些属于「过程可干预」的延伸，不是每家都有。

---

## 三、一句话总结各自的位置

- **CloudCLI**：功能最厚的「Claude Code 工作站」，自带数据库、账号、插件体系，还有云端版。你要的是全家桶，它很合适；你只想要一个不加存储的界面，它就重了。
- **Codex WebUI**：Codex CLI 的专用前端，NestJS + Socket.IO，带终端和插件市场。
- **Pi Web**：pi 的专用前端，和 oh-my-agent-web 一样读 pi 的落盘会话，另提供 worktree 切换、会话内分支等 pi 专属操作。
- **oh-my-agent-web**：**多引擎 + 不引数据库 + 过程可干预**。它不为某个引擎做最深的定制，而是给「混用多个 agent、又不想多一层存储」的人一个统一的工作台。

---

## 四、核实来源

| 结论 | 来源 |
|---|---|
| CloudCLI 引擎范围 / 云端版 / 自托管 | [siteboon/claudecodeui README](https://github.com/siteboon/claudecodeui) |
| CloudCLI 另建 SQLite（账号 / 项目 / 凭据 / 推送等） | `server/modules/database/`（`connection.ts`、`migrations.ts`、`repositories/*`） |
| CloudCLI 会话来自 `~/.claude` | README：「reads from and writes to the same `~/.claude` config…」「auto-discovers every session from your `~/.claude` folder」 |
| Codex WebUI 技术栈 / SQLite | [LimLLL/codex-webui](https://github.com/LimLLL/codex-webui)：`src/database/`、README「SQLite (better-sqlite3 + Drizzle ORM)」「codex app-server（子进程）」 |
| Pi Web 读 pi 落盘会话 | [agegr/pi-web README](https://github.com/agegr/pi-web)：「reads pi data from `~/.pi/agent`… session files under `sessions/<encoded-cwd>/<timestamp>_<uuid>.jsonl`」 |
| opencode 的 steer / queue | opencode 源码中的投递方式定义 |
| oh-my-agent-web 各项 | 本仓库 `README.zh.md`、`server/engine/registry.ts` |

> 旧地址说明：`siteboon/claude-code-webui` 现已不可访问，同一作者的活跃仓库是改名/扩展后的 `siteboon/claudecodeui`（CloudCLI）。本文以当前仓库为准。
