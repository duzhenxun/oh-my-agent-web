/**
 * 云端 TTS 引擎注册表 —— **加一家厂商 = 新建一个文件 + 这里一行**。
 *
 * `server/tts/service.ts` 不需要动：它只按 id 从这里取引擎。
 * 密钥由 `server/tts/config.ts` 按厂商分块提供（各配置各的，互不影响）。
 *
 * 现有：
 *   · `deepseek` —— `POST /v1/tools/tts`，JSON 进、wav 出（见 deepseek.ts）
 *   · `qwen`     —— 阿里百炼 Qwen-Audio-TTS（3.1-flash），JSON 进、**音频 URL** 出，要再下一次（见 qwen.ts）
 *
 * 留给后面两家的位置（协议形状不同，所以各占一个文件，不要往 deepseek.ts 里塞 if）：
 *
 *   · 千问 / 阿里百炼（Qwen-TTS、CosyVoice）—— **已接**：`server/tts/qwen.ts`
 *     （支持语速、音色按模型分表、非流式返回 URL 后再下载）
 *
 *   · 火山引擎 / 豆包语音合成
 *       新建 `server/tts/volcengine.ts`：`POST https://openspeech.bytedance.com/api/v1/tts`，
 *       请求头用 `Authorization: Bearer;{accessToken}`（注意是分号，不是空格），
 *       body 里要 appid / cluster / voice_type，**响应是 base64**（`data` 字段）。
 *       配 `providers.volcengine.{appId, accessToken, cluster, voiceId}`。
 *
 * 两家都接完之后，前端只需要在 `web/src/remote-tts.ts` 的 `RemoteTtsProvider`
 * 与 `web/src/components/VoicePanel.tsx` 的下拉里各加一行 —— 服务端这边不用再改。
 */
import { providerSecrets, type TtsConfigRead } from "./config.js";
import { createDeepseekEngine } from "./deepseek.js";
import { createQwenEngine } from "./qwen.js";
import type { TtsEngine } from "./types.js";

export function createCloudEngines(config: TtsConfigRead): Map<string, TtsEngine> {
	const engines: TtsEngine[] = [
		// 没配密钥也注册：用户能选到它、并拿到「去哪儿填 key」的报错，而不是「不支持的 provider」
		createDeepseekEngine(providerSecrets(config, "deepseek")),
		createQwenEngine(providerSecrets(config, "qwen")),
	];
	return new Map(engines.map((engine) => [engine.id!, engine] as const));
}
