/**
 * 语音输入：按钮 → 开始听 → 说的话**实时写进输入框** → 静音 2.2s 自动发送（发出前不再留撤销窗口）。
 *
 * 为什么做成模块级状态 + 一个「桥」：
 *   - 浮条挂在 `App.tsx`，而草稿 / 光标 / 发送只有 `Composer` 知道；
 *   - 两边谁都不该 import 对方，所以浮条只调 `toggleVoiceInput()`，
 *     `Composer` 在挂载时把自己的「插字 / 收尾 / 发送」三个动作注册进来（`bindVoiceBridge`）。
 *   这和 `speech-control.ts` 接「朗读」是同一套做法。
 *
 * 三个阶段（静音判定只能自己数：Web Speech 没有「用户说完了」这个事件）：
 *
 *   listening ──静音 2.2s 且草稿里有字──▶ 直接发送（本地引擎先 flush 拿到最后半句）
 *        ▲                                     │
 *        └──── 又说话了 / 点了撤销 ────────────┘  到点 → 交给 Composer 发送
 *
 * 关掉「说完自动发送」（设置 → 声音与语音）就永远停在 listening，等用户按回车。
 */
import { useSyncExternalStore } from "react";
import { readLanguage } from "./language.ts";
import { isReading, isSpeechPausedNow, setSpeechPaused } from "./speech-control.ts";
import { currentSpokenText } from "./tts.ts";
import {
	startSpeechInput,
	speechInputSupported,
	type SpeechInputErrorKind,
	type SpeechSession,
} from "./speech-input.ts";
import { startLocalSpeechInput } from "./speech-input-local.ts";
import { clampIdleStopSec, clampSilenceMs, ringChanged, silenceRatio } from "./silence-ring.ts";
import { looksUnfinished } from "./sentence-complete.ts";
import { fetchVoiceSettings, pushVoiceSettings, sameSettings } from "./voice-settings-sync.ts";
import { normalizeVoiceSettings } from "./voice-settings-shape.ts";

import { shouldResumeListening } from "./continuous-listen.ts";
import { textSummary, voiceLog } from "./voice-log.ts";
import { showToast } from "./toast.ts";
import { readStored, writeStored } from "./ui-prefs.ts";
import { tNow } from "./use-language.ts";

/* ---------------- 设置（设置 → 声音与语音 → 语音输入） ---------------- */

export type VoiceInputSettings = {
	/** 说完（静音 2.2s）自动发送；关掉就只写进草稿，等用户按回车 */
	autoSend: boolean;
	/**
	 * 说完时回合还在跑，这句话怎么发：
	 *   - `queue`：排队，等这一轮结束再发（默认，跟原来一样）；
	 *   - `steer`：插队（打断当前这一轮、按新指令继续）。引擎不支持时会自动退回排队。
	 */
	submitMode: "queue" | "steer";
	/**
	 * 用哪套识别：
	 *   - `auto`：优先本地（离线、带标点；Chrome 的识别要连 Google，这网络连不上）；
	 *     本地不可用（没编译 / 起不来）时自动退回 Chrome；
	 *   - `browser`：Chrome 原生 Web Speech（实时性最好，但必须能连 Google）；
	 *   - `local`：只用 macOS 原生离线识别（首次要授权一次）；
	 *   - `cloud`：只用服务端转发给厂商 API 的云端识别（DeepSeek / 千问 / 豆包，
	 *     密钥在 `~/.oh-my-agent-web/stt.json`）。它和本地一样走 `/api/asr/*`，
	 *     但不依赖本机的 Agent Computer —— 别的机器（Windows / Linux）也能用。
	 */
	engine: "auto" | "browser" | "local" | "cloud";
	/**
	 * 静音多久算「说完了」（毫秒）。设置里按秒调（0.6–10s），这里存毫秒。
	 * 说话快、句子长的人调大一点，就不会被句中停顿切断。
	 */
	silenceMs: number;
	/**
	 * 你安静多久之后朗读继续念（毫秒）。
	 *
	 * 为什么不跟 `silenceMs` 共用一个值：发送要快（说完 2 秒就发），朗读恢复要慢
	 * （你一换气它就插嘴很难受）。用户 2026-11-21 明确要这两个分开。
	 */
	readingResumeMs: number;
	/** 界面上是否显示朗读控制条（暂停 / 停止）；关掉只用快捷键控制 */
	showReadingDock: boolean;
	/**
	 * 连续听写：发完一句自动重新开麦，不用每次点浮条。
	 *
	 * 代价要说清楚（设置面板里也写了）：麦克风会一直占用（系统指示灯常亮），
	 * 本地识别会持续跑；用户手动停 / 撤销 之后不会自己恢复，需要再点一次。
	 */
	continuous: boolean;
	/**
	 * 空闲多久自动关麦（秒），0 = 不关。
	 *
	 * 为什么需要：连续听写会让麦克风一直占着，而「说话时不朗读」又会让自动播报静音，
	 * 结果就是「一直不说话，朗读也一直不响」。到点关麦 = 把麦克风与朗读解耦。
	 */
	idleStopSec: number;
	/**
	 * 近讲灵敏度（dB）：只有比「最近 3 秒最安静的那一帧」高出这么多，才算你在说话。
	 * 用来挡掉坐旁边的同事。**0 = 关闭**（连 AGC 一起放开，回到旧行为）。
	 */
	nearTalkDb: number;
};

export const VOICE_INPUT_SETTINGS_KEY = "agent-web.voice.input";
/**
 * 静音多久算「说完了」。
 *
 * 历史：1.2 秒太短（连着几条消息被切成「两个」「将」这种两三个字），试过 2.2 秒、4 秒
 * —— 4 秒等得太久（用户 2026-11-21：「4 秒太长了，改成 3 秒」），现在默认 **3 秒**：
 * 能盖住句中换气，又不至于说完以后干等。可在设置里按秒调（0.6–10s）。
 */
export const VOICE_SILENCE_MS = 2000;
/** 静音检测的节拍：Web Speech 不提供「音量」事件，只能自己数「最后一次出字是什么时候」 */
const SILENCE_TICK_MS = 200;

const DEFAULT_SETTINGS: VoiceInputSettings = {
	autoSend: true,
	submitMode: "queue",
	/**
	 * 默认 `auto`（先试本地、不行才退 Chrome）。
	 *
	 * 浏览器里没有本机 helper，钉死成 local 就是彻底不能用；Chrome 自己的 Web Speech
	 * 在浏览器里是能用的，所以交给 `auto` 自己选。
	 */
	engine: "auto",
	continuous: false,
	// 0 = 不自动关麦：用户明确要求「麦克风一直开着」
	idleStopSec: 0,
	/** 默认 12dB：实测能挡住 1 米外的正常交谈，又不会误杀自己说话 */
	nearTalkDb: 12,
	silenceMs: VOICE_SILENCE_MS,
	readingResumeMs: 4000,
	showReadingDock: true,
};

/** 近讲灵敏度只收 0~30dB：存坏了或越界都拉回合法区间，不然门限可能永远关不上或永远开不了 */
function clampNearTalkDb(value: unknown): number {
	const num = typeof value === "number" && Number.isFinite(value) ? value : DEFAULT_SETTINGS.nearTalkDb;
	return Math.max(0, Math.min(30, Math.round(num)));
}

const settingsListeners = new Set<() => void>();

function readSettings(): VoiceInputSettings {
	const raw = readStored(VOICE_INPUT_SETTINGS_KEY);
	if (!raw) return { ...DEFAULT_SETTINGS };
	try {
		const parsed = JSON.parse(raw) as Partial<VoiceInputSettings>;
		return {
			autoSend: parsed.autoSend !== false,
			continuous: parsed.continuous === true,
			idleStopSec: clampIdleStopSec(parsed.idleStopSec),
			// 只认这几个值；存坏了就回落默认，别让一个手改的字符串把「发送」弄成无动作
			submitMode: parsed.submitMode === "steer" ? "steer" : "queue",
			engine:
				parsed.engine === "browser" || parsed.engine === "local" || parsed.engine === "cloud"
					? parsed.engine
					: "auto",
			nearTalkDb: clampNearTalkDb(parsed.nearTalkDb),
			silenceMs: clampSilenceMs(parsed.silenceMs === undefined ? undefined : parsed.silenceMs / 1000, VOICE_SILENCE_MS),
			readingResumeMs: clampSilenceMs(
				parsed.readingResumeMs === undefined ? undefined : parsed.readingResumeMs / 1000,
				4000,
			),
			showReadingDock: parsed.showReadingDock !== false,
		};
	} catch {
		return { ...DEFAULT_SETTINGS };
	}
}

let settings: VoiceInputSettings = readSettings();

/**
 * 这台机器上「本地识别确认用不了」（服务端说 `missing`：没编译 / 平台不对）。
 *
 * 为什么要记一笔（用户 2026-11-21：「安装完默认就用开箱即用的那种」）：
 * `auto` 以前每次都先试本地、失败了再弹一句「本地不可用，已改用 Chrome」——
 * 对一台本来就没有本地引擎的机器（Linux / Windows / 没跑 build.sh 的 mac）来说，
 * 这句提示每次开麦都会刷一遍，而且白等一轮。确认过一次就记下来，之后**直接用 Chrome**，
 * 不弹提示（设置 → 本地识别 那一行还会明写“找不到本地识别程序”，想修的人仍然看得到）。
 */
let localUnusable = false;

/**
 * 装好本地识别之后把「这台机器没有本地识别」这条记忆清掉。
 *
 * 不清的话：用户点了安装、也看见「已就绪」，但只要不刷新页面，`auto` 仍会一直走 Chrome
 * —— 因为 `localUnusable` 是开机探测时写下的模块级状态。
 */
export function forgetLocalUnavailable(): void {
	localUnusable = false;
}

/**
 * 这一次开麦该走哪套引擎（纯函数，测试直接调）。
 *
 * - `browser`：用户明确要 Chrome；
 * - `local`：用户明确要本地 —— 就算是坏的也按本地跑，报错让他看见（不悄悄换）；
 * - `cloud`：用户明确要云端（服务端用厂商 API）—— 同样走「本地那条」HTTP 链路
 *   （`/api/asr/*` 由服务端转发），**绝不回退到 Chrome**：那样会静默换供应商、还要连 Google；
 * - `auto`：本地能用就本地（离线、带标点），**确认用不了就直接 Chrome**，不先试一遍。
 */
export function engineToStart(engine: VoiceInputSettings["engine"], localMissing: boolean): "local" | "browser" {
	if (engine === "browser") return "browser";
	if (engine === "local" || engine === "cloud") return "local";
	return localMissing ? "browser" : "local";
}

/**
 * 开机问一次「这台机器到底有没有本地识别」：只读 `/api/asr/status`（**不带** `?start=1`，
 * 不会拉起进程、不会弹系统授权）。回答 `missing` 就把 `localUnusable` 记上，
 * 这样连**第一次**点麦克风都已经走 Chrome —— 开箱即用，不用先撞一次墙。
 */
async function probeLocalAvailability(): Promise<void> {
	if (typeof window === "undefined" || typeof fetch !== "function") return;
	try {
		const response = await fetch("/api/asr/status");
		if (!response.ok) return;
		const status = (await response.json()) as { state?: string };
		// **双向**：只有明确的 missing 才算「这条路不存在」；idle / starting / ready / error
		// 都说明本地这层是活的（error 会在 onError 里退回 Chrome）。以前只往 true 写，
		// 于是用户后来装好、打开了 helper，这个页面还是永远走 Chrome。
		localUnusable = status?.state === "missing";
	} catch {
		// 服务端一时答不上来：保持原判断，别把「问不到」当成「不可用」
	}
}
void probeLocalAvailability();

/**
 * 本地保存的序号。用于解决一个真实存在的竞态：
 * 页面刚打开、服务端那份还没拉回来时，用户一动设置就会把**本地旧值**推上去，
 * 把别的设备（或上一次）设好的值覆盖掉。所以在同步返回时检查「期间有没有本地保存」，
 * 有就放弃采用服务端的值（以用户刚才的手动修改为准）。
 */
let saveSeq = 0;

/**
 * 启动时与宿主对齐一次（异步，不阻塞界面）。
 *
 * 宿主的文件存在 → 以它为准（这就是「手机电脑共用一套」）；文件还不存在（首次升级到带同步的版本）
 * → 把本地这份推上去当基线，别让老用户白丢设置。
 */
void (async () => {
	const seqAtStart = saveSeq;
	const remote = await fetchVoiceSettings();
	if (remote === null) return;
	// 拉取期间用户手动改过设置：他的手一动比远端旧值更该被保留
	if (saveSeq !== seqAtStart) return;
	if (!remote.stored) {
		pushVoiceSettings(settings);
		return;
	}
	const merged = normalizeVoiceSettings(remote.settings);
	if (sameSettings(merged, settings)) return;
	settings = merged;
	writeStored(VOICE_INPUT_SETTINGS_KEY, JSON.stringify(settings));
	voiceLog("settings:from-server", { silenceMs: settings.silenceMs, nearTalkDb: settings.nearTalkDb });
	for (const listener of settingsListeners) listener();
})();

export function loadVoiceInputSettings(): VoiceInputSettings {
	return settings;
}

export function saveVoiceInputSettings(next: VoiceInputSettings): void {
	saveSeq += 1;
	const previous = settings;
	settings = {
		autoSend: next.autoSend,
		continuous: next.continuous === true,
		idleStopSec: clampIdleStopSec(next.idleStopSec),
		submitMode: next.submitMode === "steer" ? "steer" : "queue",
		engine: next.engine === "browser" || next.engine === "local" || next.engine === "cloud" ? next.engine : "auto",
		nearTalkDb: clampNearTalkDb(next.nearTalkDb),
		silenceMs: clampSilenceMs(next.silenceMs / 1000, VOICE_SILENCE_MS),
		readingResumeMs: clampSilenceMs(next.readingResumeMs / 1000, 4000),
		showReadingDock: next.showReadingDock !== false,
	};
	writeStored(VOICE_INPUT_SETTINGS_KEY, JSON.stringify(settings));
	// 宿主那份跟着更新：手机上改完，电脑下次打开就是这一套
	pushVoiceSettings(settings);
	for (const listener of settingsListeners) listener();
	/**
	 * 采音参数（近讲门限）是在**开会话那一刻**交给 `getUserMedia` / 门限逻辑的，
	 * 中途改设置对当前这次听写没有任何影响 —— 用户拖完滑块发现「没啥效果」正是这个。
	 * 所以在听的时候改了这一项，就地重开一次本地会话（文字留在草稿里）。
	 */
	if (previous.nearTalkDb !== settings.nearTalkDb && status === "listening" && activeEngine === "local") {
		voiceLog("restart:gate", { from: previous.nearTalkDb, to: settings.nearTalkDb });
		// 不传 base：Composer 那边的 `onStart` 会用它自己最新的草稿兜底
		reanchorVoiceInput();
	}
}

export function useVoiceInputSettings(): VoiceInputSettings {
	return useSyncExternalStore(
		(listener) => {
			settingsListeners.add(listener);
			return () => settingsListeners.delete(listener);
		},
		loadVoiceInputSettings,
		loadVoiceInputSettings,
	);
}

/* ---------------- 与输入框之间的桥 ---------------- */

/** `Composer` 注册进来的三个动作（只对主输入框生效，临时聊天不接） */
export type VoiceBridge = {
	/**
	 * 桥现在挂在哪条会话上（Composer 用 getter 读，切会话不需要重新注册）。
	 *
	 * 语音听写是**模块级单例**，而草稿 / 光标锚点是**每条会话一份**：听写期间切了会话，
	 * 字就绝不能再往新会话里写 —— 否则就是用户报的「语音串会话」。
	 */
	conversationId: string | null;
	/** 开始听：调用方记下「光标前后的文本」当锚点（`base` = 调用方手里最新那版草稿） */
	onStart: (base?: string) => void;
	/** 这一轮语音到目前为止的整段文字（中间结果也在内，**整段替换**） */
	onText: (text: string) => void;
	/** 听写结束 / 中止：锚点作废，文字留在草稿里 */
	onEnd: () => void;
	/** 自动发送：和用户按回车走同一套落点（`submitMode` 决定跑着的回合是排队还是插队） */
	submitVoice: () => void;
};

let bridge: VoiceBridge | null = null;

/**
 * 这次听写是**在哪条会话里**开始的（`null` = 新会话那一屏）。
 *
 * 只记 id 不够用 `bridge.conversationId` 判等：Composer 那边是用 getter 读当前会话的，
 * 所以用户切会话时这个字段会立刻变，而 `owner` 还停在开始听写的那一条。
 */
let owner: string | null = null;

/* ---------------- 状态 ---------------- */

export type VoiceInputStatus = "idle" | "listening" | "sending";

let status: VoiceInputStatus = "idle";
/** 用户主动点停（而不是浏览器因为安静自己收摊） */
let manualStop = false;
/** 我们自己 abort 掉的会话，它的 `onend` 不该触发自愈重启 */
let ignoreEnd = false;
/** 已经说完、并被"提交"进草稿的部分（浏览器自动收摊后接着听时用） */
let committed = "";
/** 当前这次识别会话到目前为止的文本 */
let current = "";
/** 最后一次「出字」的时间：静音计时从这里算 */
let lastSpokeAt = 0;
let session: SpeechSession | null = null;
/** 这一句用的是哪套引擎（开始时就定下来，中途不改） */
let activeEngine: "browser" | "local" = "browser";
/** 本地引擎收尾中：这期间到的 partial 不该把倒计时取消掉 */
let flushing = false;
/** 「静音了但没进倒计时」那条日志上次写的时间（限流用） */
let lastBlockedLogAt = 0;
/** 静音等待的进度 0–1（浮条那圈环）；说话就回 0 */
let silenceProgress = 0;
/** 开麦时是不是**我们**把朗读暂停了（只恢复我们暂停的那次，不碰用户自己点的暂停） */
let pausedReadingForDictation = false;
/** 「句子没说完所以先不发」这条日志每次听写只写一次（200ms 一拍，不节流会刷满） */
let heldUnfinishedLogged = false;
/** 用户主动停过：连续听写不要在背后又开麦（他自己会再点） */
let manualPause = false;
/** 连续出错次数：成功出过字就清零，到上限就别再自动重开 */
let errorStreak = 0; /** 续听计时器（发完一句后等一小会儿再开，别和发送竞态） */
let resumeTimer: number | null = null;
/** 发完到重新开麦之间的间隔：给发送 / 界面留一拍 */
const CONTINUOUS_RESUME_MS = 800;
/** 连续出错几次就停下来（桥没起来 / 权限被撤时不要无限重开） */
const MAX_ERROR_STREAK = 2;
/** auto 模式下「本地不可用 → 退回 Chrome」只提示一次：每次点都弹就成了噪声 */
let autoFallbackNotified = false;
let silenceTicker: number | null = null;
let countdownTimer: number | null = null;

/**
 * 自愈重启的刹车：Chrome 在某些状态下会「一开就 end」（比如麦克风被别的程序占着），
 * 不封顶的话 `onEnd → boot → onEnd` 就是一个热循环，界面看着像卡死。
 */
let autoRestarts = 0;
let lastRestartAt = 0;
const MAX_AUTO_RESTARTS = 8;
const AUTO_RESTART_WINDOW_MS = 2000;

const listeners = new Set<() => void>();

function setStatus(next: VoiceInputStatus): void {
	if (status === next) return;
	// 状态迁移是排查的骨架：任何一次「该发没发」先看这一步有没有走对
	voiceLog("status", { from: status, to: next, engine: activeEngine });
	status = next;
	// 一离开「在听」，环就该归零：否则点到停 / 进撤销窗口后还挂着一个半满的进度
	if (next !== "listening") setSilenceProgress(0);
	/**
	 * 你说话时朗读暂停、不说了再继续（见 `pauseReadingWhileSpeaking`）。
	 * 离开听写时解除；如果开麦那一下是**我们**暂停的朗读，这时给恢复回去 ——
	 * 用户说的是「我讲话时你可以暂停」，不是「说完也别念了」。
	 */

	for (const listener of listeners) listener();
}

/**
 * 更新环的进度。
 *
 * 只在真的变了才通知：静音计时器 200ms 一拍，直接每次重渲染整个输入区没必要。
 */
function setSilenceProgress(next: number): void {
	if (!ringChanged(silenceProgress, next)) return;
	silenceProgress = next;
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

export function voiceInputStatus(): VoiceInputStatus {
	return status;
}

/** 界面用：`idle` / `listening`（在听）/ `sending`（倒计时，还能撤销） */
export function useVoiceInputStatus(): VoiceInputStatus {
	return useSyncExternalStore(subscribe, voiceInputStatus, voiceInputStatus);
}

/** 静音等待的进度（0–1）：浮条拿它画环，填满就进撤销窗口 */
export function voiceSilenceRatio(): number {
	return silenceProgress;
}

/** 界面用：见 `voiceSilenceRatio` */
export function useVoiceSilenceRatio(): number {
	return useSyncExternalStore(subscribe, voiceSilenceRatio, voiceSilenceRatio);
}

/** 听写中（不含倒计时）：`Composer` 用它决定「回车前先收尾语音」「打字要重新定锚」 */
export function isVoiceListening(): boolean {
	return status === "listening";
}

/** `Composer` 挂载时注册；卸载 / 换成临时聊天时传 null */
export function bindVoiceBridge(next: VoiceBridge | null): void {
	bridge = next;
}

/**
 * 桥还属于这次听写的那条会话吗？
 *
 * 为什么必须判：浮条挂在 `App`、草稿挂在 `Composer`，两边都是**单例**，
 * 但草稿内容和光标锚点是**每条会话一份**的。用户听写中途点了侧栏另一条会话时，
 * 输入框本身不卸载、桥也不重建 —— 于是下一个中间结果会拿上一条会话的锚点
 * 整段替换掉新会话的草稿，静音到点还会替他发给新会话。这就是「语音串会话」。
 */
function bridgeStillOwner(): boolean {
	return bridge !== null && (bridge.conversationId ?? null) === owner;
}

/**
 * 会话已经被切走：就地收摊。
 *
 * 三件不做的事：**不提交**（那句话不属于这条会话）、**不续听**（连续听写也不能跟过去）、
 * **不搬字**（已经写进上一条会话草稿的内容由 `handoffDraft` 存回它自己那一格，不会丢）。
 */
function abandonForSwitch(): void {
	voiceLog("abandon:conversation-switched", { owner, current: bridge?.conversationId ?? null });
	manualPause = true;
	clearResumeTimer();
	closeSession();
	setStatus("idle");
	bridge?.onEnd();
}

/* ---------------- 文本拼接 ---------------- */

/**
 * 把两段识别文本接起来。
 *
 * Web Speech 的分段不一定带空格（英文有时就少一个），而中文之间**不能**加空格。
 * 所以：两边只要有一边是中文，就直接接；否则补一个空格。
 */
function joinSpeech(base: string, chunk: string): string {
	const left = base.trimEnd();
	const right = chunk.trimStart();
	if (!left) return right;
	if (!right) return left;
	const touchesCjk = /[\u3400-\u9fff\u3000-\u303f\uff00-\uffef]$/.test(left) || /^[\u3400-\u9fff]/.test(right);
	return touchesCjk ? `${left}${right}` : `${left} ${right}`;
}

function messageOf(kind: SpeechInputErrorKind, detail?: string): string {
	if (kind === "local") return detail ?? tNow("本地识别还没就绪", "Local recognition isn't ready yet");
	switch (kind) {
		case "unsupported":
			return tNow(
				"这台浏览器用不了语音输入：Firefox 没有这个能力；手机通过局域网 http 打开时也没有麦克风（需要 localhost 或 HTTPS）",
				"Voice input is unavailable here: Firefox has no support, and a phone opening this over plain LAN http has no microphone (localhost or HTTPS is required)",
			);
		case "denied":
			return tNow(
				"麦克风被拒绝了：点地址栏左边的权限图标，允许麦克风后再点一次",
				"Microphone permission was denied: allow it from the icon next to the address bar, then try again",
			);
		case "network":
			return tNow(
				"Chrome 的语音识别要把声音传到 Google 的服务器，这个网络连不上（实测 speech.googleapis.com 超时）。要么让代理覆盖浏览器，要么改用离线识别（目前还没装）",
				"Chrome's speech recognition uploads audio to Google, which is unreachable on this network (speech.googleapis.com times out). Either route the browser through a proxy, or switch to offline recognition (not installed yet)",
			);
		default:
			return tNow("语音输入出错了，再点一次试试", "Voice input failed — try tapping again");
	}
}

/* ---------------- 静音判定 / 倒计时 ---------------- */

function stopTimers(): void {
	if (silenceTicker !== null) {
		window.clearInterval(silenceTicker);
		silenceTicker = null;
	}
	if (countdownTimer !== null) {
		window.clearTimeout(countdownTimer);
		countdownTimer = null;
	}
}

function startSilenceWatch(): void {
	if (silenceTicker !== null) return;
	silenceTicker = window.setInterval(() => {
		// 三种「不该进度」的情况一律归零：没在听、关了自动发送、草稿里还没有字
		const armed = status === "listening" && settings.autoSend && joinSpeech(committed, current).trim() !== "";
		if (!armed) {
			setSilenceProgress(0);
			return;
		}
		const idleMs = Date.now() - lastSpokeAt;
		// 不说话超过一小会儿：把刚才因为说话暂停的朗读接上
		if (pausedReadingForDictation && idleMs >= resumeReadingAfterMs() && !flushing) {
			pausedReadingForDictation = false;
			if (isSpeechPausedNow()) {
				voiceLog("read:resume", { idleMs });
				setSpeechPaused(false);
			}
		}
		// 空闲太久：把麦克风关掉（idleStopSec = 0 时不会发生）
		if (settings.idleStopSec > 0 && idleMs >= settings.idleStopSec * 1000) {
			voiceLog("idle:stop", { idleMs, idleStopSec: settings.idleStopSec });
			stopVoiceInput();
			return;
		}
		/**
		 * 句子没说完就先别发：结尾还是逗号/顿号/冒号这类「话没落地」的标点时，继续等。
		 * 静音阈值只能表达「停了多久」，表达不了「有没有讲完」—— 半句被切断大多栽在这。
		 */
		if (looksUnfinished(joinSpeech(committed, current))) {
			if (!heldUnfinishedLogged) {
				heldUnfinishedLogged = true;
				voiceLog("countdown:hold", { reason: "unfinished", ...textSummary(joinSpeech(committed, current)) });
			}
			setSilenceProgress(1);
			return;
		}
		const ratio = silenceRatio(idleMs, settings.silenceMs);
		if (ratio >= 1) {
			setSilenceProgress(1);
			beginCountdown();
			return;
		}
		setSilenceProgress(ratio);
	}, SILENCE_TICK_MS);
}

function beginCountdown(): void {
	if (countdownTimer !== null || flushing) {
		// 被拦住说明「静音了但没进倒计时」：这种只在状态真的卡住时才有意义，
		// 所以按 2 秒限流记一笔，别让每次 200ms 检查都写一行
		if (Date.now() - lastBlockedLogAt >= 2000) {
			lastBlockedLogAt = Date.now();
			voiceLog("countdown:blocked", { counting: countdownTimer !== null, flushing, status });
		}
		return;
	}
	voiceLog("countdown:start", { engine: activeEngine, ...textSummary(joinSpeech(committed, current)) });
	setStatus("sending");
	const flush = session?.flush;
	if (!flush) {
		submitFromVoice();
		return;
	}
	// 本地引擎：静音只说明「你停了」，最后半句还在浏览器里没转 —— 先 flush 拿到 final，
	// 再开始那 0.6 秒的反悔窗口（否则发出去的是缺尾巴的半句）。
	flushing = true;
	const flushStartedAt = Date.now();
	voiceLog("flush:start", { engine: activeEngine });
	void flush()
		.catch((error: unknown) => {
			voiceLog("flush:error", { ms: Date.now() - flushStartedAt, error: String(error).slice(0, 120) });
			return "";
		})
		.finally(() => {
			flushing = false;
			voiceLog("flush:done", { ms: Date.now() - flushStartedAt, ...textSummary(current), status });
			if (status !== "sending") return; // 期间被点停
			submitFromVoice();
		});
}

/** 倒计时结束：把这段话交给输入框发出去 */
function submitFromVoice(): void {
	// 中途切了会话：这句话属于上一条会话，绝不能替用户发给现在这条
	if (!bridgeStillOwner()) {
		abandonForSwitch();
		return;
	}
	voiceLog("submit", { engine: activeEngine, ...textSummary(joinSpeech(committed, current)) });
	closeSession();
	setStatus("idle");
	bridge?.onEnd();
	bridge?.submitVoice();
	// 连续听写：发完接着听下一句（用户自己停过 / 出错太多次时不续，见 continuous-listen.ts）
	scheduleContinuousResume();
}

/**
 * 你说话 → 朗读暂停；停下来（静音）→ 朗读继续。
 *
 * 用户 2026-11-21：「把朗读给我暂停就好了，当我不说话时候你再继续读」。
 * 语义上是**暂停**而不是取消：不丢句子、不跳段，恢复后从停住的那句接着念。
 * 这里只负责暂停；继续由静音计时器判断（见 `RESUME_READING_AFTER_MS`）。
 */
/**
 * 朗读正在念的时候，识别结果如果属于「它正在念的那段」，那是外放的回声，不是你说的 ——
 * 既不能写进草稿（会变成一条莫名其妙的消息），也不该拿来当「你在说话」的依据。
 */
/** 太短的识别结果不当回声：几个字碰巧出现在朗读文本里是常事，「为什么」「等一下」都可能命中 */
const MIN_ECHO_CHARS = 10;

function dropEcho(text: string): boolean {
	if (!isReading()) return false;
	const spoken = currentSpokenText().replace(/\s+/g, "");
	const heard = text.replace(/\s+/g, "");
	if (!spoken || !heard) return false;
	/**
	 * 只把「够长、且整段落在朗读文本里」的识别结果当回声。
	 * 以前还判了 `heard.includes(spoken前16字)`，两个方向都会误杀 —— 用户说几个字（甚至"为什么"），
	 * 只要碰巧是朗读文本的一部分就被丢掉，表现就是「它念的时候我说话没反应」。
	 */
	if (heard.length < MIN_ECHO_CHARS) return false;
	const isEcho = spoken.includes(heard);
	if (isEcho) voiceLog("echo:drop", { heardLen: heard.length, spokenLen: spoken.length });
	return isEcho;
}

function pauseReadingWhileSpeaking(): void {
	if (!isReading() || isSpeechPausedNow()) return;
	/**
	 * 防回环：麦克风可能把朗读自己的声音收进去（尤其外放）。识别结果如果是「它正在念的那段」
	 * 的一部分，那显然不是你说的 —— 不暂停，否则会「暂停→继续→又暂停」地抖。
	 */
	const spoken = currentSpokenText().replace(/\s+/g, "");
	const heard = joinSpeech(committed, current).replace(/\s+/g, "");
	if (spoken && heard && (spoken.includes(heard) || heard.includes(spoken.slice(0, Math.min(12, spoken.length))))) {
		return;
	}
	voiceLog("read:pause", {});
	pausedReadingForDictation = true;
	setSpeechPaused(true);
}

/**
 * 静音多久之后恢复朗读。
 *
 * 用同一个「说完」阈值（设置里的「等多久发送」）：你只要还在说（中间带停顿），朗读就一直闭嘴；
 * 真不说了才算说完。以前是固定的 0.7 秒，你句中一换气它就又插嘴，听感上像"没被打断"。
 */
function resumeReadingAfterMs(): number {
	return settings.readingResumeMs;
}

/** 取消待续听（手动停 / 撤销 / 整段收摊时都要清，否则停完它又自己开麦） */
function clearResumeTimer(): void {
	if (resumeTimer === null) return;
	window.clearTimeout(resumeTimer);
	resumeTimer = null;
}

/**
 * 排一次「发完自动继续听」。
 *
 * 用计时器而不是立刻开：这一刻消息刚交给输入框，立刻开麦容易把这句的尾巴又转一遍，
 * 也和发送 / 清草稿抢同一帧。
 */
function scheduleContinuousResume(): void {
	if (resumeTimer !== null) return;
	if (!settings.continuous) return;
	resumeTimer = window.setTimeout(() => {
		resumeTimer = null;
		/**
		 * 这里**不再**因为「正在朗读」而推迟开麦。
		 *
		 * 以前推迟是为了别把朗读静音；但麦克风开着也不影响朗读了（回声由 `dropEcho` 过滤），
		 * 推迟的唯一效果就是「发完消息麦克风被关掉」—— 用户 2026-11-21 反复报的就是这个。
		 * 所以：发送后照常把麦开回来，朗读爱念就念。
		 */
		const allowed = shouldResumeListening({
			continuous: settings.continuous,
			manualPause,
			status,
			hidden: document.visibilityState === "hidden",
			errorStreak,
			maxErrorStreak: MAX_ERROR_STREAK,
		});
		if (!allowed) {
			voiceLog("continuous:skip", {
				manualPause,
				status,
				hidden: document.visibilityState === "hidden",
				errorStreak,
			});
			return;
		}
		voiceLog("continuous:resume", { engine: settings.engine });
		void startVoiceInput();
	}, CONTINUOUS_RESUME_MS);
}

/**
 * 收掉识别会话（不碰 `status`：调用方决定回到 listening 还是 idle）。
 * 文字已经写进草稿了，这里**不还原**用户看到的字。
 */
function closeSession(): void {
	const active = session;
	session = null;
	manualStop = true;
	ignoreEnd = true;
	active?.stop();
	committed = "";
	current = "";
	stopTimers();
}

/* ---------------- 开 / 停 ---------------- */

/** 开一次 Chrome 原生识别会话（它安静一会儿会自己收摊，那时会再开一次） */
function bootBrowser(): void {
	lastSpokeAt = Date.now();
	const lang = readLanguage() === "en" ? "en-US" : "zh-CN";
	const started = startSpeechInput({
		lang,
		onText: (text) => {
			if (!bridgeStillOwner()) {
				abandonForSwitch();
				return;
			}
			lastSpokeAt = Date.now();
			const changed = text !== current;
			current = text;
			if (changed) errorStreak = 0;
			voiceLog("text:legacy", { changed, ...textSummary(joinSpeech(committed, text)) });
			if (changed) {
				heldUnfinishedLogged = false;
				pauseReadingWhileSpeaking();
			}
			bridge?.onText(joinSpeech(committed, text));
			// 倒计时期间又说话了：那是「还没说完」，撤掉这一次倒计时
			if (changed && status === "sending") {
				if (countdownTimer !== null) window.clearTimeout(countdownTimer);
				countdownTimer = null;
				setStatus("listening");
			}
		},
		onError: (kind) => {
			// 安静了一会儿不算错：`onend` 会自己收摊，然后我们接着听
			if (kind === "no-speech") return;
			errorStreak += 1;
			voiceLog("error", { engine: "browser", kind, errorStreak });
			showToast({ text: messageOf(kind) });
			shutdown();
		},
		onEnd: () => {
			if (ignoreEnd) {
				ignoreEnd = false;
				return;
			}
			if (manualStop) return; // 用户点停：收尾已经在别处做完了
			if (status === "sending") return; // 正在倒计时：别在这时候又开一麦
			// 浏览器因为安静自己结束了，但用户没点停：把这段并进已定稿，接着听。
			// 连续好几次都「很快又结束」= 麦克风拿不到（被占 / 权限刚被撤），别硬撑
			const now = Date.now();
			autoRestarts = now - lastRestartAt < AUTO_RESTART_WINDOW_MS ? autoRestarts + 1 : 1;
			lastRestartAt = now;
			if (autoRestarts > MAX_AUTO_RESTARTS) {
				showToast({
					text: tNow(
						"语音输入总是被立刻中断（麦克风可能被别的程序占着），先停下来，待会儿再试",
						"Voice input keeps ending immediately (the microphone may be in use) — stopping for now",
					),
				});
				shutdown();
				return;
			}
			committed = joinSpeech(committed, current);
			current = "";
			bootBrowser();
		},
	});
	session = started;
}

/**
 * 开本地识别（服务端 → macOS 原生）。
 *
 * 和 Chrome 那套的区别：
 *   - 不会有「浏览器自己收摊再重启」这回事，结束一律由我们（stop / flush）驱动；
 *   - 服务端回的是**累计文本**，所以直接交给桥，不用再和自己拼接；
 *   - `auto` 模式下本地起不来（没编译 / 报错）会退回 Chrome，并提示一次。
 */
function bootLocal(): void {
	session = startLocalSpeechInput({
		// 近讲门限的档位：0 = 关掉（那时候 AGC 也会放开，回到旧行为）
		nearTalkDb: settings.nearTalkDb,
		onText: (text) => {
			if (!bridgeStillOwner()) {
				abandonForSwitch();
				return;
			}
			if (dropEcho(text)) return;
			lastSpokeAt = Date.now();
			const changed = text !== current;
			current = text;
			bridge?.onText(text);
			if (changed) errorStreak = 0;
			voiceLog("text:local", { changed, ...textSummary(text) });
			if (changed) {
				heldUnfinishedLogged = false;
				pauseReadingWhileSpeaking();
			}
			// 倒计时/收尾之外又出字了：说明还没说完，撤掉这次倒计时
			if (changed && status === "sending" && !flushing) {
				voiceLog("countdown:cancel", { reason: "new-text" });
				if (countdownTimer !== null) window.clearTimeout(countdownTimer);
				countdownTimer = null;
				setStatus("listening");
			}
		},
		onError: (kind, detail, state) => {
			if (kind === "no-speech") return;
			errorStreak += 1;
			voiceLog("error", { engine: "local", kind, detail: detail?.slice(0, 120), state, errorStreak });
			shutdown();
			// auto：本地这条路根本没通（没编译 / 进程起不来）→ 退回 Chrome，别让用户卡住
			if (settings.engine === "auto" && (state === "missing" || state === "error")) {
				// 记下来：以后不再先试一遍本地（开箱即用的机器不该每次开麦都听一句报错）
				localUnusable = true;
				if (state === "error" && !autoFallbackNotified) {
					// 只在**真的出过错**时提示；`missing` 是「本来就没装」，属于正常退路，不吵
					autoFallbackNotified = true;
					showToast({
						text: tNow(
							`本地识别不可用（${detail ?? "原因未知"}），已改用 Chrome 识别`,
							`Local recognition is unavailable (${detail ?? "unknown"}), falling back to Chrome`,
						),
					});
				}
				startBrowserInput();
				return;
			}
			showToast({ text: messageOf(kind, detail) });
		},
		onContext: (state) => voiceLog("audio-context", { state }),
		onGating: (info) => voiceLog("gate", info),
		// 朗读外放时门限会把「你说话」当噪声挡掉，所以朗读期间直接放行
		bypassGate: () => isReading(),
		// 桥还在启动（第一次点麦克风几乎必然遇到）：不报错，提示一句「正在启动」就好
		onWaiting: (detail) => voiceLog("asr:waiting", { state: detail }),

		onEnd: () => {
			// 本地引擎的结束由 stopVoiceInput / submitFromVoice 驱动，这里不用做事
		},
	});
}

/** 彻底收摊：状态、累计文本、锚点一起清（出错 / 点停都走这里） */
function shutdown(): void {
	clearResumeTimer();
	const active = session;
	session = null;
	ignoreEnd = true;
	active?.abort();
	committed = "";
	current = "";
	flushing = false;
	stopTimers();
	setStatus("idle");
	owner = null;
	bridge?.onEnd();
}

/** 引擎已经定下来了，开始听（两套引擎共用的收尾准备） */
function beginListening(): void {
	manualStop = false;
	ignoreEnd = false;
	autoRestarts = 0;
	lastRestartAt = 0;
	committed = "";
	current = "";
	// 记下这次听写属于哪条会话：之后每次出字 / 自动发送都要先确认没被切走
	owner = bridge?.conversationId ?? null;
	// 正在朗读的时候开麦，麦克风会把朗读的声音当成"你说的话"：先暂停，并记住是我们暂停的
	if (isReading()) {
		pausedReadingForDictation = true;
		setSpeechPaused(true);
	}
	bridge?.onStart();
	setStatus("listening");
	startSilenceWatch();
	if (activeEngine === "local") bootLocal();
	else bootBrowser();
}

/** 用 Chrome 原生识别（本地不可用时的退路，也是 `engine: "browser"` 的正路） */
function startBrowserInput(): void {
	if (!speechInputSupported()) {
		showToast({ text: messageOf("unsupported") });
		return;
	}
	activeEngine = "browser";
	beginListening();
}

export function startVoiceInput(): void {
	if (status !== "idle") return;
	// 用户自己点的：解除「暂停」，并清掉之前的错误计数
	manualPause = false;
	errorStreak = 0;
	// 本地可用性会变（用户可能刚装好 helper、刚打开它、刚授权），判过不可用就重新问一次。
	// **但绝不能 await**：下面的启动链路必须在同一个用户手势里走到 ensureContext()，
	// 否则 AudioContext 会停在 suspended、ScriptProcessor 永不回调 —— 表现就是
	// 「红点在闪、麦克风在录，但一个字都不出」（这个坑代码里本来就写了注释，我又踩了一次）。
	// 所以这次探测只影响**下一次**开麦，不阻塞本次。
	if (localUnusable) void probeLocalAvailability();
	voiceLog("start", {
		engineSetting: settings.engine,
		autoSend: settings.autoSend,
		submitMode: settings.submitMode,
		silenceMs: settings.silenceMs,
		continuous: settings.continuous,
		secure: typeof window !== "undefined" ? window.isSecureContext : undefined,
	});
	// auto：优先本地（离线、带标点、不依赖 Google）；本地确认用不了就直接 Chrome（开箱即用）
	if (engineToStart(settings.engine, localUnusable) === "browser") {
		startBrowserInput();
		return;
	}
	activeEngine = "local";
	beginListening();
}

export function stopVoiceInput(): void {
	if (status === "idle") return;
	voiceLog("stop", { status, flushing, engine: activeEngine });
	// 手动停 = 明确「别再自己开麦」，连续听写要等用户重新点
	manualPause = true;
	clearResumeTimer();
	// 收尾（本地引擎的 flush）还没回来：这一下不再重复收尾，否则会发两次 /end
	if (flushing) return;
	// 本地引擎：手动停止也要先把最后半句转出来，否则「点了停」会丢字
	if (status === "listening" && session?.flush) {
		flushing = true;
		void session
			.flush()
			.catch(() => "")
			.finally(() => {
				flushing = false;
				closeSession();
				setStatus("idle");
				bridge?.onEnd();
			});
		return;
	}
	// 倒计时中点停 = 撤销
	closeSession();
	setStatus("idle");
	bridge?.onEnd();
}

export function toggleVoiceInput(): void {
	if (status === "idle") void startVoiceInput();
	else stopVoiceInput();
}

/**
 * 用户手动改字了（听写期间打字 / 点别处）：
 * 把已经写进草稿的语音段落"定稿"，从**当前光标**重新起一段。
 *
 * 不这么做的话，下一次中间结果会拿开始听写时那个锚点整段替换，
 * 用户刚打的字会被覆盖掉。
 */
export function reanchorVoiceInput(base?: string): void {
	if (status !== "listening") return;
	const active = session;
	session = null;
	ignoreEnd = true;
	active?.abort();
	committed = "";
	current = "";
	// 锚点重起一段，但会话归属不变（用户只是在听写中打了字）—— 仍从桥上现读一次，防止切了会话还接着写
	owner = bridge?.conversationId ?? null;
	bridge?.onStart(base);
	lastSpokeAt = Date.now();
	if (activeEngine === "local") bootLocal();
	else bootBrowser();
}
