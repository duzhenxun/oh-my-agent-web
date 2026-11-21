/**
 * 语音输入（STT）：只包浏览器原生 Web Speech API（Chrome / Edge / Safari），不进依赖预算。
 *
 * 三条必须知道的限制（调用方先用 `speechInputSupported()` 挡一道，再给一句人话提示）：
 *   1. **安全上下文**：只有 localhost / HTTPS 才有麦克风。手机通过局域网
 *      `http://192.168.x.x:25257` 打开时**没有**（这不是 bug，浏览器就是这么规定的）；
 *   2. **Firefox 不支持**：没有这个接口，也没有能替代的原生能力；
 *   3. 中间结果（`interimResults`）是**累积**的：每次回调给的都是「这一轮到目前为止的整段」。
 *      调用方只能整段替换，不能往后追加 —— 追加就会把同一句话重复一遍。
 *
 * 这里**不管**「静音多久算说完」：`onend` 在 Chrome 上会因为安静而自己触发，
 * 那一拍不该当成「用户说完了」（见 `voice-input.ts` 的自愈重启）。
 */
export type SpeechInputErrorKind = "unsupported" | "denied" | "no-speech" | "network" | "other" | "local";

type RecognitionResultLike = { readonly isFinal: boolean } & ArrayLike<{ transcript?: string }>;

/** 只写这层用得到的部分：各浏览器的 `SpeechRecognition` 类型定义并不一致 */
type RecognitionLike = {
	lang: string;
	continuous: boolean;
	interimResults: boolean;
	maxAlternatives: number;
	start: () => void;
	stop: () => void;
	abort: () => void;
	onresult: ((event: { results: ArrayLike<RecognitionResultLike> }) => void) | null;
	onerror: ((event: { error?: string }) => void) | null;
	onend: (() => void) | null;
};

function recognitionClass(): (new () => RecognitionLike) | null {
	if (typeof window === "undefined") return null;
	const host = window as unknown as Record<string, unknown>;
	const ctor = host.SpeechRecognition ?? host.webkitSpeechRecognition ?? null;
	return typeof ctor === "function" ? (ctor as new () => RecognitionLike) : null;
}

/** 能不能用：接口在 **且** 是安全上下文。两个缺一个，点下去都只会静默失败 */
export function speechInputSupported(): boolean {
	if (!recognitionClass()) return false;
	if (typeof window === "undefined") return false;
	return window.isSecureContext === true;
}

export type SpeechSession = {
	/** 正常收尾：已经识别到的结果会先到（`onend` 随后） */
	stop: () => void;
	/** 直接掐掉：不再等结果（重启 / 换锚点用） */
	abort: () => void;
	/**
	 * 只有本地引擎有：先停采集、再等服务端给出的 final。
	 * Chrome 那边说完是 `stop()` 之后 onend 自然来，不需要这一步。
	 */
	flush?: () => Promise<string>;
};

export function startSpeechInput(options: {
	/** BCP-47，例如 `"zh-CN"` / `"en-US"`。不设会按浏览器语言乱猜 */
	lang: string;
	/** 这一轮到目前为止的整段文字（中间结果也在内） */
	onText: (text: string) => void;
	onError: (kind: SpeechInputErrorKind) => void;
	/** 会话自己结束（用户点了停、或浏览器因为安静自己收摊） */
	onEnd: () => void;
}): SpeechSession | null {
	const Ctor = recognitionClass();
	if (!Ctor) {
		options.onError("unsupported");
		return null;
	}
	if (typeof window === "undefined" || window.isSecureContext !== true) {
		options.onError("unsupported");
		return null;
	}
	const recognition = new Ctor();
	recognition.lang = options.lang;
	recognition.continuous = true;
	recognition.interimResults = true;
	recognition.maxAlternatives = 1;

	recognition.onresult = (event) => {
		let text = "";
		for (let index = 0; index < event.results.length; index += 1) {
			const result = event.results[index];
			text += result?.[0]?.transcript ?? "";
		}
		options.onText(text.trim());
	};
	recognition.onerror = (event) => {
		const code = event.error ?? "other";
		if (code === "not-allowed" || code === "service-not-allowed") options.onError("denied");
		else if (code === "no-speech") options.onError("no-speech");
		else if (code === "network") options.onError("network");
		// aborted = 我们自己掐的，不上报
		else if (code !== "aborted") options.onError("other");
	};
	recognition.onend = () => options.onEnd();

	try {
		// 必须在用户手势里调（浮条的 pointerup 就在手势里），否则 Chrome 会抛 InvalidStateError
		recognition.start();
	} catch {
		options.onError("other");
		return null;
	}
	return {
		stop: () => {
			try {
				recognition.stop();
			} catch {
				// 已经停了就算了
			}
		},
		abort: () => {
			try {
				recognition.abort();
			} catch {
				// 同上
			}
		},
	};
}
