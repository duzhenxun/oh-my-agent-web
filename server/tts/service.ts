import { createEdgeEngine, TTS_TIMEOUT_MS } from "./edge.js";
import { createLocalEngines } from "./local.js";
import { TtsError, type TtsAudio, type TtsEngine, type TtsInput, type TtsVoiceList } from "./types.js";
import { DEFAULT_EDGE_VOICE } from "./voices.js";

export const MAX_TEXT_CHARACTERS = 5000;
export const MAX_CONCURRENT_TTS = 2;

function providerName(value: unknown): string {
	if (value === undefined) return "edge";
	if (typeof value !== "string" || !value) throw new TtsError(400, "必须指定 TTS provider");
	return value;
}

export function createTtsService(
	engines?: ReadonlyMap<string, TtsEngine>,
	options: { maxConcurrent?: number; timeoutMs?: number } = {},
) {
	const local = engines ? undefined : createLocalEngines(options.timeoutMs);
	const providers =
		engines ??
		new Map<string, TtsEngine>([
			["edge", createEdgeEngine()],
			...(local?.engines ?? []).map((engine) => [engine.id, engine] as const),
		]);
	let active = 0;
	const engineFor = (provider: string) => {
		const engine = providers.get(provider);
		if (!engine) throw new TtsError(400, "不支持的 TTS provider");
		return engine;
	};
	return {
		close() {
			local?.close();
		},
		voices(provider: unknown): TtsVoiceList {
			return engineFor(providerName(provider)).voices();
		},
		async speak(body: unknown, signal: AbortSignal): Promise<TtsAudio> {
			if (!body || typeof body !== "object" || Array.isArray(body)) throw new TtsError(400, "请求体必须是 JSON 对象");
			const data = body as Record<string, unknown>;
			const provider = providerName(data.provider);
			const engine = engineFor(provider);
			if (typeof data.text !== "string" || !data.text.trim()) throw new TtsError(400, "text 必须是非空字符串");
			if (data.text.length > MAX_TEXT_CHARACTERS * 2 || [...data.text].length > MAX_TEXT_CHARACTERS) {
				throw new TtsError(400, `text 最多 ${MAX_TEXT_CHARACTERS} 字`);
			}
			// Reject SSML controls and lone UTF-16 surrogates (for-of yields lone surrogates as code points).
			const hasUnsupportedCharacter = [...data.text].some((character) => {
				const code = character.codePointAt(0)!;
				return (
					code <= 0x08 ||
					(code >= 0x0b && code <= 0x1f) ||
					(code >= 0xd800 && code <= 0xdfff) ||
					code === 0xfffe ||
					code === 0xffff
				);
			});
			if (hasUnsupportedCharacter) {
				throw new TtsError(400, "text 含不支持的控制字符或 Unicode 字符");
			}
			const defaultVoice = engine.defaultVoice ?? (provider === "edge" ? DEFAULT_EDGE_VOICE : undefined);
			const voice = data.voice === undefined ? defaultVoice : data.voice;
			if (typeof voice !== "string" || !engine.voices().voices.some((item) => item.id === voice)) {
				throw new TtsError(400, "voice 必须是音色列表中的有效 ID");
			}
			const rate = data.rate === undefined ? 1 : data.rate;
			if (typeof rate !== "number" || !Number.isFinite(rate) || rate < 0.5 || rate > 2) {
				throw new TtsError(400, "rate 必须是 0.5 到 2 之间的数字");
			}
			signal.throwIfAborted();
			if (active >= (options.maxConcurrent ?? MAX_CONCURRENT_TTS)) throw new TtsError(429, "TTS 正忙，请稍后重试");
			active++;
			const controller = new AbortController();
			const abort = () => controller.abort(signal.reason);
			signal.addEventListener("abort", abort, { once: true });
			const timer = setTimeout(
				() => controller.abort(new TtsError(504, "TTS 合成超时")),
				options.timeoutMs ?? engine.timeoutMs ?? TTS_TIMEOUT_MS,
			);
			try {
				const input: TtsInput = { text: data.text, voice, rate };
				const audio = await engine.speak(input, controller.signal);
				controller.signal.throwIfAborted();
				if (!audio.length) throw new TtsError(502, "TTS 未返回音频");
				return { audio, contentType: engine.contentType ?? "audio/mpeg" };
			} catch (error) {
				if (controller.signal.aborted) throw controller.signal.reason;
				if (error instanceof TtsError) throw error;
				throw new TtsError(502, "TTS 上游服务暂时不可用");
			} finally {
				clearTimeout(timer);
				signal.removeEventListener("abort", abort);
				active--;
			}
		},
	};
}

export type TtsService = ReturnType<typeof createTtsService>;
