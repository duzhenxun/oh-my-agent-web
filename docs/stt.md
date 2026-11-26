# 云端语音识别（STT）

默认用的是**本地识别**（macOS `SFSpeechRecognizer`，离线、免费、音频不出本机）。
这份文档讲怎么换成云端 STT —— 比如想要更高准确率、或想用某家厂商的模型。

## 为什么需要这条路

浏览器的原生识别（`webkitSpeechRecognition`）只在 Chrome 官方版上稳定可用，
远程访问、非 Chrome、内网环境里都可能直接报 `error:network`；而且它把音频交给浏览器自己，
配置和计费都不在你手里。所以想做「换个厂商 / 自己能配密钥」的云端识别，
只能由**服务端**把音频转发给厂商 API —— 就是这条链路。

## 配置：`~/.oh-my-agent-web/stt.json`

写这个文件即生效，**重启服务端**后开始走云端。没有这个文件（或没有 `provider`）= 继续用本地。

**按厂商分块**（推荐）—— 合成那侧在 `tts.json`，两边各配各的密钥，互不影响
（用户 2026-11-24：「这 2 块可以各配置各的」）：

```json
{
  "provider": "deepseek",
  "providers": {
    "deepseek": { "apiKey": "sk-…" },
    "qwen":     { "apiKey": "sk-…", "model": "qwen-audio-3.1-asr-flash" }
  }
}
```

`provider` 决定用哪一块；块里的字段覆盖顶层同名字段。只配了一家时 `provider` 可以省。

老的**单厂商扁平**写法继续有效（不用改已有文件）：

```json
{
  "provider": "openai-compatible",
  "endpoint": "https://api.openai.com/v1/audio/transcriptions",
  "apiKey": "sk-…",
  "model": "whisper-1",
  "language": "zh",
  "timeoutMs": 60000,
  "headers": {},
  "extraFields": {}
}
```

| 字段 | 说明 |
|---|---|
| `provider` | 用哪个实现，见下面「已支持」 |
| `providers.<id>` | 该厂商的配置块（`apiKey` / `endpoint` / `model` …），和别的厂商隔离 |
| `endpoint` | 完整 URL（不是 base url）。`deepseek` 可以不写，默认官方端点 |
| `apiKey` | 默认拼成 `Authorization: Bearer <key>`；想用别的头就写在 `headers` 里 |
| `model` / `language` | 作为表单字段一起发（`deepseek` 没有这两个参数：语种自动判断，写了会被忽略并记日志） |
| `headers` | 额外请求头。**厂商要自己算签名的场景用这个**（如 `{"X-Api-Key": "…"}`） |
| `extraFields` | 额外表单字段。各家参数差异（`response_format`、`sample_rate`…）都塞这里，不用改代码 |
| `timeoutMs` | 单次识别超时，默认 60 秒 |

文件权限建议 `chmod 600`（里面有 key）。

### 用环境变量临时切换

不写文件也能用，环境变量优先：

```bash
AGENT_WEB_STT_PROVIDER=openai-compatible \
AGENT_WEB_STT_ENDPOINT=https://api.openai.com/v1/audio/transcriptions \
AGENT_WEB_STT_KEY=sk-… \
AGENT_WEB_STT_MODEL=whisper-1 \
oh-my-agent-web
```

也可以用 `AGENT_WEB_STT_CONFIG=/path/to/other.json` 指到别处的配置文件。
按厂商分开的写法：`AGENT_WEB_STT_DEEPSEEK_KEY=sk-…`（同理 `_ENDPOINT` / `_MODEL` / `_LANGUAGE`）。

## 已支持的 provider

| id | 适用 | 出字方式 | 说明 |
|---|---|---|---|
| `openai-compatible` | OpenAI Whisper、Groq、SiliconFlow、**阿里千问（兼容模式）**、各类中转网关、自建 whisper.cpp server | 整段 | 一次性上传整段 WAV 到 `/v1/audio/transcriptions` |
| `deepseek` | DeepSeek 语音识别 | 整段 | `POST /v1/tools/asr`，multipart WAV 进、`{text}` 出；单请求 120 秒 / 8 MiB 上限，**代码里自动切段拼接**，语种自动判断 |
| `qwen` | 阿里百炼 · 千问 ASR（默认 `qwen-audio-3.1-asr-flash`） | 整段 | 百炼自己的转写接口；模型可以在面板下拉里选 |
| `qwen-realtime` | 千问实时识别 · **旧版 ASR message 协议**（默认 `qwen-audio-3.1-asr-flash-message`） | 边说边出字 | WebSocket 推 PCM，服务端 `vad_model` 断句 |
| `qwen-omni-realtime` | 千问 Omni 实时（默认 `qwen3.8-omni-flash-realtime`） | 边说边出字 | `wss://…/api-ws/v1/realtime?model=…`，Bearer 鉴权；`session.update` 要文本 + pcm16 + `server_vad`，之后 `input_audio_buffer.append` 送 base64 音频 |

> **注意**：前三个是**整段识别**，说话过程中拿不到 partial —— 停下来（`/api/asr/end`）之后才拿到整句。
> 后两个是**边说边出字**，但**协议不同、模型不通用**：换模型不能只改 `model`，得一起换 `provider`。

用哪家也可以在设置面板的「识别引擎」里显式选（`GET /api/asr/engines` 列出可选项，
`POST /api/asr/engine` 选中后写回 `stt.json`）：选了它就**一定**走服务端这条线，
不会因为本机没有 Agent Computer 而退回 Chrome。状态行会显示当前是哪一家（如「就绪（DeepSeek 语音识别，云端）」）。
同一家厂商的兄弟 provider 可以**借用同一把 key**，不用重复填。

## 再加一家厂商（火山豆包、阿里千问…）

先看要不要写代码：

| 厂商 | 怎么做 |
|---|---|
| 阿里千问 / 百炼（qwen-audio-3.1-asr-flash、paraformer） | **不用写代码** —— 已经有 `qwen`（整段）、`qwen-realtime` 与 `qwen-omni-realtime`（边说边出字）三个原生 provider；只想走兼容模式也可以，用 `openai-compatible` 填 `endpoint: https://dashscope.aliyuncs.com/compatible-mode/v1/audio/transcriptions` |
| 火山引擎 / 豆包 | 要写一个 provider（鉴权头和 OpenAI 不同，响应用 `X-Api-*` 系列，可能要 `resourceId`） |

要写代码时三步，都不用碰 `server/asr/service.ts`：

1. **新建 `server/stt/<厂商>.ts`**，实现 `SttProvider`：

```ts
import type { SttProvider } from "./types.js";

export const volcengine: SttProvider = {
  id: "volcengine",
  label: "火山引擎 · 豆包语音",
  fields: [
    { key: "endpoint", label: "端点", required: true },
    { key: "apiKey", label: "App Key", required: true, secret: true },
  ],
  create(config, log) {
    // 自己处理签名、WebSocket、分片……
    // push(pcm) 收 16k 单声道 int16 小端；
    // end() 返回整句文本；流式的话顺便把中间结果写进 text
    return {
      get text() { return ""; },
      push(pcm) { /* … */ },
      cancel() { /* … */ },
      async end() { return ""; },
    };
  },
};
```

2. **在 `server/stt/index.ts` 的 `PROVIDERS` 里加进去**：

```ts
const PROVIDERS: SttProvider[] = [openaiCompatible, volcengine];
```

3. `stt.json` 里把 `provider` 改成 `"volcengine"`。

`fields` 是给将来的设置界面用的：声明了需要哪些字段，UI 直接渲染表单，
不用为每家再改一遍前端。

### 关于火山 / 阿里的特别说明

这两家的**实时**语音识别走的是 WebSocket + 自研签名（火山要 HMAC 鉴权，阿里 DashScope
有独立的握手参数），不是 OpenAI 那个 HTTP 形状，所以：

- 如果只想**整句识别**，且厂商提供了 HTTP 一次性接口 → 可以先用
  `openai-compatible` 拼 `headers` + `extraFields` 试通，不必写代码
- 如果要**边说边出字** → 必须新写一个 provider（上面三步），把 WebSocket 收在
  `create()` 里；`push()` 直接往 socket 塞 PCM，`end()` 发结束帧并等 final

## 失败时的行为

云端请求失败**不会**把语音输入弄死：这一句没有结果，日志里记一条
（`云端识别失败`，带 HTTP 状态和响应体前 300 字符），下一句照常重试。
不会自动退回本地 —— 退了反而让人搞不清是走哪条路出的字。
要退回本地：删掉 `stt.json` 里的 `provider`（或整个文件），重启服务端。

## 相关代码

| 文件 | 作用 |
|---|---|
| `server/stt/types.ts` | provider / session 接口定义 |
| `server/stt/openai.ts` | 内置的 OpenAI 兼容实现（含 PCM→WAV） |
| `server/stt/deepseek.ts` | DeepSeek 实现（multipart + 长音频切段拼接） |
| `server/stt/config.ts` | 配置读取（按厂商分块 + 环境变量） |
| `server/stt/index.ts` | 注册表：`PROVIDERS` 加一行就多一家 |
| `server/asr/service.ts` | 分流：有云端配置就走云端，否则走本地 helper |
