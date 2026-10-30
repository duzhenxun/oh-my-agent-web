/**
 * 「语音播报」：用**浏览器内置**的语音合成（SpeechSynthesis）说话。
 *
 * 为什么不用云 TTS：不需要 key、不联网、不出网 —— 这个工作台本来就是单机工具。
 * 代价是音色取决于系统装了哪些语音（macOS 自带婷婷/美佳等），所以面板里给一个下拉框选。
 *
 * 两个独立的开关（对应面板上的两行）：
 *   - announce：完成 / 出错 / 等待审批时念**一句短话**；
 *   - readReplies：回答结束时朗读 AI 的**最终回复**（剥掉 markdown、截断），
 *     开了它就代替那句短话（否则两个一起念会打架）。
 */

export type TtsSettings = {
	/** 总开关（自动播报） */
	enabled: boolean;
	/** 播报事件：完成 / 出错 / 等待审批各念一句短话 */
	announce: boolean;
	/** 回答结束时朗读最终回复（代替那句短话） */
	readReplies: boolean;
	/** 语速 0.5–2（1 = 正常） */
	rate: number;
	/** 指定音色的 voiceURI；空 = 自动挑一个（先按浏览器语言，再退中文） */
	voiceURI: string;
	/**
	 * 是否把**在线音色**（Chrome 的「Google 普通话」等，`localService === false`）也列出来。
	 *
	 * 默认开：这些音色（尤其 Google 中文）比系统自带的机器音好听得多，用户明确要求保留。
	 * 代价是要联网，且部分 Chrome 版本选它后 `complete` 不触发、直接没声音 —— 所以
	 * 合成端把它当**次选**（先本机，再在线，见 `resolveVoice`），并且失败时自动退回默认音色。
	 * 真不想看到它们的可以取消勾选；已选的在线音色**不会被丢掉**，重新勾上就继续用。
	 */
	allowOnline: boolean;
};

export const DEFAULT_TTS_SETTINGS: TtsSettings = {
	// 默认就开：这个功能的重点就是「干完活说一声」（用户明确要的）。
	// 真觉得吵的人在这个面板里一关，选择会记在本机。
	enabled: true,
	announce: true,
	readReplies: false,
	rate: 1,
	voiceURI: "",
	// 在线音色默认保留在列表里（用户明确要求）；不想看到的可以取消勾选
	allowOnline: true,
};

/** 朗读回复时的字数上限：谁也不想听五分钟的独白 */
const MAX_TTS_CHARS = 400;

/** 播报用的短句（跟着界面语言走：这个工作台是中文的） */
export const TTS_LINE = {
	done: "任务已完成",
	error: "出错了，请查看对话",
	approval: "有一条工具调用等待你的批准",
} as const;

const STORAGE_KEY = "agent-web.voice.tts";

export function loadTtsSettings(): TtsSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_TTS_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<TtsSettings>;
		const merged: TtsSettings = { ...DEFAULT_TTS_SETTINGS, ...parsed };
		for (const key of ["enabled", "announce", "readReplies", "allowOnline"] as const) {
			if (typeof merged[key] !== "boolean") merged[key] = DEFAULT_TTS_SETTINGS[key];
		}
		merged.rate =
			typeof merged.rate === "number" && Number.isFinite(merged.rate)
				? Math.round(Math.max(0.5, Math.min(2, merged.rate)) * 10) / 10
				: DEFAULT_TTS_SETTINGS.rate;
		if (typeof merged.voiceURI !== "string") merged.voiceURI = DEFAULT_TTS_SETTINGS.voiceURI;
		return merged;
	} catch {
		return { ...DEFAULT_TTS_SETTINGS };
	}
}

export function saveTtsSettings(settings: TtsSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// 存不了就只对本次生效
	}
}

/** 浏览器到底有没有语音合成（Safari/Firefox/Chrome 都有；极老的没有） */
export function isTtsAvailable(): boolean {
	return typeof window !== "undefined" && "speechSynthesis" in window && "SpeechSynthesisUtterance" in window;
}

export type VoiceOption = { voiceURI: string; name: string; lang: string; localService: boolean };

/**
 * 可选的音色清单。
 * `getVoices()` 在 Chrome 上是**异步**填充的：第一次调用常常是空数组，
 * 所以调用方要监听 `voiceschanged` 再取一次（见 `subscribeVoices`）。
 * 默认**连在线音色一起列**（Google 那几条音质好得多，用户要保留）；不想要就传 `includeOnline: false`。
 * 注意：在线音色要联网，且部分 Chrome 版本选它后 `complete` 不触发、也没声音 ——
 * 所以 `resolveVoice` 把它们当**次选**，`speak` 遇上的时候也会自动退回默认音色再试一次。
 */
export function listVoices(options: { includeOnline?: boolean; onlyOnline?: boolean } = {}): VoiceOption[] {
	if (!isTtsAvailable()) return [];
	// onlyOnline：只在线的（面板默认走这条：本机那几条在这台机器上念不出来，列着只会误导）
	const onlyOnline = options.onlyOnline === true;
	const includeOnline = options.includeOnline !== false;
	return window.speechSynthesis
		.getVoices()
		.filter((voice) => (onlyOnline ? !voice.localService : includeOnline || voice.localService))
		.map((voice) => ({
			voiceURI: voice.voiceURI,
			name: voice.name,
			lang: voice.lang,
			localService: voice.localService,
		}))
		.sort((a, b) => a.lang.localeCompare(b.lang) || a.name.localeCompare(b.name));
}

/** 音色清单变化时回调（Chrome 异步填充）；返回取消订阅 */
export function subscribeVoices(callback: () => void): () => void {
	if (!isTtsAvailable()) return () => {};
	window.speechSynthesis.addEventListener("voiceschanged", callback);
	return () => window.speechSynthesis.removeEventListener("voiceschanged", callback);
}

/**
 * 纯函数：挑音色。指定了就精确匹配；否则先按浏览器语言前缀找（本机优先），
 * 再退「中文」，最后交给浏览器默认。
 *
 * `allowOnline` 不开时在线音色**根本不进候选**：旧设置里存过 Google 音色的会回退到同语言本机音色，
 * 而不是拿一条要联网、可能念不出来的音色去硬试。
 *
 * 开了 `allowOnline`（面板的「只列在线音色」）则反过来**优先在线**：这台机器上本机音色就是念不出来，
 * 此时还优先本机只会让「自动」落到一条永远不 start 的语音上。
 */
export function resolveVoice(
	voiceURI: string,
	voices: readonly VoiceOption[],
	pageLang: string,
	options: { allowOnline?: boolean } = {},
): VoiceOption | null {
	const allowOnline = options.allowOnline === true;
	const pool = allowOnline ? [...voices] : voices.filter((voice) => voice.localService);
	if (voiceURI !== "") {
		const exact = pool.find((voice) => voice.voiceURI === voiceURI);
		if (exact) return exact;
	}
	const prefix = pageLang.split("-")[0]?.toLowerCase() ?? "";
	const startsWith = (voice: VoiceOption, head: string): boolean => voice.lang.toLowerCase().startsWith(head);
	/** 同语言里先拿一类（allowOnline 时先在线，否则先本机），两类都不行再轮到中文 */
	const pick = (head: string): VoiceOption | null => {
		const preferred = pool.filter((voice) => voice.localService !== allowOnline);
		const other = pool.filter((voice) => voice.localService === allowOnline);
		return preferred.find((voice) => startsWith(voice, head)) ?? other.find((voice) => startsWith(voice, head)) ?? null;
	};
	if (prefix !== "") {
		const byPageLang = pick(prefix);
		if (byPageLang) return byPageLang;
	}
	return pick("zh");
}

/**
 * 纯函数：把 markdown 剥成「适合念出来」的连续文字。
 * 代码块整段丢掉（念出来是灾难），链接只留文字，标题/列表/表格符号去掉，换行变空格。
 */
export function stripMarkdownForSpeech(input: string): string {
	let text = input ?? "";
	text = text.replace(/```[\s\S]*?(?:```|$)/g, " "); // 代码块（含未闭合的）
	text = text.replace(/`([^`]+)`/g, "$1"); // 行内代码 → 内容
	text = text.replace(/!\[[^\]]*\]\([^)]*\)/g, " "); // 图片
	text = text.replace(/\[([^\]]+)\]\([^)]*\)/g, "$1"); // 链接 → 文字
	text = text.replace(/^\s{0,3}#{1,6}\s+/gm, ""); // 标题
	text = text.replace(/^\s{0,3}>\s?/gm, ""); // 引用
	text = text.replace(/^\s*[-*+]\s+/gm, ""); // 无序列表
	text = text.replace(/^\s*\|?[\s:|-]*\|[\s:|-]*$/gm, ""); // 表格分隔行
	text = text.replace(/\|/g, " "); // 表格竖线
	text = text.replace(/(\*\*\*|\*\*|__)(.*?)\1/g, "$2"); // 加粗
	text = text.replace(/(\*|_)([^*_\n]+)\1/g, "$2"); // 斜体
	text = text.replace(/<[^>]+>/g, " "); // 残留 html
	text = text.replace(/\r/g, "");
	text = text.replace(/[ \t]+/g, " ");
	text = text.replace(/\s*\n+\s*/g, " "); // 念出来是一口气，换行变空格
	text = text.trim();
	if (text.length > MAX_TTS_CHARS) text = `${text.slice(0, MAX_TTS_CHARS).trimEnd()}…`;
	return text;
}

/**
 * 语音合成失败码 → 人话（`SpeechSynthesisErrorEvent.error` 的取值）。
 *
 * 为什么需要这张表：浏览器的合成失败是**静默**的 —— 不报错、不弹提示，就是没声音，
 * 用户只能猜。面板里把它显示出来（见 VoicePanel 的「点了没出声」提示）。
 */
export function describeSpeechError(code: string): string {
	switch (code) {
		case "not-allowed":
			return "浏览器拦了这次朗读：先在页面上点一下（任意按钮）再试";
		case "voice-unavailable":
			return "选中的音色在系统里不可用，换个「语音」或选「自动」";
		case "audio-busy":
			return "音频输出被别的应用占着，关掉它再试";
		case "audio-hardware":
			return "没有可用的音频输出设备";
		case "network":
			return "这个音色要联网（在线音色）才能念，换一个本机音色";
		case "synthesis-unavailable":
			return "系统语音服务不可用（macOS：系统设置 → 辅助功能 → 朗读内容）";
		case "synthesis-failed":
			return "系统语音服务合成失败，试试点「停止」再试听一次";
		case "text-too-long":
			return "这段话太长，合成器拒了";
		case "invalid-argument":
			return "音色参数无效（换一个「语音」再试）";
		default:
			return `语音合成失败：${code}`;
	}
}

/** 用户点了「停止」：之后陆续回来的回调不该再把界面刷成失败 */
let stopped = false;
/** 每次 speak 自增；旧的那次看到序号变了，就知道自己已经被顶替 */
let speakSeq = 0;
/** 重试前隔多久：给 cancel 的异步事件留出落地时间 */
const RETRY_GAP_MS = 200;
/**
 * 「还没开始就被 canceled」最多再唤醒重试几次。
 *
 * 两次够了：第一次唤醒对付「系统语音服务冷起来 / 上一次 cancel 的余波」，
 * 第二次留给「第一遍唤醒自己也被连坐」这种情况。再多就只是在拖长用户等结论的时间。
 */
const MAX_WAKES = 2;
/** 唤醒句等多久算「试过了」：一个空格的合成通常几十毫秒，700ms 还没回就是服务真卡着 */
const WAKE_TIMEOUT_MS = 700;
/**
 * 「唤醒一下服务再重试」对这些错误码有意义：合成器 / 系统服务那一层没起来。
 * 其余的码（换音色、联网、音频设备、文本太长）唤醒帮不上忙，会让人白点一场。
 */
const WAKEABLE_CODES = new Set(["canceled", "interrupted", "synthesis-unavailable", "synthesis-failed"]);
/**
 * 正在念的句子。
 *
 * 为什么必须自己持有引用：Chrome 有「utterance 被 GC 掉 → 立刻回 error: canceled」的
 * 老问题（规范要求调用方持有引用）。一句「任务已完成」几毫秒就被回收太正常了，
 * 用户看到的就是「还没开始就被取消了」。这里持有到 onend / onerror / 超时为止。
 */
const liveUtterances = new Set<SpeechSynthesisUtterance>();

/**
 * 真的还有东西在队列里时才 `cancel()` —— 空队列上的一记 cancel 只有坏处。
 *
 * 为什么这么抠：`cancel()` 在 Chrome / macOS 上是**有余波**的（事件异步投递），紧跟着排进去的
 * 那句会拿到 `error: canceled`。队列本来就空的时候再 cancel，一点东西都没清掉，却让下一句
 * 白白死一次。
 *
 * 「队列空着就不要 cancel」是这一整套「没声 / 唤醒也没用」问题的分水岭：以前唤醒句念完
 * （`onend`）也要 cancel 一次 —— 于是**唤醒成功反而保证了紧跟其后的正文被取消**，两轮重试
 * 全军覆没，用户看到的就是「已自动唤醒并重试 2 次仍然没出声」（而关掉面板再点一次「试听」
 * 又能念，因为那一次队列是干净的）。
 *
 * 返回值：这次到底 cancel 了没有（假合成器上可断言）。永远不抛。
 */
function cancelIfBusy(synth: SpeechSynthesis): boolean {
	try {
		if (!synth.speaking && !synth.pending) return false;
		synth.cancel();
		return true;
	} catch {
		return false;
	}
}

/**
 * 唤醒系统语音服务 —— 专治「语音还没开始就被系统打断了（canceled）」。
 *
 * 现象与成因：Web Speech 的合成器其实交给**系统服务**代跑（macOS 是 `speechsynthesisd`，
 * Windows 是 SAPI / OneCore，Linux 走 speech-dispatcher）。这服务冷启动慢，或者上一次
 * `cancel()` 的余波还没落地时，刚排进去的那句会立刻拿到 `error: canceled` —— 一句都没念。
 * 而这种失败**下一次就好了**：那次失败本身已经把服务踢醒了。所以这里先念一句
 * **静音短句**（内容一个空格 + `volume = 0`）把 start→end 整条链路走通，再让调用方重排正文。
 *
 * 为什么不用正文来唤醒：唤醒是内部动作，念出半句「任务已完成」再被掐掉比没声更吓人；
 * 空格 + 音量 0 在 Chrome / Edge / Safari 上都只走流程、不出声。
 *
 * 契约：无论唤醒成功、报错、还是超时，`gapMs` 之后**只回调一次** `done` ——
 * 唤醒只是尽力而为，它自己失败了不该再长出一层错误（调用方还有看门狗和最终结论）。
 */
export function wakeSpeechService(done: () => void, gapMs = RETRY_GAP_MS): void {
	if (!isTtsAvailable()) {
		window.setTimeout(done, gapMs);
		return;
	}
	const synth = window.speechSynthesis;
	let wake: SpeechSynthesisUtterance;
	try {
		// 队列里真有东西卡着才清（见 cancelIfBusy：空队列上 cancel 会连坐掉接下来那句），
		// 并解开 paused（macOS 上 cancel 之后常停在 paused，不解就永远不出声）
		cancelIfBusy(synth);
		synth.resume();
		wake = new SpeechSynthesisUtterance(" ");
	} catch {
		window.setTimeout(done, gapMs);
		return;
	}
	liveUtterances.add(wake);
	wake.volume = 0;
	// 不设 lang：要问的是「默认路径通不通」，指定语言反而可能落进一个没有语音的分支
	wake.lang = "";
	let finished = false;
	/**
	 * 收尾。**不传 reason 就别 cancel** —— 这是这颗函数的全部要害：
	 *   - `"end"`：唤醒句自己念完了，队列本来就是空的。这一步 cancel 掉，紧接着的正文必然被
	 *     连坐成 `error: canceled`，等于「唤醒成功一次，正文必死一次」，重试永远不可能成功；
	 *   - `"timeout"` / `"error"`：可能真有一条卡在队列里，这时候 cancel 才是它该干的活
	 *     （而且是 `cancelIfBusy`：空着就一个字节的不发）。
	 */
	const finish = (reason: "end" | "error" | "timeout"): void => {
		if (finished) return;
		finished = true;
		window.clearTimeout(timer);
		liveUtterances.delete(wake);
		try {
			if (reason !== "end") cancelIfBusy(synth);
			synth.resume();
		} catch {
			// 忽略：唤醒失败不额外上报
		}
		window.setTimeout(done, gapMs);
	};
	// 故意不听 onstart：唤醒句也要走到 onend 才算链路真的通了；只 start 不回 end 的，靠下面这个超时
	const timer = window.setTimeout(() => finish("timeout"), WAKE_TIMEOUT_MS);
	wake.onend = () => finish("end");
	wake.onerror = () => finish("error");
	try {
		synth.speak(wake);
	} catch {
		finish("error");
	}
}

/** 失败时附带的上下文：面板拿它决定要不要给「唤醒并重试」那颗按钮 */
export type SpeakIssue = {
	/** 合成器给的错误码（有的话） */
	code?: string;
	/** true = 服务没起来 / 卡死 / 队列清不掉（唤一下再重试往往就好）；false = 换音色、联网、音量这类，唤醒无用 */
	wakeable: boolean;
};

/** 合成过程中给调用方的钩子（都不传 = 完全静默，自动播报就走这条路） */
type SpeakHooks = {
	/** 真的开始念了（用来清掉「点了没声」的提示） */
	onStart?: () => void;
	/** 念完了（按钮回到可点状态） */
	onEnd?: () => void;
	/**
	 * 失败了（码已翻成人话）。**自己 cancel 造成的不算**（canceled / interrupted 不上报）。
	 * 第二个参数是结构化上下文：面板靠 `wakeable` 决定要不要显示「唤醒并重试」，不去猜文案。
	 */
	onIssue?: (message: string, issue: SpeakIssue) => void;
};

/**
 * 念一段话。
 *
 * 「点了没声」的四个经典成因都在这一处堵（浏览器的合成失败是**静默**的，不堵就只能靠猜）：
 *   1. **`cancel()` 与 `speak()` 同一拍**：Chrome 的 cancel 是异步清队列，同 tick 排进去的
 *      utter 会被连坐清掉。所以只在真有上一句时 cancel，并隔一拍再 speak。
 *   2. **cancel 之后停在 paused**：macOS 上很常见，不 `resume()` 后面永远不出声。
 *   3. **音色清单还是空的**：`getVoices()` 在 Chrome 上异步填充，冷启动第一次点开面板常常是 []。
 *      先踢一次（调 getVoices 会触发加载）再等 `voiceschanged`，最多 1.2s，超时也照念。
 *   4. **选中的音色念不出来**：某些系统语音（尤其「下载中」/在线音色）会一直不 start。
 *      900ms 没动静就**退回浏览器默认音色重试一次** —— 这一步救回大多数「点了没声」。
 *   5. **系统语音服务没就绪**：新句子会立刻拿到 `error: canceled`（一句都没念）。
 *      以前这里直接报错、把「重启浏览器 / killall speechsynthesisd」丢给用户；
 *      现在先 `wakeSpeechService()`（静音短句走一遍 start→end 把服务踢醒）再重排，
 *      总共 `MAX_WAKES` 次（见那里的注释）—— 大多数情况用户根本看不到红字。
 *
 * 失败原因通过 `hooks.onIssue` 报给调用方（面板把它显示成一行红字）；自动播报不传 hooks，
 * 行为和以前一样完全静默。
 */
export function speak(text: string, settings: TtsSettings = loadTtsSettings(), hooks: SpeakHooks = {}): void {
	const body = text.trim();
	if (body === "") return;
	if (!isTtsAvailable()) {
		hooks.onIssue?.("当前浏览器不支持语音合成", { wakeable: false });
		return;
	}
	const synth = window.speechSynthesis;
	/**
	 * 「这次调用还算不算数」：用户点了停止、或已经有新的一句顶上来，后台还在跑的回调
	 * 就不该再改界面、再报错。
	 *
	 * 为什么必须有这层：cancel() 是异步投事件的，`canceled/interrupted` 可能落在
	 * **刚排进去的新句子**上。以前把这两个码一律当「我们自己掐的」静默返回，结果就是
	 * 「既没声、也不报错」，只剩面板那条 2.6s 兜底文案 —— 正是用户报的现象。
	 */
	stopped = false;
	const seq = ++speakSeq;
	const stale = (): boolean => stopped || seq !== speakSeq;
	/** 这次调用已经唤醒过几次（跨 first / retry 两轮累计） */
	let wakes = 0;

	/**
	 * 排一句话。`stage: "retry"` = 上一次选了音色却没响，这次交给浏览器默认。
	 */
	const speakNow = (pool: readonly VoiceOption[], stage: "first" | "retry" = "first"): void => {
		let watchdog = 0;
		try {
			const voice =
				stage === "retry"
					? null
					: resolveVoice(settings.voiceURI, pool, navigator.language ?? "zh-CN", {
							allowOnline: settings.allowOnline,
						});
			const utter = new SpeechSynthesisUtterance(body);
			liveUtterances.add(utter);
			utter.rate = settings.rate;
			utter.volume = 1;
			if (voice) {
				utter.voice = synth.getVoices().find((item) => item.voiceURI === voice.voiceURI) ?? null;
				utter.lang = voice.lang;
			} else {
				// 没挑到音色就**不设 lang**：设了但系统没有对应语音时 Chrome 会静默不念，
				// 让浏览器自己挑默认语音反而能出声。
				utter.lang = "";
			}

			let settled = false;
			/** 这个句子真的开念了吗：没开就被 canceled 掉 = 没念出来，不是我们自己掐的 */
			let didStart = false;
			const stopWatchdog = (): void => {
				if (watchdog) window.clearTimeout(watchdog);
				watchdog = 0;
			};
			/** 这一个句子的生命周期结束了：放掉引用（见 liveUtterances 的注释） */
			const release = (): void => {
				stopWatchdog();
				liveUtterances.delete(utter);
			};
			utter.onstart = () => {
				if (stale()) return;
				didStart = true;
				settled = true;
				stopWatchdog();
				hooks.onStart?.();
			};
			utter.onend = () => {
				if (stale()) return;
				settled = true;
				release();
				hooks.onEnd?.();
			};
			utter.onerror = (event) => {
				const code = String((event as SpeechSynthesisErrorEvent).error ?? "unknown");
				if (stale()) {
					settled = true;
					release();
					return;
				}
				const aborted = code === "canceled" || code === "interrupted";
				// 已经开念过才被打断 = 我们自己掐的（换一句 / 点停止），正常
				if (aborted && didStart) {
					settled = true;
					release();
					return;
				}
				// 还没开就被打断：合成器根本没念（不是我们的意图）—— 这正是「系统语音服务没起来」的样子
				// （服务冷启动 / 上一次 cancel 的余波）。先**唤醒再重试**，别急着把 killall 丢给用户。
				if (aborted) {
					settled = true;
					release();
					console.warn("[tts] 还没开始就被打断", {
						code,
						stage,
						voice: voice?.name ?? "(交给浏览器默认)",
						wakes,
					});
					if (wakes < MAX_WAKES) {
						wakes += 1;
						// 这里**不换音色**：`canceled` 说的是「服务没起来」，跟音色是两件事。
						// 以前这一轮顺手改成浏览器默认音色，在这类机器上正好落到那条念不出来的本机音色上
						// （真正能念的是在线音色），于是「唤醒成功、音色失败」，看起来还是一句没念。
						// 音色那一路由看门狗兜：900ms 没开始就退回浏览器默认再试一次。
						wakeSpeechService(() => {
							if (!stale()) speakNow(pool, stage);
						}, RETRY_GAP_MS * wakes);
						return;
					}
					hooks.onIssue?.(
						`语音服务没起来（${code}）：已自动唤醒并重试 ${MAX_WAKES} 次仍然没出声。点「试听」再试一次；还是不行就重启浏览器（macOS 也可在终端执行 killall speechsynthesisd）`,
						{ code, wakeable: true },
					);
					return;
				}
				// 选中的音色念不出来 → 退回默认音色再试一次（最常救回「点了没声」）
				if (stage === "first" && voice && code !== "not-allowed") {
					settled = true;
					release();
					console.warn("[tts] 音色不可用，改用默认音色重试", { code, voice: voice.name });
					window.setTimeout(() => {
						if (!stale()) speakNow(pool, "retry");
					}, RETRY_GAP_MS);
					return;
				}
				settled = true;
				release();
				// 留一条现场：出问题时能一眼看出「有几个可用音色 / 挑到了谁」
				console.warn("[tts] 合成失败", code, {
					voice: voice?.name ?? "(交给浏览器默认)",
					voices: pool.length,
					allVoices: synth.getVoices().length,
					rate: settings.rate,
				});
				hooks.onIssue?.(describeSpeechError(code), { code, wakeable: WAKEABLE_CODES.has(code) });
			};

			/**
			 * 看门狗：**两轮都要有**。
			 * 以前只给第一轮装，而且重试轮一旦被「队列没清干净」卡住就默默
			 * `return`（既不响也不报），用户看到的就是「点了没反应、也不知道好坏」。
			 * 现在最后一轮也一定有结论：要么响，要么给一句能照做的失败原因。
			 */
			watchdog = window.setTimeout(
				() => {
					if (settled || stale()) return;
					settled = true;
					release();
					cancelIfBusy(synth); // 它其实也没在念：清掉那条卡住的（空着就什么都不做）
					synth.resume();
					if (stage === "first" && voice) {
						console.warn("[tts] 音色 900ms 没有开始，改用默认音色重试", { voice: voice.name });
						// 隔一小拍再排：cancel 的事件是异步投的，紧跟着 speak 会被它接走变成「被取消」
						window.setTimeout(() => {
							if (!stale()) speakNow(pool, "retry");
						}, RETRY_GAP_MS);
						return;
					}
					console.warn("[tts] 语音服务没有响应", {
						voice: voice?.name ?? "(交给浏览器默认)",
						voices: pool.length,
						allVoices: synth.getVoices().length,
					});
					hooks.onIssue?.("系统语音服务没有响应（换个「语音」，或检查系统的语音合成设置）", { wakeable: true });
				},
				stage === "first" && voice ? 900 : 1500,
			);

			/**
			 * 队列里还挂着上一句时才排：先 cancel，等它真的空了再 speak。
			 * `cancel()` 是异步清的，所以这里**轮询等**而不是猜一个 90ms —— 等不到就报错，不静默放弃。
			 */
			const speakWhenIdle = (attempt: number): void => {
				if (settled || stale()) return;
				if (!synth.speaking && !synth.pending) {
					synth.resume();
					synth.speak(utter);
					return;
				}
				if (attempt >= 6) {
					settled = true;
					stopWatchdog();
					cancelIfBusy(synth);
					synth.resume();
					console.warn("[tts] 上一句没退干净，队列清不掉", { stage });
					hooks.onIssue?.("语音服务卡住了（上一句没退干净）：点「停止」再试听一次", { wakeable: true });
					return;
				}
				window.setTimeout(() => speakWhenIdle(attempt + 1), 120);
			};

			// ① 有上一句在队列里：掐掉（两句排队会糊成一团），等真清了再排（见上面的坑 1）
			if (synth.speaking || synth.pending) {
				cancelIfBusy(synth);
				synth.resume(); // ② cancel 之后可能停在 paused
				speakWhenIdle(0);
				return;
			}
			synth.resume();
			synth.speak(utter);
		} catch (error) {
			if (watchdog) window.clearTimeout(watchdog);
			hooks.onIssue?.(`语音合成出错：${error instanceof Error ? error.message : String(error)}`, { wakeable: false });
		}
	};

	// ③ 清单还空着 → 踢一次 + 等 voiceschanged（最多 1.2s），超时照样念
	const pool = listVoices({ includeOnline: settings.allowOnline });
	if (pool.length > 0) {
		speakNow(pool);
		return;
	}
	let settled = false;
	const finish = (): void => {
		if (settled) return;
		settled = true;
		unsubscribe();
		speakNow(listVoices({ includeOnline: settings.allowOnline }));
	};
	const unsubscribe = subscribeVoices(() => {
		if (listVoices({ includeOnline: settings.allowOnline }).length > 0) finish();
	});
	window.setTimeout(finish, 1200);
}

type SpeechDiagnosis = {
	available: boolean;
	/** getVoices() 里的总数 / 在线音色数 */
	voices: number;
	online: number;
	/** 合成器到底有没有响应：开始念 / 念完 / 报错 / 什么都不回 */
	started: boolean;
	ended: boolean;
	error: string | null;
	ms: number;
};

/**
 * 诊断：**绕过本项目所有策略**，拿一句最朴素的“测试”问浏览器：你能念吗？
 *
 * 为什么要它：用户遇到的「点了没声」可能卡在四层里的任何一层 —— 浏览器不支持、
 * 合成器被系统语音服务卡死、音色念不出来、或者其实念了只是没有音频输出。
 * 这个探针只复述事实（有没有 onstart / onend / onerror、用了多少毫秒），
 * 让「是哪里有问题」有个确定答案，而不是继续猜。
 */
export function diagnoseSpeech(timeoutMs = 2500): Promise<SpeechDiagnosis> {
	const base: SpeechDiagnosis = {
		available: isTtsAvailable(),
		voices: 0,
		online: 0,
		started: false,
		ended: false,
		error: null,
		ms: 0,
	};
	if (!base.available) return Promise.resolve(base);
	const all = window.speechSynthesis.getVoices();
	base.voices = all.length;
	base.online = all.filter((voice) => !voice.localService).length;
	const startedAt = Date.now();
	return new Promise<SpeechDiagnosis>((resolve) => {
		let done = false;
		let utter: SpeechSynthesisUtterance | null = null;
		const finish = (patch: Partial<SpeechDiagnosis>): void => {
			if (done) return;
			done = true;
			window.clearTimeout(timer);
			if (utter) liveUtterances.delete(utter);
			// 探针可能停在队列里（既没开始也没报错）：清掉，否则后面正常的播报会
			// 以为「有一句还在排队」，被我们自己的 cancel 连坐成 canceled
			cancelIfBusy(window.speechSynthesis);
			resolve({ ...base, ...patch, ms: Date.now() - startedAt });
		};
		const timer = window.setTimeout(() => finish({}), timeoutMs);
		try {
			utter = new SpeechSynthesisUtterance("测试");
			liveUtterances.add(utter);
			utter.volume = 1;
			// 故意不设 voice / lang / rate：要问的是「默认路径通不通」
			utter.onstart = () => finish({ started: true });
			utter.onend = () => finish({ started: true, ended: true });
			utter.onerror = (event) => finish({ error: String((event as SpeechSynthesisErrorEvent).error ?? "unknown") });
			window.speechSynthesis.resume();
			window.speechSynthesis.speak(utter);
		} catch (error) {
			finish({ error: error instanceof Error ? error.message : String(error) });
		}
	});
}

export function stopSpeaking(): void {
	if (!isTtsAvailable()) return;
	stopped = true;
	// 空队列上不发 cancel：队列里本来就没什么可停的，而这一记 cancel 会连坐掉下一句
	cancelIfBusy(window.speechSynthesis);
}
