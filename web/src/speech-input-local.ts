/**
 * 本地语音输入：浏览器采音 → 服务端 → macOS 原生 SFSpeechRecognizer（离线）→ 文字。
 *
 * 和 `speech-input.ts`（Chrome 原生 Web Speech）是**同一接口的两套实现**，
 * `voice-input.ts` 只按设置挑一套，状态机/浮条/自动发送都不用改。
 *
 * 两个和 Chrome 不同的地方：
 *   1. Chrome 的 partial 是真·实时（服务端推）；这里是我们每 ~300ms 送一块 PCM，
 *      服务端回「到目前为止的文字」，所以延迟大约一块（300ms）+ 识别时间；
 *   2. 说完了要**先 flush**（停止采集 + `/api/asr/end`）才能拿到最后半句的 final ——
 *      所以本模块提供了 `flush()`，静音自动发送前会先调它。
 */
import type { SpeechInputErrorKind, SpeechSession } from "./speech-input.ts";
import { shouldFallbackOpen } from "./gate-fallback.ts";

/** 识别固定 16k（SFSpeech 与 macOS 音频栈都最认这个采样率） */
const TARGET_RATE = 16_000;
/** 多久送一块：太短请求多、太长出字顿 */
const POST_EVERY_MS = 300;

/**
 * 近讲门限：只把「明显比环境更响」的块送进识别。
 *
 * 为什么需要：`getUserMedia` 默认开着 AGC，会把坐在旁边的同事的话也拉到你差不多的音量；
 * 离线识别本身不做说话人分离，「谁在说」完全靠距离衰减出来的电平差，AGC 一开就把线索抹了。
 *
 * 底噪用「最近 3 秒里最安静的一帧」而不是均值：说词中间总有换气、字间空隙，最小值会落到静音上；
 * 而旁边人持续说话也顶不高最小值（均值会被抬上去，门限就跟着飘了）。
 */
const GATE_MARGIN_DB = 12;
/** 底噪窗口：约 3 秒（每块 ~85ms @48k/4096） */
const GATE_FLOOR_FRAMES = 36;
/** 起音确认：连续几帧都超过门限才算「你开口了」，挡住拍桌子、键盘、椅子响 */
const GATE_ONSET_FRAMES = 2;
/** 开口后的拖尾：字尾和句间停顿还要继续送，否则「帮我查一下」会被切成「帮我查」 */
const GATE_HOLD_MS = 700;
/**
 * 兜底放开：连续被挡这么久，就认为「不是别人在说话，是你太小声/离太远」，直接把音频放过去。
 * 用户 2026-11-21：「收音收得比较小的时候可不可以不要（挡）」。
 */
const GATE_FALLBACK_MS = 1500;

/** 一块音频的电平（dBFS；全零时给 -100 而不是 -Infinity） */
function blockLevelDb(samples: Float32Array): number {
	let sum = 0;
	for (let index = 0; index < samples.length; index += 1) {
		const value = samples[index] ?? 0;
		sum += value * value;
	}
	const rms = Math.sqrt(sum / Math.max(1, samples.length));
	return rms > 0 ? 20 * Math.log10(rms) : -100;
}

/** 把任意采样率的单声道 Float32 降到 16k 的 Int16（按窗口取均值，比直接抽点干净） */
function toInt16At16k(input: Float32Array, sourceRate: number): Int16Array {
	const ratio = sourceRate / TARGET_RATE;
	const length = Math.max(0, Math.floor(input.length / ratio));
	const output = new Int16Array(length);
	for (let index = 0; index < length; index += 1) {
		const start = Math.floor(index * ratio);
		const end = Math.min(input.length, Math.floor((index + 1) * ratio));
		let sum = 0;
		for (let cursor = start; cursor < end; cursor += 1) sum += input[cursor] ?? 0;
		const average = end > start ? sum / (end - start) : 0;
		const clamped = Math.max(-1, Math.min(1, average));
		output[index] = Math.round(clamped * 32767);
	}
	return output;
}

type StartResponse = { state?: string; message?: string; locale?: string; onDevice?: boolean };

/**
 * **跨会话复用**的 AudioContext。
 *
 * 为什么不能每次 `new AudioContext()`：`startVoiceInput()` 是异步的（先等 `/api/asr/start`
 * 回来），等拿到麦克风再创建 context 时**用户手势早就过去了**，Chrome 会给一个
 * `suspended` 的 context —— `ScriptProcessor` 永不回调，表现就是「在听、但一个字都不出」。
 * 第一次点浮条时创建并 `resume()`，之后（包括连续听写自动续听）一直复用它。
 */
let sharedContext: AudioContext | null = null;

function ensureContext(): AudioContext {
	if (!sharedContext || sharedContext.state === "closed") sharedContext = new AudioContext();
	// 第一次在点击里 resume：这一步必须在用户手势的同一帧里发生才有效
	void sharedContext.resume().catch(() => undefined);
	return sharedContext;
}

export function startLocalSpeechInput(options: {
	onText: (text: string) => void;
	onError: (kind: SpeechInputErrorKind, detail?: string, state?: string) => void;
	onEnd: () => void;
	/** 近讲灵敏度（dB）：0 = 关闭门限（同时放开 AGC，回到旧行为）；不传就用默认 12 */
	nearTalkDb?: number;
	/** AudioContext 的实际状态（诊断用：`suspended` 意味着采音不会回调） */
	onContext?: (state: AudioContextState) => void;
	/**
	 * 一段听写结束时的门限统计（诊断用）。
	 * 用户拖了「近讲灵敏度」却感觉没差别时，就看这里：`blocked` 为 0 说明门限压根没挡过，
	 * 也就是「你的声音一直远高于底噪」，跟滑块没关系。
	 */
	onGating?: (info: { marginDb: number; frames: number; blocked: number; fallbacks: number }) => void;
	/** 诊断：桥还在启动、正在等它 */
	onWaiting?: (detail: string) => void;
	/**
	 * 现在要不要**把麦克风音频丢掉**（朗读中）。
	 *
	 * 为什么不直接关麦：用户明确要求「麦克风一直开着」。所以朗读期间照常采音（不会被系统关掉），
	 * 只是不喂给识别 —— 否则念出来的声音会被当成用户说的话转成文字。
	 */
	shouldMuteAudio?: () => boolean;
	/**
	 * 现在要不要**跳过近讲门限**（朗读中）。
	 *
	 * 朗读正在外放时，底噪窗口里全是朗读的声音，门限就被抬高了 —— 你说的话反而"不够响"，
	 * 会被当成噪声挡掉（用户 2026-11-21：「为什么朗读不让我讲话了」）。朗读期间一律放行，
	 * 自己念出来的内容由上层按文本比对丢掉（见 `voice-input.ts` 的 `dropEcho`）。
	 */
	bypassGate?: () => boolean;
}): SpeechSession {
	let disposed = false;
	let lastText = "";
	/** 门限余量：设置里可调；0 就是关掉（旧行为） */
	const gateMarginDb = Math.max(0, Math.min(30, options.nearTalkDb ?? GATE_MARGIN_DB));
	const gating = gateMarginDb > 0;
	// 同步拿（此刻还在点击回调里），后面 await 再多也不会丢手势
	const context = ensureContext();
	let stream: MediaStream | null = null;
	let processor: ScriptProcessorNode | null = null;
	/** 已采集、还没发出去的 PCM（发送是串行的，别让请求乱序） */
	let pending: Int16Array[] = [];
	let upload: Promise<void> = Promise.resolve();
	let lastPostAt = 0;
	/**
	 * 门限状态：`levels` 是最近约 3 秒的电平（求最小值当底噪），
	 * `openRun` 是连续超过门限的帧数（起音确认），`holdUntil` 是开口后的拖尾截止时间。
	 */
	const levels: number[] = [];
	/** 门限统计（诊断用）：一共几帧、被挡了几帧、兜底放开过几次 */
	let gateFrames = 0;
	let gateBlocked = 0;
	let gateFallbacks = 0;
	/** 当前这一段「连续被挡」是从什么时候开始的（0 = 没在被挡） */
	let blockedSince = 0;
	let openRun = 0;
	let holdUntil = 0;
	/** 被门限挡掉时送的静音块（复用同一块，别每次回调都分配） */
	let silence: Float32Array | null = null;

	const post = async (path: string, body?: ArrayBuffer): Promise<Response> =>
		await fetch(path, {
			method: "POST",
			headers: body ? { "content-type": "application/octet-stream" } : undefined,
			body,
		});

	/** 把 pending 里的块按顺序发出去，并接住服务端回来的 partial */
	const drain = (): Promise<void> => {
		upload = upload.then(async () => {
			while (pending.length > 0 && !disposed) {
				const chunk = pending.shift()!;
				try {
					// 每块都是新分配的 Int16Array，buffer 正好是这块音频
					const response = await post("/api/asr/chunk", chunk.buffer as ArrayBuffer);
					if (!response.ok) continue;
					const data = (await response.json()) as { text?: string };
					const text = typeof data.text === "string" ? data.text : "";
					if (text !== lastText) {
						lastText = text;
						options.onText(text);
					}
				} catch {
					// 单块失败不致命：下一块还会带着完整上下文（服务端保留累计结果）
				}
			}
		});
		return upload;
	};

	/** 停采集（麦克风指示灯灭掉），返回还攒着的音频 */
	const stopCapture = async (): Promise<Int16Array[]> => {
		processor?.disconnect();
		processor = null;
		for (const track of stream?.getTracks() ?? []) track.stop();
		stream = null;
		// 注意：**不关 context**（见 ensureContext 的说明），只断开节点、停麦克风
		const rest = pending;
		pending = [];
		return rest;
	};

	/**
	 * 等桥起来：本机识别进程是**第一次用到才拉起**的，`/api/asr/start` 在它启动那几秒会回
	 * 「还没就绪」（state = starting / authorizing）。以前前端当场报错 —— 用户看到的就是
	 * 「每次第一次点麦克风都说没准备好」。现在先等（最多 ~8 秒），真起不来才报错。
	 */
	const waitBudgetMs = 8000;
	/** 期间用户点了停 / 组件卸载：别继续等下去，也别再回调 onError 打扰他 */
	const discontinued = () => disposed;

	const begin = async (): Promise<void> => {
		// 先问服务端能不能用：不能就把原因原样带出去（等待系统授权 / 没编译 / 报错）
		let status: StartResponse = {};
		const startedAt = Date.now();
		let announced = false;
		for (;;) {
			let retryable = false;
			try {
				const response = await post("/api/asr/start");
				status = (await response.json().catch(() => ({}))) as StartResponse;
				if (response.ok) break;
				// 只有「还在启动 / 等系统授权」值得等，其它（没有编译、进程崩了）立刻报
				retryable = status.state === "starting" || status.state === "authorizing";
			} catch (error) {
				options.onError("local", error instanceof Error ? error.message : "连不上本地识别服务", "error");
				options.onEnd();
				return;
			}
			if (!retryable || discontinued()) return;
			if (Date.now() - startedAt > waitBudgetMs) {
				options.onError("local", status.message ?? "本地识别启动超时", status.state);
				options.onEnd();
				return;
			}
			if (!announced) {
				announced = true;
				options.onWaiting?.(status.state ?? "starting");
			}
			await new Promise((resolve) => setTimeout(resolve, 400));
			if (discontinued()) return;
		}
		if (disposed) return;

		try {
			stream = await navigator.mediaDevices.getUserMedia({
				audio: {
					channelCount: 1,
					echoCancellation: true,
					noiseSuppression: true,
					// AGC 必须关：它会把远处同事的话也拉到跟你一样响，近讲门限就失效了
					// （门限被关掉时也就不需要它了：这时候要的是旧行为）
					autoGainControl: !gating,
				},
			});
		} catch {
			options.onError("denied");
			options.onEnd();
			return;
		}
		if (disposed) {
			for (const track of stream.getTracks()) track.stop();
			return;
		}

		// 拿不到 running 的 context 就是「听着但没字」：说出来，比安静地不出字好
		if (context.state !== "running") await context.resume().catch(() => undefined);
		options.onContext?.(context.state);
		const source = context.createMediaStreamSource(stream);
		// ScriptProcessor 已废弃但到处都能用；这个场景（单声道 4k 窗口）开销可以忽略
		processor = context.createScriptProcessor(4096, 1, 1);
		processor.onaudioprocess = (event) => {
			if (disposed) return;
			const samples = event.inputBuffer.getChannelData(0);
			const now = Date.now();
			// 近讲门限：电平明显高于「最近 3 秒最安静的一帧」才算你在说；拖尾期内继续送，字尾不会被剪
			let open = true;
			let inHold = false;
			if (gating && !options.bypassGate?.()) {
				const level = blockLevelDb(samples);
				levels.push(level);
				if (levels.length > GATE_FLOOR_FRAMES) levels.shift();
				const floor = Math.min(...levels);
				openRun = level > floor + gateMarginDb ? openRun + 1 : 0;
				open = openRun >= GATE_ONSET_FRAMES;
				inHold = now < holdUntil;
				gateFrames += 1;
				if (!open && !inHold) {
					gateBlocked += 1;
					if (blockedSince === 0) blockedSince = now;
					// 小声/远处：挡太久说明门限判错了对象，放开让它进去
					if (shouldFallbackOpen({ blockedForMs: now - blockedSince, fallbackMs: GATE_FALLBACK_MS })) {
						open = true;
						blockedSince = 0;
						gateFallbacks += 1;
					}
				} else {
					blockedSince = 0;
				}
				if (open) holdUntil = now + GATE_HOLD_MS;
			}
			let input: Float32Array = samples;
			// 朗读中：麦克风仍在采音，但这块音频不送进识别（否则会把自己念的话转成文字）
			if (options.shouldMuteAudio?.()) {
				silence ??= new Float32Array(samples.length);
				input = silence;
			} else if (!open && !inHold) {
				// 挡住时**送静音**而不是不送：SFSpeech 的时间轴不能有洞，否则断句会粘在一起
				silence ??= new Float32Array(samples.length);
				input = silence;
			}
			const pcm = toInt16At16k(input, context.sampleRate || TARGET_RATE);
			if (pcm.length === 0) return;
			pending.push(pcm);
			if (now - lastPostAt >= POST_EVERY_MS) {
				lastPostAt = now;
				void drain();
			}
		};
		source.connect(processor);
		processor.connect(context.destination); // 不连 destination 某些浏览器不触发回调（输出静音）
	};

	/** 说完了：停采集 → 发掉尾巴 → 等 final */
	const flush = async (): Promise<string> => {
			options.onGating?.({ marginDb: gateMarginDb, frames: gateFrames, blocked: gateBlocked, fallbacks: gateFallbacks });
		const rest = await stopCapture();
		for (const chunk of rest) {
			pending.push(chunk);
		}
		await drain();
		try {
			const response = await post("/api/asr/end");
			const data = (await response.json().catch(() => ({}))) as { text?: string };
			const text = typeof data.text === "string" ? data.text : lastText;
			if (text !== lastText) {
				lastText = text;
				options.onText(text);
			}
		} catch {
			// 收尾失败就用已经识别到的部分
		}
		return lastText;
	};

	/** 收尾（不阻塞调用方）：给 `closeSession` 用 */
	const stop = (): void => {
		if (disposed) return;
		disposed = true;
		void stopCapture();
	};

	void begin();

	return {
		stop,
		abort: () => {
			disposed = true;
			pending = [];
			void stopCapture();
		},
		flush,
	};
}
