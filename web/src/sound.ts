/**
 * 「声音与语音」里的**提示音**。
 *
 * 全部用 Web Audio 现场合成（不打包任何音频文件）：整个功能不到 2KB、离线可用、
 * 也不用管音频版权。设置存 localStorage（音量/音色是这台机器的属性，不该多端同步）。
 *
 * 浏览器策略：AudioContext 在**用户手势里**才能被叫醒（Safari/iOS 尤其严格：不在手势里
 * 建的上下文会一直是 suspended，之后再 resume 也不放行）。所以这里常驻一个解锁器：
 * 第一次点击/按键就把上下文建好并 resume，自动触发的提示音才不会白响一场。
 *
 * 还有一类坑：iOS 切后台、来电之后上下文会变成 `interrupted`（不在 TS 类型里），
 * 只认 `suspended` 的写法从此永远不响 —— 所以这里一律用「不是 running 就唤醒」。
 */

export type SoundKind = "start" | "done" | "error" | "approval";

export type SoundSettings = {
	/** 总开关：关掉就一声都不响 */
	enabled: boolean;
	/** 回复开始（智能体开始新一轮） */
	start: boolean;
	/** 回复结束（智能体完成一轮回答） */
	done: boolean;
	/** 出错（弹出错误提示时） */
	error: boolean;
	/** 等待审批（AI 请求执行工具、等你批准） */
	approval: boolean;
	/** 总音量 0–100 */
	volume: number;
};

const DEFAULT_SOUND_SETTINGS: SoundSettings = {
	enabled: true,
	// 开始只给一个很轻的「嗒」，默认**关**：每轮都响一下很吵
	start: false,
	done: true,
	error: true,
	approval: true,
	volume: 70,
};

export const SOUND_LABEL: Record<SoundKind, { title: string; hint: string }> = {
	start: { title: "回复开始", hint: "智能体开始新一轮时" },
	done: { title: "回复结束", hint: "智能体完成一轮回答时" },
	error: { title: "出错", hint: "出现错误提示时" },
	approval: { title: "等待审批", hint: "AI 请求执行工具、等待批准时" },
};

const STORAGE_KEY = "agent-web.voice.sound";

/** 读设置：坏数据一律回默认值（别让一个 NaN 把音量算成静音） */
export function loadSoundSettings(): SoundSettings {
	try {
		const raw = localStorage.getItem(STORAGE_KEY);
		if (!raw) return { ...DEFAULT_SOUND_SETTINGS };
		const parsed = JSON.parse(raw) as Partial<SoundSettings>;
		const merged: SoundSettings = { ...DEFAULT_SOUND_SETTINGS, ...parsed };
		for (const key of ["enabled", "start", "done", "error", "approval"] as const) {
			if (typeof merged[key] !== "boolean") merged[key] = DEFAULT_SOUND_SETTINGS[key];
		}
		if (typeof merged.volume !== "number" || !Number.isFinite(merged.volume)) {
			merged.volume = DEFAULT_SOUND_SETTINGS.volume;
		} else {
			merged.volume = Math.round(Math.max(0, Math.min(100, merged.volume)) / 5) * 5;
		}
		return merged;
	} catch {
		return { ...DEFAULT_SOUND_SETTINGS };
	}
}

export function saveSoundSettings(settings: SoundSettings): void {
	try {
		localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
	} catch {
		// 隐私模式 / 存储已满：不持久化，但这次设置照样生效
	}
}

let ctx: AudioContext | null = null;
/** 解锁器只装一次 */
let unlockInstalled = false;

function createContext(): AudioContext | null {
	try {
		const Ctor =
			window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
		if (!Ctor) return null;
		ctx = new Ctor();
		return ctx;
	} catch {
		return null;
	}
}

/** 上下文是不是已经能出声（`interrupted` 这类非标准状态也走 false，见文件头） */
function isRunning(context: AudioContext): boolean {
	return (context.state as string) === "running";
}

/** 懒建 + 顺手唤醒共享的 AudioContext（`interrupted` / `closed` 也一并收拾） */
function audio(): AudioContext | null {
	try {
		if (ctx && (ctx.state as string) === "closed") ctx = null;
		const context = ctx ?? createContext();
		if (!context) return null;
		if (!isRunning(context)) void context.resume().catch(() => {});
		return context;
	} catch {
		return null;
	}
}

/**
 * 常驻解锁器：把「第一次用户手势」当成唤醒音频上下文的唯一合法时机。
 *
 * 不装它的话，自动触发的那一声（回合完成时没有任何手势）在 Safari/iOS 上**永远**
 * 建不出 running 的上下文 —— 用户听到的就是「语音会念，提示音不响」。
 * 监听器不解绑：切后台/来电之后上下文可能再次被打断，下一次点击还得再叫一次。
 */
function installUnlock(): void {
	if (unlockInstalled || typeof window === "undefined") return;
	unlockInstalled = true;
	const unlock = (): void => {
		audio();
	};
	for (const type of ["pointerdown", "keydown", "touchstart", "click"] as const) {
		window.addEventListener(type, unlock, { capture: true, passive: true });
	}
	// 从后台回来时补一次（iOS 上上下文常在此时停在 interrupted）
	document.addEventListener("visibilitychange", () => {
		if (!document.hidden) unlock();
	});
}

installUnlock();

type Note = {
	type: OscillatorType;
	freq: number;
	/** 相对这一段开始后多少秒起音 */
	start: number;
	dur: number;
	/** 峰值音量 0–1（再乘总音量） */
	peak: number;
};

/** 一声轻「嗒」—— 开始 */
const START: Note[] = [{ type: "triangle", freq: 660, start: 0, dur: 0.08, peak: 0.22 }];
/** 两个下行的柔和音 —— 干完了 */
const DONE: Note[] = [
	{ type: "sine", freq: 880, start: 0, dur: 0.15, peak: 0.35 },
	{ type: "sine", freq: 587.33, start: 0.15, dur: 0.32, peak: 0.35 },
];
/** 两声低闷的方波 —— 出错了 */
const ERROR: Note[] = [
	{ type: "square", freq: 220, start: 0, dur: 0.16, peak: 0.18 },
	{ type: "square", freq: 174.61, start: 0.18, dur: 0.26, peak: 0.18 },
];
/** 三声门铃 —— 等你批准 */
const APPROVAL: Note[] = [
	{ type: "sine", freq: 659.25, start: 0, dur: 0.11, peak: 0.45 },
	{ type: "sine", freq: 659.25, start: 0.14, dur: 0.11, peak: 0.45 },
	{ type: "sine", freq: 880, start: 0.28, dur: 0.26, peak: 0.5 },
];

const PATTERNS: Record<SoundKind, Note[]> = { start: START, done: DONE, error: ERROR, approval: APPROVAL };

function tone(context: AudioContext, note: Note, volume: number): void {
	const osc = context.createOscillator();
	const gain = context.createGain();
	osc.type = note.type;
	osc.frequency.value = note.freq;
	const at = context.currentTime + note.start;
	const peak = Math.max(0.0001, note.peak * volume);
	// 起音/收尾都用指数包络：线性斜坡会有「咔」声
	gain.gain.setValueAtTime(0.0001, at);
	gain.gain.exponentialRampToValueAtTime(peak, at + 0.012);
	gain.gain.exponentialRampToValueAtTime(0.0001, at + note.dur);
	osc.connect(gain);
	gain.connect(context.destination);
	osc.start(at);
	osc.stop(at + note.dur + 0.05);
}

/** 把一段音真正排进上下文 */
function render(context: AudioContext, kind: SoundKind, volume: number): void {
	for (const note of PATTERNS[kind]) tone(context, note, volume);
}

/**
 * resume 补响的宽容窗口：超过它就不要放了。
 * 用户十秒后才点了一下页面，这时再响一声「完成」只会让人以为又完成了一轮。
 */
const LATE_RESUME_MS = 1500;

/** 响一声（按当前设置判断该不该响；响不了就静默，绝不报错） */
export function playSound(kind: SoundKind, settings: SoundSettings = loadSoundSettings()): void {
	if (!settings.enabled || !settings[kind]) return;
	const context = audio();
	if (!context) return;
	const volume = Math.max(0, Math.min(1, settings.volume / 100));
	if (isRunning(context)) {
		render(context, kind, volume);
		return;
	}
	// 还被浏览器锁着（自动触发时没有手势）：跟着这次 resume 走一趟，只在很短的时间内补响，
	// 真正的长效修法是 installUnlock 在手势里先把上下文叫醒。
	const requestedAt = Date.now();
	void context
		.resume()
		.then(() => {
			if (Date.now() - requestedAt > LATE_RESUME_MS) return;
			if (isRunning(context)) render(context, kind, volume);
		})
		.catch(() => {
			// 被策略拦住是常态，静默
		});
}
