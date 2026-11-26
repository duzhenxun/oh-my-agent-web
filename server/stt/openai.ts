/**
 * `openai-compatible`：把一句音频整段 POST 到一个 OpenAI 形状的
 * `/v1/audio/transcriptions` 端点。
 *
 * 覆盖面是刻意的：OpenAI Whisper 本身、Groq / SiliconFlow / 各类中转网关、
 * 自建的 whisper.cpp server，大多都实现了这个形状。真正需要自研签名协议的
 * （火山豆包、阿里千问的实时接口）另写 provider，不要往这里塞 if。
 *
 * 限制也要说清：这是**整段识别**，说话过程中拿不到 partial ——
 * `session.text` 在 `end()` 之前一直是空串。要边说边出字，得接厂商的流式协议。
 */
import type { SttConfig, SttProvider, SttSession } from "./types.js";

/** 16k 单声道 int16 → 最小 WAV 容器（44 字节头 + PCM） */
export function pcmToWav(pcm: Buffer, sampleRate = 16_000, channels = 1, bitsPerSample = 16): Buffer {
	const blockAlign = (channels * bitsPerSample) / 8;
	const header = Buffer.alloc(44);
	header.write("RIFF", 0, "ascii");
	header.writeUInt32LE(36 + pcm.length, 4);
	header.write("WAVE", 8, "ascii");
	header.write("fmt ", 12, "ascii");
	header.writeUInt32LE(16, 16); // fmt chunk 长度
	header.writeUInt16LE(1, 20); // PCM
	header.writeUInt16LE(channels, 22);
	header.writeUInt32LE(sampleRate, 24);
	header.writeUInt32LE(sampleRate * blockAlign, 28); // byte rate
	header.writeUInt16LE(blockAlign, 32);
	header.writeUInt16LE(bitsPerSample, 34);
	header.write("data", 36, "ascii");
	header.writeUInt32LE(pcm.length, 40);
	return Buffer.concat([header, pcm]);
}

/** 不同网关返回形状不一样：`{text}` / `{data:{text}}` / `{result}` / 纯文本 */
function extractText(payload: unknown, raw: string): string {
	if (typeof payload === "string") return payload.trim();
	if (payload && typeof payload === "object") {
		const record = payload as Record<string, unknown>;
		if (typeof record.text === "string") return record.text.trim();
		const data = record.data;
		if (data && typeof data === "object" && typeof (data as Record<string, unknown>).text === "string") {
			return ((data as Record<string, unknown>).text as string).trim();
		}
		if (typeof record.result === "string") return record.result.trim();
		if (Array.isArray(record.results) && record.results.length > 0) {
			const first = record.results[0] as Record<string, unknown>;
			if (typeof first?.text === "string") return first.text.trim();
		}
	}
	return raw.trim().slice(0, 500);
}

export const openaiCompatible: SttProvider = {
	id: "openai-compatible",
	label: "OpenAI 兼容（Whisper / 各类网关）",
	fields: [
		{ key: "endpoint", label: "转写端点", required: true, placeholder: "https://api.openai.com/v1/audio/transcriptions" },
		{ key: "apiKey", label: "API Key", required: true, secret: true, placeholder: "sk-…" },
		{ key: "model", label: "模型", placeholder: "whisper-1" },
		{ key: "language", label: "语言", placeholder: "zh" },
	],

	create(config: SttConfig, log): SttSession {
		let chunks: Buffer[] = [];
		let text = "";
		let cancelled = false;

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
			},

			async end(): Promise<string> {
				if (cancelled) return "";
				const pcm = Buffer.concat(chunks);
				chunks = [];
				// 太短的不值得发一次请求（静音误触）
				if (pcm.length < 3_200) return "";

				const wav = pcmToWav(pcm);
				const form = new FormData();
				form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
				if (config.model) form.append("model", config.model);
				if (config.language) form.append("language", config.language);
				for (const [key, value] of Object.entries(config.extraFields ?? {})) form.append(key, value);

				const headers: Record<string, string> = { ...config.headers };
				// 没显式给 Authorization 才用 Bearer —— 有的网关要 `api-key: xxx`
				if (config.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
					headers.Authorization = `Bearer ${config.apiKey}`;
				}

				const timeoutMs = config.timeoutMs ?? 60_000;
				const response = await fetch(config.endpoint, {
					method: "POST",
					headers,
					body: form,
					signal: AbortSignal.timeout(timeoutMs),
				});
				const raw = await response.text();
				if (!response.ok) {
					log.warn("云端识别失败", { status: response.status, body: raw.slice(0, 300) });
					throw new Error(`云端识别 HTTP ${response.status}：${raw.slice(0, 200)}`);
				}
				let parsed: unknown = raw;
				try {
					parsed = JSON.parse(raw);
				} catch {
					// 有的网关直接回纯文本，保留原样
				}
				text = extractText(parsed, raw);
				return text;
			},
		};
	},
};
