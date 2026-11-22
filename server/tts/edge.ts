import { createRequire } from "node:module";
import { Worker } from "node:worker_threads";
import { EDGE_WORKER_SOURCE } from "./edge-worker-source.js";
import { TtsError, type TtsEngine, type TtsInput } from "./types.js";
import { edgeVoices } from "./voices.js";

export const MAX_AUDIO_BYTES = 12 * 1024 * 1024;
/**
 * 单次尝试的上限：握手 + 合成 + 收音频。
 *
 * 以前整条通道共用一个 45s：握手挂住时用户干等 45 秒，`MAX_CONCURRENT_TTS` 那两个槽位
 * 也被占死，后面每一句都只能拿到「TTS 正忙」。实测正常一句 1.7–2.0s、握手约 1.1s，
 * 8 秒还没出音频就说明这次已经死了，早失败才有机会重试。
 */
export const ATTEMPT_TIMEOUT_MS = 8_000;
/** 首次 + 一次重试：握手超时是瞬时抖动（实测 8 次里 2 次），重试一次能捞回来。 */
export const MAX_ATTEMPTS = 2;
/** 重试前留一点间隔：连着打反而更容易被上游拒。 */
const RETRY_GAP_MS = 250;
/** worker 里库自己的握手计时器要比主线程的硬超时早一点，好让「超时」这个原因先报出来。 */
const HANDSHAKE_MARGIN_MS = 500;
/** 引擎总预算：必须大于所有尝试之和，`service.ts` 的兜底定时器用它。 */
export const TTS_TIMEOUT_MS = MAX_ATTEMPTS * ATTEMPT_TIMEOUT_MS + 1_000;

const require = createRequire(import.meta.url);

export function edgeRate(rate: number): string {
	const percentage = Math.round((rate - 1) * 100);
	return `${percentage >= 0 ? "+" : ""}${percentage}%`;
}

/**
 * 这个失败值得再来一次吗？
 *
 * 429/403 是上游限流：立刻重试只会拿到同样的回应（实测间隔 1.2s 重试仍是 429），
 * 交给用户稍后再试；握手超时 / 提前结束 / 没音频都是瞬时抖动，重试一次通常能过。
 */
export function shouldRetryEdgeFailure(error: unknown, attempt: number): boolean {
	if (attempt >= MAX_ATTEMPTS) return false;
	if (error instanceof TtsError && error.status === 429) return false;
	const message = error instanceof Error ? error.message : String(error);
	return !/\b(429|403)\b/.test(message);
}

function pause(ms: number, signal: AbortSignal): Promise<void> {
	return new Promise((resolve, reject) => {
		const onAbort = () => {
			clearTimeout(timer);
			reject(signal.reason ?? new TtsError(499, "TTS 请求已取消"));
		};
		const timer = setTimeout(() => {
			signal.removeEventListener("abort", onAbort);
			resolve();
		}, ms);
		signal.addEventListener("abort", onAbort, { once: true });
	});
}

/**
 * 「首次 + 一次重试」的执行器。纯逻辑（真正的合成在 `runEdgeAttempt` 里），所以可以单测：
 * 重试几次、什么时候不重试、取消后是否还继续打上游。
 */
export async function withEdgeRetry<T>(run: () => Promise<T>, signal: AbortSignal): Promise<T> {
	let lastError: unknown;
	for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
		signal.throwIfAborted();
		try {
			return await run();
		} catch (error) {
			lastError = error;
			if (signal.aborted) throw error;
			if (!shouldRetryEdgeFailure(error, attempt)) throw error;
			await pause(RETRY_GAP_MS, signal);
		}
	}
	throw lastError ?? new TtsError(502, "Edge TTS 合成失败");
}

/** worker 回的类别 → 对外的错误（状态码决定 `routes.ts` 的响应和前端那行提示）。 */
function failureFor(reason: string): TtsError {
	if (reason === "rate-limited") return new TtsError(429, "Edge TTS 上游限流，请稍后再试");
	if (reason === "limit") return new TtsError(502, "Edge TTS 音频超过大小限制");
	if (reason === "timeout") return new TtsError(504, "Edge TTS 合成超时");
	return new TtsError(502, "Edge TTS 未返回有效音频");
}

function runEdgeAttempt(input: TtsInput, signal: AbortSignal): Promise<Buffer> {
	signal.throwIfAborted();
	return new Promise((resolve, reject) => {
		const worker = new Worker(EDGE_WORKER_SOURCE, {
			eval: true,
			workerData: {
				modulePath: require.resolve("node-edge-tts"),
				...input,
				lang: edgeVoices().voices.find((voice) => voice.id === input.voice)?.lang ?? "zh-CN",
				rate: edgeRate(input.rate),
				timeoutMs: ATTEMPT_TIMEOUT_MS - HANDSHAKE_MARGIN_MS,
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
		// 硬超时：库自己不管「握手成功之后一直不出音频」这种情况，只能由这里杀掉 worker。
		const timer = setTimeout(() => finish(new TtsError(504, "Edge TTS 合成超时")), ATTEMPT_TIMEOUT_MS);
		signal.addEventListener("abort", abort, { once: true });
		worker.on("message", (message: { audio?: Uint8Array; error?: string }) => {
			const audio = message?.audio;
			const valid = audio instanceof Uint8Array && audio.length > 0 && audio.length <= MAX_AUDIO_BYTES;
			if (message?.error === undefined && valid) {
				return finish(undefined, Buffer.from(audio));
			}
			finish(failureFor(typeof message?.error === "string" ? message.error : "upstream"));
		});
		worker.on("error", () => finish(new TtsError(502, "Edge TTS 合成失败")));
		worker.on("exit", () => finish(new TtsError(502, "Edge TTS 连接提前结束")));
		if (signal.aborted) abort();
	});
}

export function createEdgeEngine(): TtsEngine {
	return {
		voices: edgeVoices,
		speak(input: TtsInput, signal: AbortSignal): Promise<Buffer> {
			return withEdgeRetry(() => runEdgeAttempt(input, signal), signal);
		},
	};
}
