/**
 * 「唤醒并重试 2 次仍然没出声」—— 自动重试链自己把正文顶掉的回归。
 *
 * 用户报的现象：一句「任务已完成」经常没声；到面板里点「试听」看到的还是那条
 * 「语音服务没起来（canceled）：已自动唤醒并重试 2 次仍然没出声」。
 *
 * 根子在 `cancel()` 的**余波**上：Chrome / macOS 上 `cancel()` 是异步投事件的，
 * 紧跟着排进去的那句会拿到 `error: canceled`。旧的 `wakeSpeechService()` 在唤醒句
 * `onend`（也就是链路刚刚通了那一拍）里也 cancel 了一次 —— 于是每次「唤醒成功」
 * 都保证把随后的正文顶成 canceled，两轮重试注定全军覆没。而手动再点一次「试听」
 * 又能念，因为那一次的队列是干净的。
 *
 * 这里用一个「cancel 会连坐下一句」的假合成器把这条路跑一遍：旧行为会报红字，
 * 新行为必须自己念出来。同时断言 cancel **只在队列真忙的时候**才发。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { speak, stopSpeaking, wakeSpeechService, type SpeakHooks } from "../../web/src/tts.ts";

/** 计时器压缩比：真实 900/1500ms 的看门狗，测试里 18ms/30ms 就跑完 */
const SPEED = 0.02;
const timer = (fn: () => void, ms: number): ReturnType<typeof setTimeout> => setTimeout(fn, ms * SPEED);

class FakeUtterance {
	text: string;
	rate = 1;
	volume = 1;
	lang = "";
	voice: unknown = null;
	onstart: (() => void) | null = null;
	onend: (() => void) | null = null;
	onerror: ((event: { error: string }) => void) | null = null;
	constructor(text: string) {
		this.text = text;
	}
}

/**
 * 假合成器。三种现实表现：
 *   - `coldOnce`：第一句被系统打断（服务冷启动），之后都能念；
 *   - `silent`：什么都不回（服务真卡死）；
 *   - `poisonOnCancel`：**每次 cancel 都让下一句死成 canceled**（就是上面说的余波）。
 */
function installSynthesis(options: { coldOnce?: boolean; silent?: boolean } = {}) {
	const stats = {
		/** 真正开念过几句 */
		spoken: 0,
		/** 排进合成器的句数（含唤醒句） */
		total: 0,
		/** cancel 次数 / 其中「队列其实是空的时候」发的次数（后者应该永远是 0） */
		cancels: 0,
		idleCancels: 0,
	};
	let speaking = false;
	let pending = false;
	/** 余波：>0 时下一句直接死成 canceled */
	let poison = 0;
	let coldLeft = options.coldOnce === true ? 1 : 0;

	const synth = {
		get speaking() {
			return speaking;
		},
		get pending() {
			return pending;
		},
		paused: false,
		getVoices: () => [{ voiceURI: "google-zh", name: "Google 普通话", lang: "zh-CN", localService: false }],
		addEventListener: () => {},
		removeEventListener: () => {},
		resume: () => {
			synth.paused = false;
		},
		cancel: () => {
			stats.cancels += 1;
			if (!speaking && !pending) stats.idleCancels += 1;
			// cancel 的余波：下一句会被连坐（这就是真实浏览器的行为）
			poison += 1;
			speaking = false;
			pending = false;
		},
		speak: (utter: FakeUtterance) => {
			stats.total += 1;
			pending = true;
			const die = (code: string): void => {
				pending = false;
				speaking = false;
				timer(() => utter.onerror?.({ error: code }), 5);
			};
			if (poison > 0) {
				poison -= 1;
				die("canceled");
				return;
			}
			if (coldLeft > 0) {
				coldLeft -= 1;
				die("canceled");
				return;
			}
			if (options.silent === true) return; // 永远不回：卡死
			timer(() => {
				pending = false;
				speaking = true;
				stats.spoken += 1;
				utter.onstart?.();
				timer(() => {
					speaking = false;
					utter.onend?.();
				}, 10);
			}, 2);
		},
	};

	const win = {
		speechSynthesis: synth,
		SpeechSynthesisUtterance: FakeUtterance,
		setTimeout: (fn: () => void, ms: number) => timer(fn, ms),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	};
	(globalThis as unknown as { window: unknown }).window = win;
	(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
	return stats;
}

const SETTINGS = {
	enabled: true,
	announce: true,
	readReplies: false,
	rate: 1,
	voiceURI: "google-zh",
	allowOnline: true,
};

function recorder() {
	const events: string[] = [];
	const hooks: SpeakHooks = {
		onStart: () => events.push("start"),
		onEnd: () => events.push("end"),
		onIssue: (message) => events.push(`issue:${message}`),
	};
	return { events, hooks, issues: () => events.filter((event) => event.startsWith("issue:")) };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("语音播报：唤醒不能把正文顶掉", () => {
	it("冷启动一次被 canceled 时，唤醒后能自己念出来（不该报红字）", async () => {
		const stats = installSynthesis({ coldOnce: true });
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.deepEqual(tape.events, ["start", "end"], `应自愈成一次正常播报，实际：${JSON.stringify(tape.events)}`);
		assert.equal(stats.cancels, 0, "队列空着的时候一次 cancel 都不该发（那一下会把下一句顶掉）");
	});
});

describe("唤醒系统语音服务：只在真忙的时候 cancel", () => {
	it("队列空着：唤醒句念完不发 cancel", async () => {
		const stats = installSynthesis();
		await new Promise<void>((resolve) => wakeSpeechService(resolve, 5));
		await wait(100);
		assert.equal(stats.cancels, 0, "队列是空的，这一记 cancel 只会连坐掉后面那句");
	});

	it("队列里卡着一句：唤醒会把它清掉（cancel 该发的还是发）", async () => {
		const stats = installSynthesis({ silent: true });
		speak("卡住的上一句", SETTINGS);
		await wait(20);
		const before = stats.cancels;
		await new Promise<void>((resolve) => wakeSpeechService(resolve, 5));
		await wait(100);
		assert.ok(stats.cancels > before, "真有东西卡在队列里时，唤醒必须清掉它");
	});
});

describe("合成器真卡死时，仍然要给结论", () => {
	it("看门狗照旧报一次原因，且不往空队列上发 cancel", async () => {
		const stats = installSynthesis({ silent: true });
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.equal(tape.issues().length, 1, `应有且只有一条失败结论，实际：${JSON.stringify(tape.events)}`);
		assert.equal(stats.idleCancels, 0, "空队列上的 cancel 一律不发");
	});
});

describe("点「停止」", () => {
	it("没有东西在念时不发 cancel（否则下一句白白死一次）", async () => {
		const stats = installSynthesis();
		stopSpeaking();
		assert.equal(stats.cancels, 0);
		// 紧接着的一句照常能念
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.deepEqual(tape.events, ["start", "end"], `不该被空 cancel 连坐，实际：${JSON.stringify(tape.events)}`);
	});
});
