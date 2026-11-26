/**
 * STT provider 注册表。
 *
 * 加一家厂商 = 新建一个文件实现 `SttProvider`，然后在 `PROVIDERS` 里加一行。
 * `server/asr/bridge.ts` 完全不需要动 —— 它只调用这里的 `createSession()`。
 *
 * 现有：
 *   · `openai-compatible` —— `/v1/audio/transcriptions` 形状（Whisper 及大量网关）
 *   · `deepseek`         —— `POST /v1/tools/asr`，multipart WAV 进、`{text}` 出
 *   · `qwen`             —— 百炼 Qwen-Audio-ASR（多模态 messages + 必填 parameters.format），整段识别
 *   · `qwen-realtime`    —— 百炼 ASR message 协议的实时识别（`run-task` / `result-generated`）
 *   · `qwen-omni-realtime` —— 百炼 **Realtime 协议**（`session.update` / `input_audio_buffer.append`），
 *                           模型如 `qwen3.8-omni-flash-realtime`（多模态实时，比较贵）
 *
 * 后两个都是「边说边出字」，但**协议不同、模型不通用**：换模型不能只改 model，得换 provider。
 *
 * 已经留好的位置：
 *   · 阿里千问其它模型（qwen3-asr-flash 等）如果走 OpenAI 兼容形状，`openai-compatible` 也能用
 *   · 火山引擎 / 豆包（火山语音识别 1.0 / 2.0）
 *       签名和鉴权是自己的（Header 里 X-Api-App-Key / X-Api-Access-Key / X-Api-Resource-Id），
 *       返回也不一定是 `{text}`：新建 `server/stt/volcengine.ts` 实现 `SttProvider`，
 *       配 `providers.volcengine.{apiKey, appId, accessToken, resourceId}`，在下面加一行。
 *
 * 表单字段用 `fields` 声明，将来做 UI 直接读它，不用再改前端。
 */
import { deepseekStt } from "./deepseek.js";
import { openaiCompatible } from "./openai.js";
import { qwenOmniRealtimeStt } from "./qwen-omni-realtime.js";
import { qwenStt } from "./qwen.js";
import { qwenRealtimeStt } from "./qwen-realtime.js";
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";

const PROVIDERS: SttProvider[] = [openaiCompatible, deepseekStt, qwenStt, qwenRealtimeStt, qwenOmniRealtimeStt];

/** 实际要请求的端点（配置里没写就用厂商的默认端点）；都没有则抛错 */
export function sttEndpoint(config: SttConfig): string {
	const provider = getSttProvider(config.provider);
	const endpoint = config.endpoint?.trim() || provider?.defaultEndpoint;
	if (!endpoint) throw new Error(`provider ${config.provider} 需要配 endpoint（${PROVIDERS.map((entry) => entry.id).join("、")}）`);
	return endpoint;
}

export function sttProviderLabel(id: string): string {
	return getSttProvider(id)?.label ?? id;
}

export function listSttProviders(): SttProvider[] {
	return [...PROVIDERS];
}

export function getSttProvider(id: string): SttProvider | null {
	return PROVIDERS.find((provider) => provider.id === id) ?? null;
}

/** 按配置建一个会话；provider 不认识时抛错（调用方退回本地识别） */
export function createSttSession(config: SttConfig, log: SttLogger): SttSession {
	const provider = getSttProvider(config.provider);
	if (!provider) {
		throw new Error(
			`未知的 STT provider：${config.provider}（可用：${PROVIDERS.map((entry) => entry.id).join("、")}）`,
		);
	}
	return provider.create(config, log);
}

export type { SttConfig, SttSession };
