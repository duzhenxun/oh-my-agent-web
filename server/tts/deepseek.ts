/**
 * DeepSeek 语音合成（`POST /v1/tools/tts`）。
 *
 * 官方文档：https://api-docs.deepseek.com/zh-cn/guides/tts/
 *
 * 形状很简单：JSON 进、音频字节流出（整段），不需要 WebSocket 那套流式协议 ——
 * 这个仓库的播报链路本来就是「一句一请求、拿到整块音频再播」，整段最合适。
 *
 * 两个要提前说清的限制（都会体现在 voices().note 里）：
 *   · 只有两个音色：stella（女）/ tide（男），没得挑；
 *   · **不支持调节语速**，也没法断点续传 —— 前端那条语速滑杆对这家是无效的。
 *
 * 语种不用传，服务端按文本自动判断。
 */
import type { TtsProviderSecrets } from "./config.js";
import { TtsError, type TtsEngine, type TtsInput, type TtsVoiceList } from "./types.js";

export const DEEPSEEK_TTS_BASE_URL = "https://api.deepseek.com";
export const DEEPSEEK_TTS_TIMEOUT_MS = 60_000;
export const DEEPSEEK_DEFAULT_VOICE = "stella";
/** 单次请求上限：10000 个计费字符 / 64 KiB 请求体（这里按字符数先挡一下） */
const MAX_CHARACTERS = 10_000;

const VOICES: TtsVoiceList = {
	voices: [
		{ id: "stella", name: "海星（女声，默认）", lang: "zh-CN", gender: "Female" },
		{ id: "tide", name: "暗潮（男声）", lang: "zh-CN", gender: "Male" },
	],
	note: "DeepSeek 只有这两个音色；按文本自动判断语种；不支持调节语速（面板上的语速对它无效）。",
};

function endpointOf(secrets: TtsProviderSecrets | undefined): string {
	const explicit = secrets?.endpoint?.trim();
	if (explicit) return explicit;
	const base = (secrets?.baseUrl?.trim() || DEEPSEEK_TTS_BASE_URL).replace(/\/+$/, "");
	return `${base}/v1/tools/tts`;
}

/** 上游状态码 → 用户能看懂的一句话（原文只留在日志/细节里） */
function upstreamError(status: number, raw: string): TtsError {
	const detail = raw.trim().slice(0, 160);
	if (status === 400) {
		// 文档：没有可朗读的文本，或文本未通过内容审核（Content Exists Risk）
		return new TtsError(400, `DeepSeek 没有合成这段文字（内容审核未通过或没有可朗读内容）${detail ? `：${detail}` : ""}`);
	}
	if (status === 401 || status === 403) {
		return new TtsError(503, "DeepSeek 密钥无效或没有语音合成权限：检查 ~/.oh-my-agent-web/tts.json 里的 providers.deepseek.apiKey");
	}
	if (status === 429) return new TtsError(429, "DeepSeek 同时进行的合成请求数超限，稍等再试");
	if (status === 504) return new TtsError(504, "DeepSeek 合成超时");
	if (status === 503) return new TtsError(502, "DeepSeek 服务繁忙，稍后再试");
	return new TtsError(502, `DeepSeek 合成失败（HTTP ${status}）${detail ? `：${detail}` : ""}`);
}

export function createDeepseekEngine(secrets: TtsProviderSecrets | undefined): TtsEngine {
	return {
		id: "deepseek",
		label: "DeepSeek TTS（在线）",
		// 没密钥也注册：前端能选到它，然后拿到一句「怎么配」的报错，而不是「不支持的 provider」
		configured: Boolean(secrets?.apiKey),
		note: secrets?.apiKey
			? undefined
			: "还没配密钥：在 ~/.oh-my-agent-web/tts.json 里填 providers.deepseek.apiKey（或设 AGENT_WEB_TTS_KEY）",
		defaultVoice: secrets?.voiceId ?? DEEPSEEK_DEFAULT_VOICE,
		contentType: "audio/wav",
		timeoutMs: DEEPSEEK_TTS_TIMEOUT_MS,
		voices: () => VOICES,
		async speak(input: TtsInput, signal: AbortSignal): Promise<Buffer> {
			const apiKey = secrets?.apiKey?.trim();
			if (!apiKey) {
				throw new TtsError(
					503,
					"DeepSeek TTS 还没配密钥：在 ~/.oh-my-agent-web/tts.json 里填 providers.deepseek.apiKey，或设环境变量 AGENT_WEB_TTS_KEY",
				);
			}
			const text = input.text.trim();
			if (!text) throw new TtsError(400, "text 必须是非空字符串");
			if ([...text].length > MAX_CHARACTERS) throw new TtsError(400, `DeepSeek 单次最多 ${MAX_CHARACTERS} 字`);

			const response = await fetch(endpointOf(secrets), {
				method: "POST",
				headers: {
					Authorization: `Bearer ${apiKey}`,
					"Content-Type": "application/json",
					Accept: "audio/wav",
				},
				// voice / rate 里的 rate 是静默忽略的：这家不支持语速（见文件头）
				body: JSON.stringify({
					text,
					voice_id: input.voice || DEEPSEEK_DEFAULT_VOICE,
					format: "wav",
					filter_markdown: true,
				}),
				signal,
			});
			if (!response.ok) throw upstreamError(response.status, await response.text().catch(() => ""));
			const audio = Buffer.from(await response.arrayBuffer());
			// 文档：音频开始返回后若合成失败，响应会中途断开 —— 空音频一律当失败
			if (audio.length === 0) throw new TtsError(502, "DeepSeek 没有返回音频（可能中途失败），重试一次");
			return audio;
		},
	};
}
