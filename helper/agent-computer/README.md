# Agent Computer（最小兼容 helper）

让 oh-my-agent-web 的「电脑控制」面板能真的操作 macOS 应用，同时提供**本地语音识别**。

这是一个**独立的本机 helper**：oh-my-agent-web 里的 `server/computer/`（电脑控制）和
`server/asr/`（语音识别）都只是客户端，通过 Unix socket 用 JSON-RPC 调它。
本目录是可编译的替代实现，协议与原版 `agent-computer-turbo` 对齐（`turbo-1`）。

2026-11 起，原先独立的 `ASRBridge.app` 已并入这里：语音识别和电脑控制共用同一个
bundle、同一次签名、同一次安装，不再维护第二份 `.app` 的分发与授权。

## 能力

| 请求 | 说明 |
|---|---|
| `hello` | 握手，返回版本、pid、权限状态 |
| `findApps` | 列出可操作应用（运行中的排前面） |
| `observeApp` | 编号元素树 + 窗口截图；支持 `fullTree`、`window`（按标题选窗口） |
| `act: clickAt` | 按编号（AXPress 优先，坐标兜底）或截图坐标点击 |
| `act: writeText` | 写文本：短文本走键盘合成，长文本走剪贴板粘贴 |
| `act: fillValue` | 直接替换输入框内容 |
| `act: sendKeys` | 快捷键，如 `cmd+s`、`ctrl+shift+Tab`、`Return` |
| `act: pasteText` | 剪贴板粘贴，用完恢复原剪贴板 |
| `act: scrollView` | 按方向/页数滚动（滚轮事件） |
| `act: dragItem` | 分步拖拽（带中间事件，多数 App 才认） |
| `act: invokeAction` | 执行任意无障碍动作（`AXShowMenu`、`AXConfirm`…） |
| `act: runCommand` | 按菜单路径执行命令 |
| `appCommands` | 枚举菜单命令（带快捷键） |
| `waitFor` | 等界面变化：`text_appears` / `text_gone` / `element_changes` / `new_window` / `settled` / `any_change` |
| `previewPanel` | 右下角实时预览浮窗 |
| `finishTurn` | 结束会话，清掉元素编号 |
| `asr.status` | 语音识别状态：`authorized` / `locale` / `onDevice`（只读，不弹授权框） |
| `asr.start` | 申请系统授权 + 建离线识别器 + 开一句；首次会弹麦克风 / 语音识别授权 |
| `asr.feed` | 送一块 base64 的 16k 单声道 int16 PCM，返回当前 partial |
| `asr.end` | 这句说完：等 final 落地后返回全文（超时用已有结果） |
| `asr.cancel` | 丢弃当前这句 |

## 语音识别（原 `ASRBridge.app`）

为什么必须放在原生侧：网页拿不到 Apple 的离线识别引擎（`SFSpeechRecognizer` 只在原生侧），
Chrome 的 Web Speech 必须把音频传到 Google —— 断网或连不上时直接报 network。
这条通道补的就是这一格，并且**强制离线**（`requiresOnDeviceRecognition = true`），
音频不出本机。

协议上有两处和电脑控制不同：

- **音频走 base64**：帧仍是 `uint32 小端长度 + UTF-8 JSON`，PCM 就塞在 `asr.feed` 的
  `audio` 字段里。没有引入二进制帧 —— 每块几十 KB，base64 的 33% 开销可以接受，
  换来的是不必改 Framing，Swift 与 TS 两侧都不用动。
- **结果靠返回值而不是推送**：这套协议是一问一答，没有服务端主动推送。
  partial 由 `asr.feed` 的响应带回，final 由 `asr.end` 的响应带回 ——
  `server/asr/bridge.ts` 的 `pushAudio` / `endUtterance` 就是按这个写的。

会话管理：`asr.start` 之后同一时间只有一句在识别；`asr.end` 会把会话放进
`finishing` 保活 30 秒（等 final 回调落地），之后自动释放 —— 不回收的话，
每说一句就永久漏一个已结束的会话。

识别语言默认 `zh-CN`，可用 `OH_MY_AGENT_ASR_LOCALE` 覆盖；该语言在本机没有离线模型时
直接报错，**不会退回联网识别**。

## 稳定性设计

这些不是可选项，是「能连续操作不出错」的前提：

1. **选对窗口**：聚焦窗口 → 主窗口 → 标准窗口 → 第一个。App 常挂着 Caps Lock 提示、更新提醒之类的浮窗，直接取第一个会一直操作浮窗。
2. **先抬窗口再动手**：否则 `AXPress` 作用在后台窗口，坐标点击会打到别的 App 上。
3. **无障碍优先，坐标兜底**：`AXPress` 不依赖坐标；不支持时才退到元素中心点。
4. **状态可读回**：元素行里带 `focused`、`enabled`、`value`、屏幕坐标，agent 每步都能验证，不用盲点。
5. **从不重试**：超时后操作可能已经执行过，重试会重复提交表单。
6. **不填密码**：`AXSubrole` 是密码框、或占位符像密码，一律拒绝并让用户自己输入。
7. **请求串行 + 看门狗**：所有动作排队执行；单次调用超过 150 秒就报错，不会把后续探活全堵死。
8. **用户优先**：鼠标按着时不动手（`userActive`），避免和用户抢输入。
9. **SIGPIPE 免疫**：客户端断连时写回失败不会把 helper 打死。
10. **文本转义**：元素值里的换行/引号会转义，保证「一行一个元素」的格式不被撑断。

## 分发（给别人用）

`.app` **不进 npm 包**，而是打包成 zip 放在仓库里：

```
helper/agent-computer/release/Agent Computer.zip
```

这一个 zip 同时提供电脑控制和语音识别 —— 没有任何单独的 `ASRBridge.zip` 了。

工作台「电脑控制」面板检测到没安装时，会直接给这个文件的下载链接
（默认指向 GitHub raw，可用 `AGENT_COMPUTER_DOWNLOAD_URL` 换成 gitee 或内网地址）。

改了 helper 之后要重新生成并提交这个 zip：

```bash
./scripts/build-app.sh          # 构建 + 同时刷新 release/Agent Computer.zip
git add release/                # 提交给用户下载
```

注意两点（没做开发者签名，绕不过去）：

1. 用户第一次打开会被 Gatekeeper 拦（没做开发者签名）。**新版 macOS 不再允许用「右键 → 打开」绕过**，
   必须到「系统设置 → 隐私与安全性」，在页面下方点「仍要打开」再确认一次。
   另一条完全不触发拦截的路：用 `curl` 下载（终端下的文件不带 quarantine 标记），
   例如 `curl -L -o /tmp/ac.zip <raw 地址> && unzip -q /tmp/ac.zip -d /Applications`。
2. 「辅助功能 / 屏幕录制」授权必须用户自己在系统设置里勾一次，程序不能自己授权。

## 构建与安装

```bash
./scripts/build-app.sh            # 构建 + 打包到 dist/
./scripts/build-app.sh --install  # 装到 /Applications（没有写权限时退到 ~/Applications）
open -a "/Applications/Agent Computer.app"
```

然后到 **系统设置 → 隐私与安全性**：

- **辅助功能**：勾上「Agent Computer」（读界面、点击、输入都要它）
- **屏幕录制**：勾上（只用截图；不给也能操作，只是没有图）
- **麦克风**：用语音输入时要（采集你说的话）
- **语音识别**：用语音输入时要（系统离线识别引擎）

后两项只在第一次开始听写时才会申请，不用语音输入可以不授权。

> 没授权时 helper 每次启动会**自己申请一次**屏幕录制（`CGRequestScreenCaptureAccess`）。
> 这一步的意义是「登记」：不调用它，app 根本不会出现在系统设置的「录屏与系统录音」列表里，
> 用户翻遍设置也找不到这一条（用户 2026-11-23 报的问题）。申请时系统会弹一次提示，
> 回答之后条目就进列表了；开不开开关仍然由用户决定，程序不会自己去改。

工作台「设置 → 电脑控制」应该显示「运行中」。

## 验证

```bash
# 只测协议（不需要授权）
node tests/integration/computer-helper.mjs

# 真实操作：开一个 TextEdit 文档，写入 → 覆盖 → 两种点击 → 滚动 → 菜单 → 等待
node tests/integration/computer-helper.mjs --ax
```

`--ax` 会直接跑可执行文件，继承当前终端的辅助功能授权，所以能在 `.app` 还没授权时验证 AX 逻辑。

## 已知限制

- **只有 arm64**：`build-app.sh` 出的是当前平台包，没做 universal；Intel Mac 跑不起来。
- **语音识别依赖系统离线模型**：macOS 13+ 且该语言已下载离线模型才可用。
  中文在大部分机器上开箱可用，冷门语言可能直接报「不支持离线识别」。
- **ad-hoc 签名**：重新编译后 macOS 会把授权当成新程序，需要重新勾选。`build-app.sh --install` 会在二进制未变时跳过替换，减少无谓的重新授权；长期稳定要换固定证书签名。
- **装在 `/Applications`**：Finder 边栏的「应用程序」只显示系统级目录，装到 `~/Applications` 用户会找不到。
- `input` 类动作（拖拽/滚动）依赖屏幕坐标，多显示器 + 非主屏时按窗口原点换算，正常可用；窗口被其他 App 完全遮挡时坐标点击会打到上面那层。
- 没有动作审批弹窗（原版有）。无人值守场景建议配合 `userActive` 与白名单使用。

## 日志

`~/Library/Application Support/AgentComputer/helper.log`
