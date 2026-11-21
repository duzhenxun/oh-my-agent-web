# asr-bridge — 本地离线语音识别（macOS 原生）

网页拿不到 Apple 的离线识别引擎，而 Chrome 的 Web Speech 必须把音频传到 Google
（连不上的网络里直接报 `network`）。这个小程序补上这一格：

```
浏览器 getUserMedia → 16k 单声道 PCM（每 ~300ms 一块）→ POST /api/asr/chunk
        → 服务端 asr-bridge（unix socket，分帧）→ SFSpeechRecognizer（on-device）
        ←──────────── { text }（边说边出，带标点）────────────┘
```

## 构建

```sh
./helper/asr/build.sh       # 需要 Xcode 命令行工具（swiftc）
```

产物是 `helper/asr/ASRBridge.app`（不进 git）。**重新构建后 TCC 会当成新程序**，
第一次再点浮条说话时会重新弹一次授权框。

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
| GET | `/api/asr/status` | 只读状态；`?start=1` 才真的拉起（打开设置面板不该弹授权框） |
| POST | `/api/asr/start` | 开一句新的（清掉上一句残留） |
| POST | `/api/asr/chunk` | 一块 PCM，返回 `{ text }`（当前 partial） |
| POST | `/api/asr/end` | 说完，等 `final`（超时 8s 用已识别部分） |

## 已知边界

- **仅 macOS**；Linux / Windows 上 `engine: auto` 会自动退回 Chrome 的 Web Speech。
- 一句一句用（同一时间只有一段话）；时长上限 16MB 音频（约 8 分钟）兜底。
- 标点由 `addsPunctuation`（macOS 13+）给出。
- 强制 `requiresOnDeviceRecognition = true`：不联网、不问 Apple 服务器。
