/**
 * 千问语音识别（阿里云百炼 Qwen-Audio-ASR）。
 *
 * 官方文档：https://www.alibabacloud.com/help/zh/model-studio/qwen-audio-asr-http-api
 *
 * 形状和 DeepSeek 完全不同 —— 它走的是**多模态对话**接口：
 * `input.messages[].content[] = { type: "input_audio", input_audio: { data } }`，
 * 音频既可以是公网 URL，也可以是 `data:audio/wav;base64,…`（我们用后者：音频不出本机、不用对象存储）。
 * `parameters.format` / `parameters.sample_rate` 是**必填**的（不填直接 `UNSUPPORTED_FORMAT: format is empty`）。
 *
 * 返回嵌套了一层：`output.text`（同时也有 `output.output.text` 这份重复的），
 * 还有 `output.sentence.words[]` 的字级时间戳 —— 我们只要文本。
 *
 * 限制：短音频模型（一次请求一段），所以这里沿用「整段识别 + 超长切段」的策略。
 */
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";
import { pcmToWav } from "./openai.js";

export const QWEN_ASR_ENDPOINT =
	"https://dashscope.aliyuncs.com/api/v1/services/aigc/multimodal-generation/generation";
export const QWEN_ASR_DEFAULT_MODEL = "qwen-audio-3.1-asr-flash";

const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** 切段长度：短音频模型按段发，110 秒留足余量 */
const SEGMENT_SECONDS = 110;
const MIN_BYTES = 3_200;

function endpointOf(config: SttConfig): string {
	const explicit = config.endpoint?.trim();
	if (explicit) return explicit;
	const base = config.headers?.["X-Qwen-Base-Url"]?.trim();
	if (base) return `${base.replace(/\/+$/, "")}/api/v1/services/aigc/multimodal-generation/generation`;
	return QWEN_ASR_ENDPOINT;
}

/** 中文之间不加空格，英文/数字之间补一个（和 DeepSeek 那家同一套拼接规则） */
function joinSegments(parts: string[]): string {
	return parts
		.filter((part) => part !== "")
		.reduce((acc, part) => {
			if (!acc) return part;
			const needsSpace = /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(part);
			return needsSpace ? `${acc} ${part}` : `${acc}${part}`;
		}, "");
}

/** 文本可能在 output.text / output.output.text / output.sentence.text，都试一遍 */
function extractText(payload: unknown): string {
	const pick = (value: unknown): string => {
		if (typeof value === "string") return value.trim();
		if (!value || typeof value !== "object") return "";
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim();
		const sentence = record.sentence;
		if (sentence && typeof sentence === "object" && typeof (sentence as Record<string, unknown>).text === "string") {
			return ((sentence as Record<string, unknown>).text as string).trim();
		}
		if (record.output) return pick(record.output);
		return "";
	};
	return pick(payload);
}

async function transcribe(wav: Buffer, config: SttConfig, log: SttLogger, signal: AbortSignal): Promise<string> {
	const apiKey = config.apiKey?.trim();
	if (!apiKey && !config.headers?.Authorization) {
		throw new Error("千问 ASR 还没配密钥：在 ~/.oh-my-agent-web/stt.json 里填 providers.qwen.apiKey");
	}
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		// 这个自定义头只是给 endpointOf 用的，别发给上游
		...(config.headers ?? {}),
	};
	delete headers["X-Qwen-Base-Url"];
	if (apiKey && !headers.Authorization) headers.Authorization = `Bearer ${apiKey}`;

	const body = {
		model: config.model?.trim() || QWEN_ASR_DEFAULT_MODEL,
		input: {
			messages: [
				{
					role: "user",
					content: [
						{
							type: "input_audio",
							// Data URI：音频不经第三方存储，直接用 base64 送过去
							input_audio: { data: `data:audio/wav;base64,${wav.toString("base64")}` },
						},
					],
				},
			],
		},
		parameters: {
			// 这两个是必填的（缺了直接 UNSUPPORTED_FORMAT）
			format: "wav",
			sample_rate: String(SAMPLE_RATE),
			// 有语种配置就顺带提升一下准确率；不传就让它自己识别
			...(config.language ? { language_hints: [config.language] } : {}),
			...Object.fromEntries(
				Object.entries(config.extraFields ?? {}).filter(([key]) => key.startsWith("param.")).map(([key, value]) => [key.slice(6), value]),
			),
		},
	};

	const response = await fetch(endpointOf(config), {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal,
	}).catch((error: unknown) => {
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		throw new Error(`连接千问失败（${cause?.code ?? cause?.message ?? "网络错误"}）`);
	});

	const raw = await response.text();
	if (!response.ok) {
		log.warn("千问识别失败", { status: response.status, body: raw.slice(0, 300) });
		let message = raw.trim().slice(0, 160);
		let code = "";
		try {
			const parsed = JSON.parse(raw) as { code?: string; message?: string };
			code = parsed.code ?? "";
			message = parsed.message ?? message;
		} catch {
			// 不是 JSON：保留原文前 160 字
		}
		if (response.status === 401 || code === "InvalidApiKey") {
			throw new Error("千问密钥无效：检查 ~/.oh-my-agent-web/stt.json 的 providers.qwen.apiKey（北京和新加坡的 key 不通用）");
		}
		if (response.status === 429 || code === "Throttling") throw new Error("千问识别并发/频率超限，稍等再试");
		if (code === "UNSUPPORTED_FORMAT") throw new Error(`千问不接受这段音频的格式：${message.slice(0, 120)}`);
		throw new Error(`千问识别失败（HTTP ${response.status}）${message ? `：${message}` : ""}`);
	}

	let text = "";
	try {
		text = extractText(JSON.parse(raw) as unknown);
	} catch {
		throw new Error(`千问返回了看不懂的内容：${raw.slice(0, 200)}`);
	}
	return text;
}

export const qwenStt: SttProvider = {
	id: "qwen",
	label: "千问 Qwen-Audio-ASR",
	defaultEndpoint: QWEN_ASR_ENDPOINT,
	// 面板里的模型下拉。只列文档/实测确认过的，其余靠手填。
	// 注意 `…-flash-message` 是下面那个实时 provider（qwen-realtime）的，别选错。
	models: ["qwen-audio-3.1-asr-flash"],
	fields: [
		{ key: "apiKey", label: "API Key（百炼）", required: true, secret: true, placeholder: "sk-…" },
		{ key: "model", label: "模型", placeholder: QWEN_ASR_DEFAULT_MODEL },
		{ key: "endpoint", label: "端点", placeholder: QWEN_ASR_ENDPOINT },
		{ key: "language", label: "语种提示（可空，自动识别）", placeholder: "zh" },
	],

	create(config: SttConfig, log): SttSession {
		let chunks: Buffer[] = [];
		let text = "";
		let cancelled = false;
		const controller = new AbortController();

		return {
			get text() {
				return text;
			},

			push(pcm: Buffer) {
				if (cancelled || pcm.length === 0) return;
				chunks.push(pcm);
			},

			cancel() {
				cancelled = true;
				chunks = [];
				controller.abort();
			},

			async end(): Promise<string> {
				if (cancelled) return "";
				const pcm = Buffer.concat(chunks);
				chunks = [];
				if (pcm.length < MIN_BYTES) return "";
				const timeoutMs = config.timeoutMs ?? 60_000;
				const signal = AbortSignal.any([controller.signal, AbortSignal.timeout(timeoutMs)]);
				const segmentBytes = SEGMENT_SECONDS * BYTES_PER_SECOND;
				const parts: string[] = [];
				for (let offset = 0; offset < pcm.length; offset += segmentBytes) {
					const slice = pcm.subarray(offset, Math.min(offset + segmentBytes, pcm.length));
					parts.push(await transcribe(pcmToWav(slice), config, log, signal));
				}
				text = joinSegments(parts);
				return text;
			},
		};
	},
};
