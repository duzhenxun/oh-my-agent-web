/**
 * 千问语音合成（阿里云百炼 Qwen-Audio-TTS）。
 *
 * 官方文档：https://help.aliyun.com/zh/model-studio/qwen-audio-tts-http-api
 *           音色列表：https://help.aliyun.com/zh/model-studio/qwen-audio-tts-voice-list
 *
 * 和 DeepSeek 的两处关键差异（写代码前必须知道，否则就是「404 / 400 / 拿不到声音」）：
 *
 *   1. **非流式返回的是音频 URL，不是字节**：`output.audio.url`（OSS 地址，24 小时有效），
 *      所以这里要**再下载一次**才拿得到音频。多一跳，但换来的是不占我们的内存。
 *   2. **`voice` 必填且不能跨模型混用**：`qwen-audio-3.1-tts-flash` 有它自己的音色表
 *      （旗舰 4 个 + 一堆精品中文/英文），填别的模型的音色会回 `InvalidParameter / Engine error [411]`。
 *      所以音色表按模型分开列（`voicesFor`），默认模型是用户指定的 **3.1-flash**。
 *
 * 好消息：这家**支持调语速**（`rate` 0.5–2.0），面板上的语速滑杆对它有效
 * （DeepSeek 那家是静默忽略的）。
 */
import type { TtsProviderSecrets } from "./config.js";
import { TtsError, type TtsEngine, type TtsInput, type TtsVoice, type TtsVoiceList } from "./types.js";

export const QWEN_TTS_ENDPOINT = "https://dashscope.aliyuncs.com/api/v1/services/audio/tts/SpeechSynthesizer";
export const QWEN_TTS_DEFAULT_MODEL = "qwen-audio-3.1-tts-flash";
export const QWEN_TTS_DEFAULT_VOICE = "longanlingxin_v3.1";
export const QWEN_TTS_TIMEOUT_MS = 90_000;

/** 旗舰音色：flash 和 plus 都认这几个（用户 2026-11-24 指定用 3.1-flash） */
const FLAGSHIP_VOICES: TtsVoice[] = [
	{ id: "longanlingxin_v3.1", name: "龙安灵心（女，温润）", lang: "zh-CN", gender: "Female" },
	{ id: "xunanchuan_v3.1", name: "许南川（男，磁性）", lang: "zh-CN", gender: "Male" },
	{ id: "longanhuan_v3.1", name: "龙安欢（女，活泼）", lang: "zh-CN", gender: "Female" },
	{ id: "longanfengyue_v3.1", name: "龙安风悦（女，自然）", lang: "zh-CN", gender: "Female" },
];

/** flash 独占的精品音色（官方音色表里只列在 3.1-flash 下面，这里挑常用的一批） */
const FLASH_ONLY_VOICES: TtsVoice[] = [
	{ id: "yuxiaoyun_v3.1", name: "于小云（女，元气）", lang: "zh-CN", gender: "Female" },
	{ id: "qiaoxiaojiao_v3.1", name: "乔小娇（女，俏丽）", lang: "zh-CN", gender: "Female" },
	{ id: "xiaxiaochen_v3.1", name: "夏小晨（女，明亮）", lang: "zh-CN", gender: "Female" },
	{ id: "anmingyuan_v3.1", name: "安明远（男，清亮）", lang: "zh-CN", gender: "Male" },
	{ id: "wenhuaiqing_v3.1", name: "温怀清（女，柔和）", lang: "zh-CN", gender: "Female" },
	{ id: "xieshurou_v3.1", name: "谢舒柔（女，知性）", lang: "zh-CN", gender: "Female" },
	{ id: "xuyuyuan_v3.1", name: "许玉远（女，成熟）", lang: "zh-CN", gender: "Female" },
	{ id: "longxiaocheng_v3.1", name: "龙小诚（男，低音）", lang: "zh-CN", gender: "Male" },
	{ id: "longshu_v3.1", name: "龙书（男，沉稳）", lang: "zh-CN", gender: "Male" },
	{ id: "longjin_v3.1", name: "龙津（男，温润）", lang: "zh-CN", gender: "Male" },
	{ id: "longke_v3.1", name: "龙可（儿童，童声）", lang: "zh-CN", gender: "Female" },
	{ id: "libai_v3.1", name: "李白（男，诗词朗诵）", lang: "zh-CN", gender: "Male" },
	{ id: "loongbella_v3.1", name: "Bella（女，中英双语）", lang: "zh-CN", gender: "Female" },
	{ id: "Emily_v3.1", name: "Emily（英式女声）", lang: "en-GB", gender: "Female" },
	{ id: "Eric_v3.1", name: "Eric（英式男声）", lang: "en-GB", gender: "Male" },
	{ id: "Ava_v3.1", name: "Ava（美式女声）", lang: "en-US", gender: "Female" },
];

function voicesFor(model: string): TtsVoiceList {
	// 不认识的模型就按旗舰列 —— 真填错时上游会用 InvalidParameter 明确告诉他音色不匹配，
	// 这里只保证「至少有一颗能选」，不提前拒掉任何配置。
	const voices = /3\.1-tts-flash/.test(model) || model.includes("tts-flash") ? [...FLAGSHIP_VOICES, ...FLASH_ONLY_VOICES] : FLAGSHIP_VOICES;
	return {
		voices,
		note: `当前模型 ${model} 支持的 ${voices.length} 个音色（换模型时音色要跟着换，否则上游报音色不匹配）。非流式返回音频 URL，服务端会再下载一次。`,
	};
}

function endpointOf(secrets: TtsProviderSecrets | undefined): string {
	const explicit = secrets?.endpoint?.trim();
	if (explicit) return explicit;
	const base = secrets?.baseUrl?.trim();
	if (base) return `${base.replace(/\/+$/, "")}/api/v1/services/audio/tts/SpeechSynthesizer`;
	return QWEN_TTS_ENDPOINT;
}

const modelOf = (secrets: TtsProviderSecrets | undefined) => secrets?.model?.trim() || QWEN_TTS_DEFAULT_MODEL;

/** DashScope 的错误体是 `{ code, message, request_id }`；翻译成能照做的一句话 */
function upstreamError(status: number, raw: string): TtsError {
	let code = "";
	let message = "";
	try {
		const parsed = JSON.parse(raw) as { code?: string; message?: string };
		code = parsed.code ?? "";
		message = parsed.message ?? "";
	} catch {
		message = raw.trim().slice(0, 160);
	}
	if (status === 401 || code === "InvalidApiKey" || /invalid.*api.?key/i.test(message)) {
		return new TtsError(503, "千问密钥无效：检查 ~/.oh-my-agent-web/tts.json 里 providers.qwen.apiKey（北京和新加坡的 key 不通用）");
	}
	if (status === 429 || code === "Throttling") return new TtsError(429, "千问合成并发/频率超限，稍等再试");
	if (/Engine error \[411\]|voice/i.test(message)) {
		return new TtsError(400, `千问不接受这个音色（换模型时音色要跟着换）：${message.slice(0, 120)}`);
	}
	if (status === 400) return new TtsError(400, `千问拒绝了这次合成：${(message || code).slice(0, 160)}`);
	if (status === 503) return new TtsError(502, "千问服务繁忙，稍后再试");
	return new TtsError(502, `千问合成失败（HTTP ${status}）${(message || code).slice(0, 140)}`);
}

export function createQwenEngine(secrets: TtsProviderSecrets | undefined): TtsEngine {
	const model = modelOf(secrets);
	return {
		id: "qwen",
		label: "千问 Qwen-Audio-TTS（在线）",
		configured: Boolean(secrets?.apiKey),
		note: secrets?.apiKey
			? undefined
			: "还没配密钥：在 ~/.oh-my-agent-web/tts.json 里填 providers.qwen.apiKey（或设 AGENT_WEB_TTS_QWEN_KEY）",
		defaultVoice: secrets?.voiceId ?? QWEN_TTS_DEFAULT_VOICE,
		contentType: "audio/wav",
		timeoutMs: QWEN_TTS_TIMEOUT_MS,
		voices: () => voicesFor(model),
		async speak(input: TtsInput, signal: AbortSignal): Promise<Buffer> {
			const apiKey = secrets?.apiKey?.trim();
			if (!apiKey) {
				throw new TtsError(
					503,
					"千问 TTS 还没配密钥：在 ~/.oh-my-agent-web/tts.json 里填 providers.qwen.apiKey，或设环境变量 AGENT_WEB_TTS_QWEN_KEY",
				);
			}
			const text = input.text.trim();
			if (!text) throw new TtsError(400, "text 必须是非空字符串");

			const response = await fetch(endpointOf(secrets), {
				method: "POST",
				headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" },
				body: JSON.stringify({
					model,
					input: {
						text,
						voice: input.voice || QWEN_TTS_DEFAULT_VOICE,
						// 要 wav：前端 decodeAudioData 认它；mp3 也认，但 wav 少一层解码不确定性
						format: "wav",
						sample_rate: 24_000,
						// 这家支持语速（DeepSeek 不支持），service 已经把 rate 收在 0.5–2
						rate: input.rate,
					},
				}),
				signal,
			}).catch((error: unknown) => {
				const cause = (error as { cause?: { code?: string; message?: string } }).cause;
				throw new TtsError(502, `连接千问失败（${cause?.code ?? cause?.message ?? "网络错误"}）`);
			});

			const raw = await response.text();
			if (!response.ok) throw upstreamError(response.status, raw);

			let url = "";
			try {
				const parsed = JSON.parse(raw) as { output?: { audio?: { url?: unknown } }; code?: string; message?: string };
				// 上游有时候 200 但 body 里带错误码（流式被中断之类），别当成成功
				if (parsed.code) throw upstreamError(400, raw);
				if (typeof parsed.output?.audio?.url === "string") url = parsed.output.audio.url;
			} catch (error) {
				if (error instanceof TtsError) throw error;
				throw new TtsError(502, `千问返回了看不懂的内容：${raw.slice(0, 160)}`);
			}
			if (!url) throw new TtsError(502, "千问没有返回音频地址（可能被内容安全拦下），重试一次");

			// 非流式只给 URL：再拉一次拿字节（有效期 24 小时，即刻下载没有过期问题）
			const audio = await fetch(url, { signal }).catch((error: unknown) => {
				const cause = (error as { cause?: { code?: string; message?: string } }).cause;
				throw new TtsError(502, `下载千问合成的音频失败（${cause?.code ?? cause?.message ?? "网络错误"}）`);
			});
			if (!audio.ok) throw new TtsError(502, `下载千问合成的音频失败（HTTP ${audio.status}）`);
			const bytes = Buffer.from(await audio.arrayBuffer());
			if (bytes.length === 0) throw new TtsError(502, "千问返回的音频是空的，重试一次");
			return bytes;
		},
	};
}
