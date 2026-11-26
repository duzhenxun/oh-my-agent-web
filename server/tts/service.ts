import { createEdgeEngine, TTS_TIMEOUT_MS } from "./edge.js";
import { createLocalEngines } from "./local.js";
import { readTtsConfig } from "./config.js";
import { createCloudEngines } from "./registry.js";
import { TtsError, type TtsAudio, type TtsEngine, type TtsInput, type TtsVoiceList } from "./types.js";
import { DEFAULT_EDGE_VOICE } from "./voices.js";

export const MAX_TEXT_CHARACTERS = 5000;
export const MAX_CONCURRENT_TTS = 2;

/** 面板需要知道的信息：哪家可用、哪家还没配密钥 */
export type TtsProviderInfo = {
	id: string;
	label: string;
	configured: boolean;
	note?: string;
};

function providerName(value: unknown): string {
	if (value === undefined) return "edge";
	if (typeof value !== "string" || !value) throw new TtsError(400, "必须指定 TTS provider");
	return value;
}

export function createTtsService(
	engines?: ReadonlyMap<string, TtsEngine>,
	options: { maxConcurrent?: number; timeoutMs?: number; dataDir?: string } = {},
) {
	const local = engines ? undefined : createLocalEngines(options.timeoutMs);
	// 云端厂商（DeepSeek / 以后补的千问、豆包）：密钥从 ~/.oh-my-agent-web/tts.json 按厂商分块读
	const config = engines ? undefined : readTtsConfig(options.dataDir);
	const cloud = config ? createCloudEngines(config) : new Map<string, TtsEngine>();
	const providers =
		engines ??
		new Map<string, TtsEngine>([
			["edge", createEdgeEngine()],
			...(local?.engines ?? []).map((engine) => [engine.id, engine] as const),
			...(cloud.entries() as Iterable<[string, TtsEngine]>),
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
		/** 供设置面板渲染：哪些引擎可用、哪家还缺密钥（只报状态，不吐 key） */
		providers(): TtsProviderInfo[] {
			return [...providers.entries()].map(([id, engine]) => ({
				id,
				label: engine.label ?? id,
				configured: engine.configured !== false,
				note: engine.note,
			}));
		},
		/** 云端配置文件的路径（面板上直接告诉用户改哪个文件） */
		configPath(): string | undefined {
			return config?.source;
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
