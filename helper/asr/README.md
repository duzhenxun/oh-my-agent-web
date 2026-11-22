# asr-bridge — 本地离线语音识别（macOS 原生）

网页拿不到 Apple 的离线识别引擎，而 Chrome 的 Web Speech 必须把音频传到 Google
（连不上的网络里直接报 `network`）。这个小程序补上这一格：

```
浏览器 getUserMedia → 16k 单声道 PCM（每 ~300ms 一块）→ POST /api/asr/chunk
        → 服务端 asr-bridge（unix socket，分帧）→ SFSpeechRecognizer（on-device）
        ←──────────── { text }（边说边出，带标点）────────────┘
```

## 安装（普通用户）

不用装 Xcode 命令行工具。「设置 → 语音 → 本地识别」那一行显示「还没装」时点**安装本地识别**：

1. 服务端下载预编译好的 `ASRBridge.zip`（是仓库里那份，也可以用 `OH_MY_AGENT_ASR_DOWNLOAD_URL` 指向自建源），
2. 用 `ditto` 解到 `~/Library/Application Support/oh-my-agent-web/asr/ASRBridge.app`，
3. 可执行位 / 隔离属性 / 签名过一遍，然后 `open` 拉起。

装完回到面板就是「就绪」，第一次说话会弹一次系统授权。**装到 Application Support 而不是包目录**
是有意为之：npm 升级会整包替换 `node_modules`，而 TCC 授权绑的是 .app 的签名（cdhash）——
包里那份每升级一次就成「新程序」，授权每次都要重问；装到固定位置后只问一次。

手动装也行：把 `ASRBridge.zip` 解压出的 `ASRBridge.app` 放进上面那个目录即可
（`OH_MY_AGENT_ASR_APP` 可以指向别处）。

## 构建（开发机）

```sh
./helper/asr/build.sh             # 本机架构，几秒；产物 helper/asr/ASRBridge.app
./helper/asr/build.sh --release   # 通用二进制（arm64 + x86_64）+ 打 release/ASRBridge.zip
```

需要 Xcode 命令行工具（`swiftc`）。产物 `helper/asr/ASRBridge.app` 不进 git。
**重新构建后 TCC 会当成新程序**，第一次再点浮条说话时会重新弹一次授权框。

## 分发（维护者）

改完 `main.swift` 或 `Info.plist` 之后：

```sh
./helper/asr/build.sh --release
```

然后把 `helper/asr/release/ASRBridge.zip` **一起提交**。npm 的发布流水线跑在 ubuntu 上，
编不了 Swift —— 用户拿到的就是仓库里这份预编译包（同时也会随 npm 包发一份，作为
连不上 GitHub 时的后备）。`Info.plist` 是独立文件、`build.sh` 只是复制它：
服务端的下载安装用的也是这同一份 plist，不存在两个来源。

## 为什么是 .app 而不是一个裸可执行文件（踩过的坑）

TCC（隐私授权）认的是**被执行的那个 app**。从终端/服务端 `spawn` 一个裸二进制时，
macOS 把「责任主体」算成终端自己（iTerm2），而 iTerm2 的 Info.plist 里没有
`NSSpeechRecognitionUsageDescription`，于是直接 SIGABRT：

```
This app has crashed because it attempted to access privacy-sensitive data without a usage description.
```

所以：打成 `ASRBridge.app`（带 Info.plist）+ ad-hoc 签名，并且用 **LaunchServices**
（`open -n -a …`）启动它 —— 这样主体是它自己，系统才会正常弹「想访问语音识别」。

## 协议

服务端起一个 unix socket（`$TMPDIR/oh-my-agent-web-asr.sock`），然后
`open -n -a ASRBridge.app --args --socket <path>`。app 连回来后：

**输入**（二进制分帧：4 字节大端长度 + 载荷；载荷首字节是操作码）

| 操作码 | 含义 |
| --- | --- |
| `A` | 音频（其余为 16kHz 单声道 int16 小端 PCM） |
| `E` | 这一句说完了（`endAudio`） |
| `X` | 退出 |

**输出**（JSON 行）

```json
{"type":"starting"}
{"type":"auth","status":"authorized"}
{"type":"ready","locale":"zh-CN","onDevice":true}
{"type":"partial","text":"帮我查一下今天的"}
{"type":"final","text":"帮我查一下今天的活动数据，然后发到群里"}
{"type":"error","message":"…"}
```

## HTTP 接口（服务端 `server/asr/`）

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/asr/status` | 只读状态；`?start=1` 才真的拉起（打开设置面板不该弹授权框）。没装时附带 `install: { downloadUrl, appPath, canAutoInstall }` |
| POST | `/api/asr/install` | 下载并安装本地识别程序（已装则直接返回；并发点击会合并成一次） |
| POST | `/api/asr/start` | 开一句新的（清掉上一句残留） |
| POST | `/api/asr/chunk` | 一块 PCM，返回 `{ text }`（当前 partial） |
| POST | `/api/asr/end` | 说完，等 `final`（超时 8s 用已识别部分） |

## 已知边界

- **仅 macOS**；Linux / Windows 上 `engine: auto` 会自动退回 Chrome 的 Web Speech。
- 一句一句用（同一时间只有一段话）；时长上限 16MB 音频（约 8 分钟）兜底。
- 标点由 `addsPunctuation`（macOS 13+）给出。
- 强制 `requiresOnDeviceRecognition = true`：不联网、不问 Apple 服务器。
