import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { EDGE_WORKER_SOURCE } from "./edge-worker-source.js";
import { TtsError, type TtsEngine, type TtsInput } from "./types.js";
import { edgeVoices } from "./voices.js";

export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
export const TTS_TIMEOUT_MS = 45_000;
const require = createRequire(import.meta.url);

export function edgeRate(rate: number): string {
	const percentage = Math.round((rate - 1) * 100);
	return `${percentage >= 0 ? "+" : ""}${percentage}%`;
}

export function createEdgeEngine(): TtsEngine {
	return {
		voices: edgeVoices,
		speak(input: TtsInput, signal: AbortSignal): Promise<Buffer> {
			signal.throwIfAborted();
			return new Promise((resolve, reject) => {
				const worker = new Worker(EDGE_WORKER_SOURCE, {
					eval: true,
					workerData: {
						modulePath: require.resolve("node-edge-tts"),
						...input,
						lang: edgeVoices().voices.find((voice) => voice.id === input.voice)?.lang ?? "zh-CN",
						rate: edgeRate(input.rate),
						timeoutMs: TTS_TIMEOUT_MS,
						maxAudioBytes: MAX_AUDIO_BYTES,
					},
					resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 8, stackSizeMb: 4 },
					// Do not inherit loaders/debug flags, or forward dependency diagnostics.
					execArgv: [],
					stdout: true,
					stderr: true,
				});
				worker.stdout.resume();
				worker.stderr.resume();
				let settled = false;
				const finish = (error?: unknown, audio?: Buffer) => {
					if (settled) return;
					settled = true;
					clearTimeout(timer);
					signal.removeEventListener("abort", abort);
					// Keep the concurrency slot until all worker sockets/memory are gone.
					void worker.terminate().then(
						() => (error ? reject(error) : resolve(audio!)),
						() => reject(new TtsError(502, "Edge TTS 合成失败")),
					);
				};
				const abort = () => finish(signal.reason ?? new TtsError(499, "TTS 请求已取消"));
				const timer = setTimeout(() => finish(new TtsError(504, "Edge TTS 合成超时")), TTS_TIMEOUT_MS);
				signal.addEventListener("abort", abort, { once: true });
				worker.on("message", (message: { audio?: Uint8Array; error?: string }) => {
					if (message.error === "limit") return finish(new TtsError(502, "Edge TTS 音频超过大小限制"));
					if (
						!(message.audio instanceof Uint8Array) ||
						!message.audio.length ||
						message.audio.length > MAX_AUDIO_BYTES
					) {
						return finish(new TtsError(502, "Edge TTS 未返回有效音频"));
					}
					finish(undefined, Buffer.from(message.audio));
				});
				worker.on("error", () => finish(new TtsError(502, "Edge TTS 合成失败")));
				worker.on("exit", () => finish(new TtsError(502, "Edge TTS 连接提前结束")));
				if (signal.aborted) abort();
			});
		},
	};
}
