# ADR-0052：引擎缺失给界面、用户点了才装 —— 不动用户已有的那份

- **状态**：Accepted（2026-11-23 实现）
- **日期**：2026-11-23
- **相关**：ADR-0024（引擎注册表与回落）、ADR-0031（`aw` 启动方式）、ADR-0010（文件大小护栏）
- **代码**：`server/engine/engine-specs.ts`（数据与文案）、`engine-install.ts`（安装器）、`engine-routes.ts`（HTTP）、`server/pi-gate.ts`（没有 pi 时的兜底页面）、`web/src/components/EngineInstallDialog.tsx` + `EnginePicker.tsx`（界面）

## 背景

工作台本身只是个壳：用户机器上可能一个第三方引擎都没有，甚至连 pi 都要先装。这条策略来回改了三次，用户 2026-11-23 的三句话分别是：

> 如果用户电脑里有 codex claude 这些……不能动用户的。咱们只是一个壳，可以用他们的，但不能改人家的软件。

> 缺了也不能装到私有目录中。

> 却少什么时最好有个界面，让用户点点鼠标就能安装。但他没有切换 agent 时不需要提示安装。
> 只有他切换时再提示安装。默认是用 pi，如果用户电脑上没有这个，也是提示安装，出来界面，
> 让用户点确定安装一下 pi 相关的包。

合起来是一句话：**用户已有的那份神圣不可侵犯；缺的那份要装，但必须由用户点一下才知道。**

## 决策

### 1. 有用户的，就用用户的；不复制、不升级、不改配置

`engineStatus()` 的查找顺序：`AGENT_WEB_*_BIN`（显式指定即最终答案）→ PATH → 我们自己的
npm prefix（上一次点安装装的）。找到就用，工作台不去重装、不去升级、不改它的配置。

`<prefix>/bin` 是**追加**到 PATH 末尾的（`appendToPath`）：用户自己也装过同名命令时，
他那份永远优先 —— 从终端跑的和在 App 里跑的必须是同一个二进制，否则同一句话两种行为，最难查。

### 2. 缺了不主动打扰，只在「用户要切过去」时给界面

- 默认引擎是 pi；大多数人不换引擎，就**不该**看到任何安装提示；
- 用户点一个未安装的引擎 → `EnginePicker` 发现 `missing` → 弹 `EngineInstallDialog`，不直接切过去
  （直接切只会立刻报错，等于白跑一趟）；
- 弹窗里是一个按钮：点了才发 `POST /api/engines/install`，装完即可切换。

### 3. 装到哪：就是它自己的 npm prefix（`<dataDir>`）

`npm install --global --prefix ~/.oh-my-agent-web <pkg>@latest` —— 与 `scripts/install.sh` 完全
同一个位置。理由（也是 install.sh 当初的理由）：系统全局常常要 sudo，还会被 Homebrew / nvm 的
prefix 抢走；而 `<dataDir>` 里是**标准 npm 布局**（`bin/` + `lib/node_modules/`），用户随时可以
`npm ls -g --prefix ~/.oh-my-agent-web` 看见自己装了什么、也能一条命令卸掉。

不是「私有目录里塞一份神秘副本」：它就是 npm 管得着的地方。

### 4. pi 也在同一套机制里，只是它需要重启

pi 是以**模块**被静态 import 的（`engine/pi-sdk.ts`），所以「没有 pi」时 `server/index.ts`
根本 import 不进来 —— 连能弹按钮的界面都没有。因此 `cli.ts` 在 `await import("./index.js")`
之前先查一次：没有 pi 就起 `pi-gate.ts`。

`pi-gate.ts` 只用 node 内置 http，不 import 任何 pi 相关模块，做三件事：一个「安装 Pi Agent」
的页面、`GET /api/engines`、`POST /api/engines/install`。装完提示用户重开 —— 因为模块解析
是在进程启动时定的，热挂不上去。这也是 `installEngine()` 里 pi 唯一返回 `restartRequired: true`
的原因。

（打包成 App 时 pi 随包发，这条路径不会走到；它是为「薄壳 / npm 装」留的正确出口，
比在终端里甩一条 ENOENT 有用得多。）

### 5. dsh 不给按钮

它没有公开的 npm 包。`installable: false` + 引导文案 —— 宁可这个引擎装不了，
也不编一个包名让人装错东西（`npm i -g dsh` 装到的是别人的包）。

## 影响

- **默认路径零打扰**：只要 pi 在，用户从打开到用起来不会看到任何安装提示。
- **切引擎才会看到一次**：一个弹窗、一个按钮，点完就能用；不装就继续用 pi。
- 安装失败不吞错：`POST` 返回 502 + 可读原因，并把「自己装」的命令一起带回去。
- 同一时刻只允许一个安装（`installing` 串行）：并发 npm 会互相踩同一个 prefix。

## 验证

- `tests/unit/engine-install.test.ts`（11 条）：落点、参数形状（`--global` + `--prefix`）、
  pi 的模块判定、显式变量优先、PATH 追加顺序、重启后 PATH 幂等挂回。
- `tests/unit/engine-specs.test.ts`（9 条）：四个引擎都说清「不会替你装、也不改你的环境」+
  引导以「你自己装的话」开头 + dsh 不指到任何 npm 包。
- 手工：`GET /api/engines` 五个引擎的真实状态（本机全部已装，路径都对得上）；
  `POST /api/engines/install {"name":"dsh"}` → 400 + 引导；未知引擎 → 400。
