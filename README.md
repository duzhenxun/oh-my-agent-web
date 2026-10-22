# oh-my-agent-web

把编码智能体（pi / Codex / DeepSeek Harness）包进一个**本机网页工作台**：左边是多项目 + 会话列表，中间是对话，右边随时看文件、跑终端。

单用户、只听回环、会话事实源是引擎自己的落盘文件 —— 不引数据库、不建账号体系，`agent-web` 起一个进程就是一个人的工作台。

## 它是什么

- **一个仓库一个项目**：侧栏按目录分组，会话就是引擎的会话文件（pi 的 `.pi/agent/sessions/**/*.jsonl`、Codex 的 thread、DSH 的会话），在 CLI 里看到的名字/内容与网页里一致。
- **对话 + 工具 + 审批**：工具调用卡片、流式输出、命令/文件改动按审批规则放行或逐次询问。
- **文件管理**：目录树、按名搜索、预览（markdown / 图片 / PDF / 音视频流）、上传、拖拽附件；项目在 git 仓库里时右上角多一枚分支标签，点开可切换本地分支（工作区有未提交改动会先确认）。
- **内嵌终端**：基于 `node-pty` 的真 PTY（xterm.js 渲染），和会话共用工作目录。
- **模型与供应商**：在「模型」面板里配置 provider / 模型清单，支持从别的客户端导入、逐个试连。
- **技能面板**：列出 pi 技能并启停，读单个技能的文件。
- **推送**：Web Push 订阅，回合结束时通知（需要 https 或 localhost）。
- **手机可用**：窄屏自适应布局，侧栏可收起。

## 快速开始

要求 **Node.js ≥ 22.19**（macOS / Linux；Windows 未验证，`node-pty` 需要能编译或拿到预编译产物）。

```bash
npm install
npm run build
npm start            # 前台运行；Ctrl-C 退出
```

浏览器打开 <http://127.0.0.1:25257>。

装成全局命令后，可以用简写 `omaw` 或 `agent-web`（`oh-my-agent-web` / `omaw` / `agent-web` 三个命令指向同一入口，完全等价）：

```bash
npm i -g .
agent-web -d         # 后台启动（日志写到 <dataDir>/daemon.log）
agent-web status     # 看 pid / 端口 / 运行时长 / 会话数
agent-web restart -d # 改完代码重启
agent-web stop
```

### 常用参数

| 参数 | 环境变量 | 默认 | 说明 |
| --- | --- | --- | --- |
| `-p, --port` | `AGENT_WEB_PORT` | `25257` | 监听端口 |
| `-H, --host` | `AGENT_WEB_HOST` | `127.0.0.1` | 监听地址；对外访问才需要改 |
| `-P, --password` | `AGENT_WEB_PASSWORD` | 无 | 访问密码；不设 = 只允许本机 |
| `--allow-host` | `AGENT_WEB_ALLOWED_HOSTS` | 只认 loopback | 额外允许的域名 / 局域网 IP（可多次或逗号分隔） |
| `--data-dir` | `AGENT_WEB_DATA_DIR` | `~/.oh-my-agent-web` | 密码、设置、上传、日志、会话缓存都放这 |
| — | `AGENT_WEB_LOG` | `info` | `debug` / `info` / `warn` / `error` |
| — | `AGENT_WEB_CWD` | `process.cwd()` | 默认工作区（还没开会话时用） |

数据目录里会有：`password`（设过一次就记住）、`allowed-hosts`、`settings.json`、`pi-sessions-cache.json`、`uploads/`、`logs/`、`server.lock`。

> 想从手机访问：`agent-web -d -H 0.0.0.0 -P 你的密码 --allow-host 你的域名`，反代 / 隧道请带上 `X-Forwarded-For`（来源校验会看它）。

## 开发

```bash
npm run dev          # 一条命令起两个进程
```

- 对外仍然只有一个 **25257**（Vite 监听并反代），后端躲在内部 **25258**：开发和生产记同一个地址。
- 前端热更新走 Vite，后端 `tsx --watch` 自动重启。
- 手机调试：`npm run dev -- --host 0.0.0.0`。

| 命令 | 作用 |
| --- | --- |
| `npm run typecheck` | 服务端 + 前端两套 `tsc --noEmit` |
| `npm run lint` | oxlint（`server` / `web/src` / `scripts`） |
| `npm run format` | prettier 全仓格式化（`format:check` 只检查） |
| `npm run build` | 服务端 `tsc` + 前端 `vite build` 到 `web/dist` |
| `npm run icons` | 重新生成 PWA 图标 |

## 目录结构

```
oh-my-agent-web/
├─ server/              后端（Express + ws）
│  ├─ index.ts          进程入口：路由、WS、静态产物、优雅退出
│  ├─ cli.ts            agent-web / omaw 命令（start / stop / restart / status / upgrade）
│  ├─ protocol.ts       WS 协议单源（前端通过 web/src/types.ts 复用类型）
│  ├─ engine/           引擎适配层：pi（原生 SDK）/ codex / dsh / fake（测试）
│  ├─ session/          会话运行时：切换、改名、删除、模型控制、审批桥
│  ├─ sessions/         会话文件扫描（标题 / 模型 / 缓存）
│  ├─ files/            文件树、预览、搜索、上传、git 分支
│  ├─ terminal/         PTY 终端
│  ├─ approval/         审批规则与作用域判断
│  ├─ providers/        自定义 provider / 模型清单
│  ├─ push/             Web Push
│  └─ skills/           技能发现与启停
├─ web/                 前端（React 19 + Vite）
│  └─ src/
│     ├─ components/    侧栏、消息流、输入框、文件树、终端、各类面板
│     ├─ styles/        按职责拆分的 CSS（无框架，一套 CSS 变量）
│     └─ use-*.ts       搜索 / 分支 / 分栏 / 复制等小 hooks
├─ scripts/             dev 双进程、图标生成
└─ docs/architecture/   架构图（自包含 HTML，双击就能看）
```

## 引擎

| 引擎 | 说明 |
| --- | --- |
| **pi**（默认） | 完整的插件 / 技能生态、工具延迟加载、审批门禁、目标模式与子代理；模型与 provider 由本工作台管理 |
| **Codex** | codex 官方 agent，独立 loop 与沙箱，会话与 Codex Desktop / CLI 共用；审批是命令 / 文件级的 |
| **DeepSeek Harness** | DeepSeek 官方 agent（ACP），模型与思考档可切，权限逐次确认 |
| **fake** | 零 token 的脚本化引擎，只用来验证协议 / 工具 / 审批流程（`AGENT_WEB_ENGINE=fake`，默认不进切换面板） |

装没装的引擎不影响启动：只有切到它时才会报「没找到」。

## 安全模型

- 默认只监听 `127.0.0.1`，并校验 `Origin` / `Host`；要远程访问必须显式给 `-H` + `-P` + `--allow-host`。
- 工具与命令走审批：只读命令自动放行，其余按规则询问（规则可积累）。
- 删除会话是**改名到 `.deleted-<时间戳>`**，文件还在磁盘上，能捞回来。
- 上传的临时文件、会话缓存都在数据目录里，不写进你的项目目录。

## 文档

- 架构图与主链路：[`docs/architecture/README.md`](docs/architecture/README.md)（`open docs/architecture/index.html`）
- 代码里的 `ADR-00xx` 引用是设计决策编号；具体缘由写在对应文件的头注释里。

## License

MIT
