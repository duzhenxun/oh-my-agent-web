# ADR-0050：会话里的 `appearance` 工具 —— 一句话改字号，先读后改并报差值

- **状态**：Accepted（2026-11-21 实现）
- **日期**：2026-11-21
- **相关**：ADR-0020 §P1（`settings.json`）、ADR-0033（按客户端快照）、ADR-0049（会话里的 cron 工具）、ADR-0010（文件与行数护栏）
- **代码**：`server/session/appearance.ts`（纯函数 + 端口）、`server/engine/pi-appearance-tool.ts`（pi 工具）、`web/src/appearance-sync.ts`（浏览器应用）、`App.tsx`（挂载点）

## 背景

用户 2026-11-21：

> 我希望在这个 agent 里面说的话，你就可以去操作设置相关那些功能……你也有接口可以查看当前设置了什么。我说改哪个之前你先看一下现在是多少，我说改成多少，你要报改成多少。

原来字号（聊天正文 / 侧栏项目名 / 侧栏会话名）**只存在浏览器 localStorage**：服务端既读不到也改不到，agent 无从下手。设置面板又太厚，用户不想为了调两号字去翻面板。

## 决策

### 1. 字号进服务端设置，而不是新开一个接口

`SettingsView` 增加 `appearance: { chatPx, projectPx, sessionPx }`，存在既有的 `<dataDir>/settings.json` 里。

改动落在**已有的** `set_settings` RPC 上：客户端改设置走它，agent 走同一个 `runtime.applySettings()` → 落盘 → `pushSnapshot()`。所以：

- **不需要新 HTTP 路由**；
- **不需要轮询**（快照本来就在推）；
- 面板与对话两条入口写的是同一份状态，不会打架。

一开始设计的「新端点 + 3 秒轮询」是绕路，被用户一句「为什么不直接调 API」问掉了。

### 2. 浏览器只接住「变化」，不接住「初始值」

`web/src/appearance-sync.ts` 的两条规则：

1. **第一份快照只记基线、不应用**：老用户本机可能已经是 18px，服务端那份还是默认 14 —— 一上来就应用等于把他的设置改回去；
2. 之后**只有值真的变了**才调 `setChatFont` / `setSidebarProjectFont` / `setSidebarSessionFont`（这三个 setter 负责写存储、改 CSS 变量、广播事件，界面自动重渲染）。

这条取舍的代价：新设备不会自动继承服务端的字号（和本特性之前的行为一致，不算回归）。

### 3. 工具语义：read / set / reset，set 必须报差值

- `read`：三处当前 px + 合法区间（2–30、只双数），模型据此回答「现在是多少」；
- `set`：`target` ∈ `chat` / `project` / `session` / `all`（也认「项目名 / 会话名 / 正文」这类中文），配 `px`（绝对）或 `delta`（相对，±2）；
- `reset`：回默认 14px。

**改前先读**：`set` 在宿主侧先取当前值，写完后回读归一化后的真实值，输出 `14px → 18px` 这种可核对的差值。归一化（夹 2–30、取双数）在服务端做，工具如实回报被夹后的值 —— 不假装用户要的值一定生效。

### 4. 只有 pi 引擎有

和其它宿主工具一样（见 ADR-0049 §4）：`pi.registerTool` 是 SDK 的扩展点，codex / dsh / opencode / claude 走 ACP 或子进程，没有等价入口。

## 后果

- 用户可以在对话里说「对话文字大一点」「侧栏项目名设成 16」，agent 先报当前值、改完报 `x → y`，浏览器一秒内自己变，不用刷新。
- 服务端那份是**共享**的：电脑上改了，手机上打开也是这个字号（与 voice-settings 的分工一致）。
- 归一化与部分合并都是纯函数（`normalizeFontPx` / `normalizeAppearance` / `appearancePatchFromArgs`），有单测覆盖；`settings.json` 能被手改，坏值一律回默认而不是报错。
- 还没覆盖的：对话宽度（`agent-web.chat-width`）、顶栏高度（`appbar-scale`）、终端字号仍是**纯本地**，agent 改不到 —— 要加就是往 `appearance` 里再添字段，路径已经铺好。
