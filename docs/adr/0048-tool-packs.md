# ADR-0048：工具（工具包）—— 挂在系统上、所有引擎可用的本地工具

- **状态**：**Removed（2026-11-19 整体移除）** —— 原为 Accepted（P0–P3 已实现）
  - 移除原因：这套「工具」体系要求用户理解工具包、信任哈希、MCP 接入与令牌，与实际需求不符。
  - 同时移除：`server/tool-packs/`、`tool-packs-bundled/`、界面的「工具」面板与 `tools` 入口、
    内置的 `dws` 与 `cron` 两个工具包、以及引擎侧的原生注入（`HostTool` / `hostTools`）。
  - 本文件保留**仅作决策历史**：它解释过为什么当初要走这条路、以及踩过哪些坑；
    代码里已没有对应实现。
- **日期**：2026-11-18
- **编号**：暂定 0048。代码里最大已引用编号为 0047，落地前确认没有撞号。
- **相关**：ADR-0006（审批粒度）、ADR-0010（单文件职责与行数护栏）、ADR-0020 §P1（`settings.json`）、ADR-0031（鉴权）、ADR-0034（默认审批模式）、ADR-0045（面板跟随引擎）、ADR-0047（网页代理）

## 背景

目标：把一组本地能力（首个样板是钉钉 DWS）**附加在 oh-my-agent-web 系统上**。装上以后，任何任务、任何 Agent 都能调用，工具本身与引擎无关：pi、codex、claude、opencode 的会话，子代理，系统内部的定时或自动化任务，以及「工具」页手动执行，都走同一套核心。

和现有「插件」的区别：

- 截图里的「插件」按钮对应的是 **pi package**（`settings.json` 的 `packages`，`server/engine/pi-plugins.ts`）。它只属于 pi，有自己的安装、启停、面板。
- 本 ADR 的「工具」与它**互不读写**：数据目录不同、状态文件不同、入口不同、接入方式不同。

## 决策

### 1. 命名与入口

- 界面入口叫「工具」，与「插件」并列，不复用插件面板。
- 可安装的单位叫「**工具包**」（tool pack）。一个工具包里有若干「工具」。
- 工具包清单文件叫 `tool-pack.json`。

### 2. 目录与数据

| 内容 | 位置 |
|---|---|
| 内置工具包（随应用发布，只读，视为已信任） | 仓库 `tool-packs-bundled/<id>/` |
| 用户安装的工具包 | `<dataDir>/tool-packs/<id>/`（`dataDir` 默认 `~/.oh-my-agent-web`） |
| 工具包自己的持久化数据 | `<dataDir>/tool-pack-data/<id>/`（卸载默认保留） |
| 启停与信任状态 | `<dataDir>/tool-packs.json` |
| 给引擎用的 MCP 访问令牌（P1） | `<dataDir>/tool-mcp-token` |

工具包目录内容：

```
<id>/
├─ tool-pack.json   # 清单，必需
└─ README.md
```

v1 只有声明式清单。工具的实现（P1 起）由宿主统一提供，工具包本身不执行任意代码。这样「装一个工具包」的风险面主要是清单声明和后续的执行入口，而不是任意 JavaScript。

### 3. `tool-pack.json`

| 字段 | 必需 | 约束 | 说明 |
|---|---|---|---|
| `id` | 是 | `^[a-z][a-z0-9-]{1,39}$`，与目录名一致 | 唯一；不能与内置 id 冲突 |
| `name` | 是 | 非空字符串，≤ 80 字 | 界面显示名 |
| `version` | 是 | semver | 升级时比较 |
| `apiVersion` | 是 | 整数，v1 固定为 `1` | 宿主不认识的版本拒绝 |
| `description` / `author` / `homepage` | 否 | 字符串 | 展示用 |
| `requires.host` | 否 | `>=X.Y.Z` | 宿主版本下限 |
| `requires.binaries` | 否 | 命令名数组 | 启用前检查 PATH 里是否存在 |
| `tools[]` | 是 | 1–50 项 | 每项：`name`（`^[a-z][a-z0-9_]*$`，包内唯一）、`description`、`readOnly`（布尔，必需）、`riskNote`（可选） |
| `permissions[]` | 否 | 字符串数组 | 仅展示，安装确认时给用户看，v1 不做强制 |

未知顶层字段：保留并告警，不拒绝。

### 4. 信任、启停与安装

- **安装**：从本地绝对路径拷入 `<dataDir>/tool-packs/<id>/`，拷贝前拒绝任何符号链接，**不执行任何脚本**。
- **信任**：安装后必须确认一次。确认页展示来源、版本、权限、工具清单（标出 `readOnly`）。确认时提交目录的 `sha256`，服务端核对一致才记录（防止确认的和实际装的不一样）。
- **sha256** 覆盖目录内全部文件（相对路径 + 内容哈希）。内容一变，信任失效，状态回到 `untrusted`，启用被拒绝。
- **启用**：必须已信任且哈希一致；检查 `requires`；通过后记为启用。
- **停用**：只改状态，不删文件。
- **升级**：同 id 覆盖安装必须显式 `replace`。覆盖后强制停用，需要重新确认。
- **内置工具包**：视为已信任，每次启动按内置内容刷新信任记录；不能卸载，只能停用。
- **卸载**：删除工具包目录和状态记录；`tool-pack-data/<id>/` 默认保留，用户勾选才清除。
- **启动时**：内容已变化的已启用工具包会被自动停用并写回状态，不会在未确认的情况下生效。

### 5. 调用方与适配器（P1）

工具的核心（注册表、执行、两步确认、审计）在宿主里，与任何引擎无关。调用方通过适配器接入：

| 调用方 | 接入方式 |
|---|---|
| 各引擎会话（pi / codex / claude / opencode） | MCP 端点（下面详述） |
| 子代理 | 与父会话同一个 MCP 端点，或直接调用核心 |
| 系统内部任务（定时、自动化） | 直接调用核心，不经过引擎 |
| 「工具」页 | 直接调用核心，用于手动执行与测试 |

以下是 MCP 端点（引擎会话用）的细节：

- 端点只监听 `127.0.0.1`，每个请求必须带令牌。
- 工具名为 `<id 下划线化>_<tool name>`，如 `dws_unread`。
- `readOnly: true` 映射为 MCP 的 `readOnlyHint: true`；其余映射为 `destructiveHint: true`。
- **接入是用户手动操作**：在「工具」页里选择「接入到 pi / codex / claude / opencode」，宿主写入对应引擎的 MCP 配置，并可一键撤销。宿主不会在用户不知情的情况下改动其它引擎的全局配置。
- 接入位置：pi 走现有 MCP 面板的配置；codex 写 `config.toml` 的 `mcp_servers`（url 方式）；claude 写 `~/.claude.json` 的 `mcpServers`；opencode 写 `opencode.json` 的 `mcp`。
- **dsh 暂不支持**：它的 MCP 配置还没接，界面上直接说明。
- 令牌会写进其它引擎的配置文件。轮换令牌后，需要重新接入，旧接入自动失效。

### 6. 安全

- 工具包是本地内容，但**工具的实现由宿主提供**，不由工具包携带代码。
- 有副作用的工具（如发送消息、撤回）必须做两步：先 dry-run 返回 `previewId`，真正执行时必须带上 `previewId`，过期或不匹配则拒绝。这一层在宿主实现里做，不依赖引擎的审批设置。
- 原因：默认审批模式是 `allow`（ADR-0034），不同引擎的审批行为也不一致，不能只靠它们。
- 工具结果超长时截断，并告诉模型去哪里看完整输出。

## 与 pi 插件的边界

- 数据目录、状态文件、清单格式、界面入口、接入方式全部不同。
- 不读写 pi 的 `settings.json` 的 `packages`。
- 不修改「插件」面板的逻辑。
- 唯一的交汇点是 MCP 配置：工具只通过 MCP 配置被 pi 使用，与 pi 插件无关。

## 考虑过的替代方案

| 方案 | 不选的理由 |
|---|---|
| 做成 pi package | 只覆盖 pi，其它引擎用不了 |
| 工具包携带 JavaScript 并在宿主进程中加载 | 与「装工具包 = 装任意代码」绑定，风险面大；v1 先用声明式清单 + 宿主实现 |
| 每个引擎各写一套适配 | 维护成本高，且各家接口不一致 |
| 把功能写进仓库、不做框架 | 无法安装、卸载、停用，也无法让别人装 |

## 后果

**正面**
- 一套工具定义、一份核心实现，所有调用方共用：各引擎、子代理、系统任务、界面。
- 工具包与 pi 插件互不影响，各自清晰。

**负面 / 风险**
- 写入其它引擎的配置会带上令牌，需要在界面上说明，并支持撤销。
- dsh 当前无法经 MCP 接入，但系统内部任务与「工具」页不受影响。
- 工具在会话建立时由引擎读取，启停后已有会话可能需要重开才生效，需要在界面上说明。
- 工具实现在宿主里，新增一个工具包如果需要新工具，要改宿主代码或等待 P1 的扩展机制。这是 v1 的有意取舍。

## 实施阶段

| 阶段 | 内容 | 验收 |
|---|---|---|
| **P0（本次）** | 清单解析与校验、哈希与符号链接检查、状态文件、安装 / 信任 / 启用 / 停用 / 卸载 API、内置来源、启动时规范化状态 | 单测覆盖清单、哈希、状态流转、重启恢复、内容变化后拒绝启用、损坏的状态文件 |
| P1 | 核心执行服务；MCP 端点（loopback + 令牌）；接入到各引擎（手动、可撤销）；子代理与系统任务直接调用核心 | pi 与 codex 各能调用一个只读测试工具 |
| P2 | 「工具」页面（列表、信任确认、接入开关） | 界面可完成安装、信任、启用、接入全流程 |
| P3 | 内置 DWS 工具包（未读、搜索、成员、发送两步确认） | 四个引擎都能调用；发送必须先预览再确认 |

## P0 实现备注

代码位于 `server/tool-packs/`（`types`、`manifest`、`hash`、`binaries`、`state-store`、`manager`、`routes`），测试在 `tests/unit/tool-pack-*.test.ts`（36 个用例）。与草案不一致的地方：

- **分派器（`/api/tool-packs/:id/*` 的转发）暂不实现**：工具改为由 MCP 端点按工具名分发（P1），P0 没有工具实现需要转发。
- **`enable` 不加载任何代码**：P0 只管理状态（信任、启停、依赖、宋主版本），工具实现在 P1 进入。
- **内置目录候选路径**：`<server>/../tool-packs-bundled` 与 `<server>/../../tool-packs-bundled`（与 `webDistCandidates` 同一套思路）；仓库里暂无内置包，P3 时一起加。
- **安装的拷贝先在暂存目录里完成**，校验通过后才改名；失败不留半成品。
- **状态文件坏了**：`list` 返回 `stateError`，所有写操作拒绝（500），不覆盖原文件。
- `index.ts` 仅新增三处：创建管理器并挂路由（在鉴权之后），启动时 `init()`。

## P1 实现备注

代码：`server/tool-packs/` 新增 `args`、`token`、`executor`、`mcp-endpoint`、`connections`、`connection-routes`；清单增加可选字段 `parameters`（JSON Schema，`type` 必须是 object）。测试新增 `tool-pack-{executor,token,mcp,connections}.test.ts`，共用夹具 `tool-pack-fixture.ts`。

- **执行层**：只有「已启用 + 已信任 + 宏主有实现」的工具对外可见；没有实现的工具不声明。有副作用的工具必须两步确认：预览返回 `previewId`（一次性、五分钟过期），执行时参数必须与预览一致。
- **MCP 端点**：`POST /api/mcp-tools`，JSON-RPC 2.0，只实现 initialize / ping / tools/list / tools/call 和 notifications/*；GET 返回 405。令牌必须在 `Authorization: Bearer` 里。业务错误走工具结果的 `isError`，找不到工具才是 JSON-RPC 错误。
- **令牌**：`<dataDir>/tool-mcp-token`（0600），第一次需要时才生成；轮换后旧令牌立即 401。
- **接入**：由用户手动触发，通过各引擎自己的 MCP 存储（`mcpStoreFor`）写入名为 `agent-web-tools` 的全局 HTTP 服务器；轮换令牌时已接入的引擎会自动更新。dsh 不支持。
- **未做**：实际工具实现（P3 的 DWS 才会注册第一批）；审计只写日志，没有独立审计文件。
- **验证**：在临时数据目录 + 临时 HOME 下启动真实服务，走了安装 → 信任 → 启用 → 端点鉴权 → 接入 pi（配置文件正确写入）→ 轮换 → 撤销。真实 HOME 下的 pi / codex / claude / opencode 配置未被改动。

## P2 实现备注

前端新增 `web/src/components/ToolPacksPanel.tsx`、纯逻辑 `web/src/tool-packs-model.ts`、样式 `web/src/styles/tool-packs.css`；测试 `tests/unit/tool-packs-model.test.ts`。

- **入口**：新增面板 key `tools`（括手图标），排在「插件」之后、「MCP」之前；同时进 `APPBAR_ITEMS` / 标签表 / `SidebarMenu` 渲染分支。和插件面板并列、互不调用。
- **默认不在顶栏显示**：跟插件 / 推送 / 子代理一样是「按需才用」的入口，在 设置 → 界面 → 顶栏 勾上；`appbar-defaults` 的测试仍然成立。
- **入口不往回插**：已存的面板顺序里没有 `tools` 时，它补在末尾而不是插到插件后面 —— 不打乱用户已有的排序（`panel-order.test.ts` 里钉住了这个语义）。
- **界面做了什么**：安装（绝对路径 + 覆盖同名）、查看并确认信任（展示来源 / 文件数 / 完整哈希 / 声明的权限 / 所需命令，必须勾选才能确认）、启用 / 停用、卸载（二次确认，内置包不给此按钮）、各引擎接入 / 撤销、轮换令牌（二次确认）、当前对外可见工具。
- **验证**：`vite build` 通过；临时数据目录 + 临时 HOME 启动真实服务，用 Chrome 实操「安装 → 查看并确认信任 → 启用 → 接入 pi → 轮换令牌 → 撤销」，无页面错误；真实 HOME 下的引擎配置未被改动。
- **未做**：界面上不能选目录（需手填绝对路径）；没有「工具调试 / 手动执行」入口，要等 P3 有真实工具后再加。

## P3 实现备注

**内置工具包**：`tool-packs-bundled/dws/`（`tool-pack.json` + `README.md`）；**实现**：`server/tool-packs/dws/run.ts`（异步 `spawn` 调用 dws，参数走数组不经 shell）、`server/tool-packs/dws/tools.ts`；测试 `tests/unit/tool-pack-dws.test.ts`。

| 工具 | 只读 | 实现 |
|---|---|---|
| `dws_unread` | 是 | `chat +unread-chats --count N [--exclude-muted]` |
| `dws_search` | 是 | `chat +search-msg --query Q --days D --limit L [--group G]`（比 `+chat-search` 更合适：后者只搜群） |
| `dws_members` | 是 | `chat +chat-members-list --group G` |
| `dws_send` | 否 | `chat +messages-send`；**预览只带 `--dry-run`，确认才带 `--yes`** |

- **预览不投递是写死的**：`dryRun` 分支里只调 `[...argv, "--dry-run"]`，代码不会拼出 `--yes`；测试直接断言“预览时调用参数里没有 `--yes`”。
- **真确认时先校验再投递**：两次调用都先 `--dry-run`，成功后才 `--yes`，与 `oh-my-dws` 已验证的做法一致。
- **参数安全**：所有参数走 `spawn(bin, argv)`，不经 shell，消息正文不会被当命令解析；正文上限 4000 字，输出上限 64 MB，默认超时 60–120 秒。
- **搭载**：`TOOL_HANDLERS = { dws: dwsHandlers() }`（`server/index.ts`）；`package.json` 的 `files` 加了 `tool-packs-bundled`，安装包里也能找到。
- **测试**：用假的 `dws` 脚本记录每次调用的参数，钉住参数拼装、输出解析、两步确认、以及清单与实现一一对应（20 个用例）。
- **真实端到端**：真实 `dws` + 临时数据目录下，`tools/list` 列出 4 个工具（只读 3 个、`dws_send` 为 destructive 且带 `previewId`）；`dws_unread` / `dws_search` / `dws_members` 真实调用成功；`dws_send` 返回预览，伪造 `previewId` 被拒，事后用 `dws_search` 回查确认预览文案并未发出。
- **未做**：不支持发图片 / 文件 / Markdown（只发纯文本）；不自动读回发送结果做二次确认（只使用 dws 返回的 messageId）；`+search-msg` 默认只看 7 天，通过 `days` 参数放宽。

## 未决问题

1. 工具包是否允许 npm 依赖？v1 不允许，工具实现由宿主提供。
2. 令牌轮换的入口放在哪里（工具页还是设置页）？
3. 安装来源 v1 只开放本地目录，git 与 zip 放到 P0 之后。
4. 内置工具包的目录是否进入 npm 的 `files` 字段，需要和 `package.json` 一起确认。
