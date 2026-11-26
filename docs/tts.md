# 云端语音合成（TTS）

播报回复时用哪套引擎，在「设置 → 声音与语音 → 语音引擎」里选。默认是浏览器语音，
不需要任何配置；在线引擎（Edge / DeepSeek）要密钥或要联网，本地引擎（Kokoro / Qwen3-TTS）
要下载模型。

这份文档讲**在线引擎的密钥怎么配**，以及**以后加千问 / 火山豆包**要动哪几处。

识别（声音→文字）是另一条独立的链路，配置在 `~/.oh-my-agent-web/stt.json`，见 [stt.md](./stt.md)。

## 配置：`~/.oh-my-agent-web/tts.json`

写这个文件后**重启服务端**生效。没有这个文件 = 只有 Edge 和本地引擎可用。

**按厂商分块** —— 各家密钥互不影响，换一家不用动另一家的：

```json
{
  "providers": {
    "deepseek": { "apiKey": "sk-…" },
    "qwen": { "apiKey": "sk-…" },
    "volcengine": { "appId": "…", "accessToken": "…", "cluster": "volcano_tts" }
  }
}
```

也认两种省略写法（手写文件少一层缩进不该直接失效）：

- 顶层直接放厂商名：`{ "deepseek": { "apiKey": "sk-…" } }`
- 老的单厂商扁平：`{ "provider": "deepseek", "apiKey": "sk-…" }`

| 字段 | 说明 |
|---|---|
| `providers.<id>.apiKey` | 厂商密钥。默认发成 `Authorization: Bearer <key>` |
| `providers.<id>.baseUrl` | 换网关 / 私有部署时用（默认厂商官方地址） |
| `providers.<id>.endpoint` | 想直接写完整 URL 时用，优先于 `baseUrl` |
| `providers.<id>.voiceId` | 默认音色（面板里选过就存面板的值） |
| `appId` / `accessToken` / `cluster` | 火山那套字段，留给 `volcengine.ts` 自己解释 |

文件权限：`chmod 600 ~/.oh-my-agent-web/tts.json`（里面有 key）。

### 环境变量（临时试 / 容器注入）

```bash
# 只配一家
AGENT_WEB_TTS_PROVIDER=deepseek AGENT_WEB_TTS_KEY=sk-… oh-my-agent-web
# 按厂商分开（可同时配好几家）
AGENT_WEB_TTS_DEEPSEEK_KEY=sk-… AGENT_WEB_TTS_QWEN_KEY=sk-… oh-my-agent-web
# 换配置文件位置
AGENT_WEB_TTS_CONFIG=/path/to/tts.json oh-my-agent-web
```

环境变量**覆盖文件里的同名字段**，不会动别的厂商块。

## 已支持的在线引擎

| 引擎 | 端点 | 音色 | 说明 |
|---|---|---|---|
| `edge` | 微软 Edge 在线合成 | 12 个常用中/英/粤 | 不要密钥，需要联网 |
| `deepseek` | `POST /v1/tools/tts` | `stella`（女）/ `tide`（男） | 只要 `apiKey`；**不支持调语速**（面板上的滑杆对它禁用并标注）；不支持断点续传 |

DeepSeek 的细节：单次最多 10000 个计费字符 / 64 KiB 请求体，音频边合成边返回（`format: "wav"`），
超时 60 秒；`400` = 内容审核没过或没有可朗读文本，`429` = 并发超限，`503/504` = 服务繁忙 / 超时。
这些都被翻成了面板上能照做的一句话。

## 怎么确认配好了

面板会自己显示：选了没配密钥的引擎，下面直接出现一行「还没配密钥：在 ~/.oh-my-agent-web/tts.json
里填 providers.deepseek.apiKey」。也可以直接问服务端：

```bash
curl -s localhost:25257/api/tts/providers
# {"providers":[{"id":"edge",...},{"id":"deepseek","label":"DeepSeek TTS（在线）","configured":true}],
#  "configPath":"/Users/you/.oh-my-agent-web/tts.json"}
```

这个接口只报「配没配」和文件路径，**不回传任何 key**。

## 再加一家厂商（千问、火山豆包）

两步，都不用碰 `server/tts/service.ts`：

1. **新建 `server/tts/<厂商>.ts`**，实现 `TtsEngine`（见 `server/tts/types.ts`）：

```ts
export function createQwenEngine(secrets?: TtsProviderSecrets): TtsEngine {
  return {
    id: "qwen",
    label: "千问 TTS（在线）",
    configured: Boolean(secrets?.apiKey),
    note: secrets?.apiKey ? undefined : "还没配密钥：在 ~/.oh-my-agent-web/tts.json 里填 providers.qwen.apiKey",
    defaultVoice: "Cherry",
    contentType: "audio/wav",
    voices: () => ({ voices: [{ id: "Cherry", name: "Cherry", lang: "zh-CN" }] }),
    async speak(input, signal) {
      // 返回音频 Buffer；失败抛 TtsError(status, "给人看的一句话")
    },
  };
}
```

2. **在 `server/tts/registry.ts` 的 `engines` 数组里加一行**，前端下拉里再各加一行
（`web/src/remote-tts.ts` 的 `RemoteTtsProvider`、`VoicePanel.tsx` 的 `<option>`、
`web/src/tts.ts` 的 `TtsSettings.qwenVoice` 与合法值清单）。

两家已知的协议差异（写的时候照这个来）：

- **千问 / 阿里百炼**（Qwen-TTS、CosyVoice）：`POST {baseUrl}/api/v1/services/aigc/multimodal-generation/generation`
  或 dashscope 兼容模式的语音接口，Bearer 鉴权；**音频是 base64 字符串**（`output.audio.data`），
  要 `Buffer.from(data, "base64")`，不能直接 `arrayBuffer()`。
- **火山引擎 / 豆包**：`POST https://openspeech.bytedance.com/api/v1/tts`；注意请求头是
  `Authorization: Bearer;<accessToken>`（**分号**，不是空格）；body 要 `appid` / `cluster` / `voice_type`；
  响应是 base64（`data` 字段）。

## 相关代码

| 文件 | 作用 |
|---|---|
| `server/tts/types.ts` | `TtsEngine` 接口（`label` / `configured` / `note` 供面板显示状态） |
| `server/tts/config.ts` | 密钥读取（按厂商分块 + 环境变量） |
| `server/tts/deepseek.ts` | DeepSeek 实现 |
| `server/tts/edge.ts` | Edge 在线合成 |
| `server/tts/registry.ts` | 云端引擎注册表：**加一家 = 一个文件 + 这里一行** |
| `server/tts/service.ts` | 校验、限流、超时；`/api/tts/providers` 的数据来源 |
| `web/src/remote-tts.ts` | 前端请求 `/api/tts/speak` 并按句流式播放 |
