import { tNow } from "./use-language.ts";

export type RemoteTtsProvider = "edge" | "kokoro" | "qwen3";
export type RemoteVoice = { id: string; name: string; lang: string; gender?: string };
export type RemoteSpeechHooks = {
	onStart?: () => void;
	onEnd?: () => void;
	onIssue?: (message: string) => void;
};

/**
 * 下一句从哪儿拿（流式朗读用）：返回 undefined = 眼下没有下一句，这一轮就念完了。
 *
 * 有了它，`speakRemote` 会在**当前句还在播**的时候就要下一句并开始合成，
 * 而不是等这一句播完再发请求 —— 后者正是「句子之间空 1–2 秒」的来源。
 */
export type NextSpeechText = () => string | undefined;

let audioContext: AudioContext | undefined;

/**
 * 用**第一次用户手势**把音频解锁。
 *
 * 为什么要这一步：自动朗读（回答边出边念）发生时没有任何点击，Chrome 会把新的 AudioContext
 * 置为 `suspended`，`resume()` 不给权限 → 播放直接抛「浏览器拦截了播放」，而自动播报把错误
 * 咽了下去（用户只感觉到"没声音"）。这里在页面上第一次点击/按键时就把上下文建好并 resume，
 * 之后任何自动朗读都能出声。
 */
let unlockBound = false;

function bindAudioUnlock(): void {
	if (unlockBound || typeof document === "undefined") return;
	unlockBound = true;
	const unlock = () => {
		try {
			const Context = contextClass();
			if (!Context) return;
			if (!audioContext || audioContext.state === "closed") audioContext = new Context();
			if (audioContext.state === "suspended") void audioContext.resume().catch(() => undefined);
		} catch {
			// 建不出来就算了：真正的播放路径还会再试一次，并把原因报给调用方
		}
	};
	for (const type of ["pointerdown", "keydown", "touchstart"] as const) {
		document.addEventListener(type, unlock, { capture: true, passive: true });
	}
}

function contextClass(): typeof AudioContext | undefined {
	if (typeof window === "undefined") return undefined;
	return window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
}

export function isRemoteSpeechAvailable(): boolean {
	return Boolean(contextClass()) && typeof fetch === "function";
}

/** Keep sentence boundaries where possible and stay below Edge's SSML payload limit, including UTF-8 text. */
export function splitSpeechText(text: string, maxBytes = 1800): string[] {
	const chunks: string[] = [];
	const encoder = new TextEncoder();
	let chunk = "";
	let bytes = 0;
	for (const sentence of text.match(/[^。！？.!?\n]+[。！？.!?\n]*|[。！？.!?\n]+/gu) ?? []) {
		const size = encoder.encode(sentence).length;
		if (chunk && bytes + size > maxBytes) {
			chunks.push(chunk);
			chunk = "";
			bytes = 0;
		}
		for (const char of sentence) {
			const charBytes = encoder.encode(char).length;
			if (chunk && bytes + charBytes > maxBytes) {
				chunks.push(chunk);
				chunk = "";
				bytes = 0;
			}
			chunk += char;
			bytes += charBytes;
		}
	}
	if (chunk) chunks.push(chunk);
	return chunks;
}

const PROVIDER_LABEL: Record<RemoteTtsProvider, string> = {
	edge: "Edge",
	kokoro: "Kokoro",
	qwen3: "Qwen3",
};

export async function fetchRemoteVoices(signal: AbortSignal, provider: RemoteTtsProvider): Promise<RemoteVoice[]> {
	const response = await fetch(`/api/tts/voices?provider=${provider}`, { signal });
	if (!response.ok)
		throw new Error(
			tNow(
				`无法加载 ${PROVIDER_LABEL[provider]} 音色，请稍后重试`,
				`Unable to load ${PROVIDER_LABEL[provider]} voices; try again later`,
			),
		);
	const result = (await response.json()) as { voices: RemoteVoice[] };
	return result.voices;
}

/** Resumes audio during the click, before awaiting synthesis, so playback also works on mobile browsers. */
bindAudioUnlock();

export function speakRemote(
	text: string,
	settings: { provider: RemoteTtsProvider; voice: string; rate: number },
	hooks: RemoteSpeechHooks,
	next?: NextSpeechText,
): () => void {
	const controller = new AbortController();
	let canceled = false;
	let source: AudioBufferSourceNode | undefined;
	let releasePlayback: (() => void) | undefined;
	const cancel = () => {
		canceled = true;
		controller.abort();
		if (source) {
			source.onended = null;
			source.stop();
			source.disconnect();
			source = undefined;
		}
		releasePlayback?.();
	};

	const run = async () => {
		const Context = contextClass();
		if (!Context) throw new Error(tNow("当前浏览器不支持音频播放", "This browser does not support audio playback"));
		if (!audioContext || audioContext.state === "closed") audioContext = new Context();
		const context = audioContext;
		// This call must happen synchronously in the user's gesture, before the first await.
		await context.resume();
		if (canceled) return;
		if (context.state !== "running") {
			throw new Error(
				tNow("浏览器拦截了播放，请在页面上点击后重新朗读", "Playback was blocked; click on the page and try again"),
			);
		}
		// 句子流：当前这句的块念完，就向 `next` 要下一句（流式朗读时队列里通常已经有了）。
		// 之所以要在这里跨句取，是因为「下一块」要能在**当前这块还在播**的时候就发出去合成，
		// 而不是等这一句播完再发一轮请求 —— 后者是每句之间空 1–2 秒的来源。
		let chunks = splitSpeechText(text);
		let chunkIndex = 0;
		const nextChunk = (): string | undefined => {
			for (;;) {
				while (chunkIndex < chunks.length) {
					const chunk = chunks[chunkIndex++];
					if (chunk && chunk.trim() !== "") return chunk;
				}
				const following = next?.();
				if (following === undefined || following.trim() === "") return undefined;
				chunks = splitSpeechText(following);
				chunkIndex = 0;
			}
		};
		const prepare = async (body: string): Promise<AudioBuffer> => {
			const timeoutMs = settings.provider === "edge" ? 45_000 : 180_000;
			const timeout = window.setTimeout(() => controller.abort(), timeoutMs);
			try {
				const response = await fetch("/api/tts/speak", {
					method: "POST",
					headers: { "Content-Type": "application/json" },
					body: JSON.stringify({ ...settings, text: body }),
					signal: controller.signal,
				});
				if (!response.ok) {
					const result = (await response.json().catch(() => null)) as { error?: string } | null;
					throw new Error(
						result?.error ??
							tNow(
								`${settings.provider} 语音请求失败（${response.status}）`,
								`${settings.provider} speech request failed (${response.status})`,
							),
					);
				}
				const data = await response.arrayBuffer();
				if (canceled) throw new Error("canceled");
				return await context.decodeAudioData(data);
			} finally {
				window.clearTimeout(timeout);
			}
		};
		const firstChunk = nextChunk();
		let buffer = firstChunk === undefined ? undefined : await prepare(firstChunk);
		for (let first = true; buffer && !canceled; first = false) {
			const current = context.createBufferSource();
			source = current;
			current.buffer = buffer;
			current.connect(context.destination);
			const ended = new Promise<void>((resolve) => {
				releasePlayback = resolve;
				current.onended = () => {
					current.disconnect();
					if (source === current) source = undefined;
					resolve();
				};
			});
			current.start();
			if (first) hooks.onStart?.();
			// 预取下一块（跨句时就是下一句的首块），内存里最多压一块。
			const upcoming = nextChunk();
			const following = upcoming === undefined ? Promise.resolve(undefined) : prepare(upcoming);
			[, buffer] = await Promise.all([ended, following]);
		}
		if (!canceled) hooks.onEnd?.();
	};
	void run().catch((error: unknown) => {
		if (canceled) return;
		const timedOut = controller.signal.aborted;
		cancel();
		hooks.onIssue?.(
			timedOut
				? settings.provider === "edge"
					? tNow("Edge 语音请求超时，请检查网络后重试", "Edge speech timed out; check your connection and try again")
					: tNow(
							"本地模型首次加载或合成超时，请稍后重试",
							"Local model loading or synthesis timed out; try again later",
						)
				: error instanceof Error
					? error.message
					: tNow("语音播放失败，请重试", "Speech playback failed; try again"),
		);
	});
	return cancel;
}

/**
 * 暂停 / 继续**远端**朗读。
 *
 * 为什么挂起整个 AudioContext：这条通道是一段段 `AudioBufferSourceNode` 排着播的，
 * 单个 source 只能 `stop()`，没法「停在半句再接着放」。挂起期间 `currentTime` 不前进，
 * 正在播的那段原地冻住，`onended` 也不会提前发；恢复后从原位置继续，
 * 后面几段按 `currentTime` 排的时间轴照样成立。
 */
export function pauseRemoteSpeech(): void {
	if (!audioContext || audioContext.state !== "running") return;
	void audioContext.suspend();
}

export function resumeRemoteSpeech(): void {
	if (!audioContext || audioContext.state !== "suspended") return;
	void audioContext.resume();
}
