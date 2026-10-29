/**
 * 语音播报「必须有结论」——不留静默失败。
 *
 * 用户报的现象：点「试听」什么都没发生，按钮也还是老样子（最后只看到面板那条兜底文案）。
 * 根子在合成器的回调语义上：
 *
 *   1. `cancel()` 是**异步**投事件的，`canceled` 可能落到**刚排进去的新句子**上；
 *      以前把 canceled/interrupted 一律当「我们自己掐的」静默 return，于是既不响也不报；
 *   2. 有的机器上合成器既不发 onstart 也不发 onerror（系统语音服务卡死），
 *      没有看门狗就永远没有结论。
 *
 * 这里用假合成器把这几种情况都跑一遍，断言「要么响、要么给一句原因」，
 * 并把计时器压缩（真实看门狗是 900ms / 1500ms，测试不等那么久）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { diagnoseSpeech, speak, stopSpeaking, type SpeakHooks, type SpeakIssue } from "../../web/src/tts.ts";

/** 计时器压缩比：真实 900/1500ms 的看门狗，测试里 18ms/30ms 就跑完 */
const SPEED = 0.02;

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

/** 合成器的现实表现：正常 / 卡死（什么都不回） / 每句都被取消 / 只有第一句被取消 */
type Mode = "normal" | "silent" | "aborted" | "aborted-once";

function installSynthesis(mode: Mode): { spoken: number } {
	const counter = { spoken: 0 };
	const synth = {
		speaking: false,
		pending: false,
		paused: false,
		getVoices: () => [{ voiceURI: "google-zh", name: "Google 普通话", lang: "zh-CN", localService: false }],
		addEventListener: () => {},
		removeEventListener: () => {},
		resume: () => {},
		cancel: () => {},
		speak: (utter: FakeUtterance) => {
			counter.spoken += 1;
			// 「只有第一句被取消」= 语音服务冷起时的真实样子：那次失败本身把服务踢醒了，下一句就能念
			const cancelled = mode === "aborted" || (mode === "aborted-once" && counter.spoken === 1);
			const works = mode === "normal" || (mode === "aborted-once" && counter.spoken > 1);
			if (works) {
				window.setTimeout(() => {
					utter.onstart?.();
					utter.onend?.();
				}, 10);
			} else if (cancelled) {
				// 刚排进去就被上一句的 cancel 连坐
				window.setTimeout(() => utter.onerror?.({ error: "canceled" }), 5);
			}
			// silent：什么都不回（系统语音服务卡死的典型表现）
		},
	};
	(globalThis as unknown as { window: unknown }).window = {
		speechSynthesis: synth,
		SpeechSynthesisUtterance: FakeUtterance,
		setTimeout: (fn: () => void, ms: number) => setTimeout(fn, ms * SPEED),
		clearTimeout: (handle: ReturnType<typeof setTimeout>) => clearTimeout(handle),
	};
	(globalThis as unknown as { SpeechSynthesisUtterance: unknown }).SpeechSynthesisUtterance = FakeUtterance;
	return counter;
}

const SETTINGS = {
	enabled: true,
	announce: true,
	readReplies: false,
	rate: 1,
	voiceURI: "google-zh",
	allowOnline: true,
};

/** 收集 hooks 调用 */
function recorder() {
	const events: string[] = [];
	/** 每次 onIssue 带来的结构化上下文（面板靠 `wakeable` 决定要不要显示「唤醒并重试」） */
	const issueFlags: SpeakIssue[] = [];
	const hooks: SpeakHooks = {
		onStart: () => events.push("start"),
		onEnd: () => events.push("end"),
		onIssue: (message, issue) => {
			events.push(`issue:${message}`);
			issueFlags.push(issue);
		},
	};
	const issues = () => events.filter((event) => event.startsWith("issue:"));
	return { events, hooks, issues, issueFlags };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe("语音播报：不许静默失败", () => {
	it("正常合成：onStart / onEnd 都到，且不报错", async () => {
		installSynthesis("normal");
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(120);
		assert.deepEqual(tape.events, ["start", "end"]);
	});

	it("合成器什么都不回：必须在有限时间内报出原因（看门狗）", async () => {
		installSynthesis("silent");
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.equal(tape.issues().length, 1, `应有的失败结论只报一次，实际：${JSON.stringify(tape.events)}`);
		assert.match(tape.issues()[0] ?? "", /语音服务没有响应/);
		// 服务卡死：面板那颗「唤醒并重试」是该给的
		assert.equal(tape.issueFlags[0]?.wakeable, true);
	});

	it("新句子还没开始就被 canceled：不能静默吞掉（这是用户看到「点了没反应」的那条路）", async () => {
		installSynthesis("aborted");
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.equal(tape.issues().length, 1, `应有失败结论，实际：${JSON.stringify(tape.events)}`);
		assert.match(tape.issues()[0] ?? "", /打断|没有响应|没起来/);
		// 唤醒两轮都没救回来：结论同样要标记为「可再唤醒一次」
		assert.equal(tape.issueFlags[0]?.wakeable, true);
	});

	it("只有第一句被系统打断时，自动唤醒后能念出来（不该把 killall 丢给用户）", async () => {
		const counter = installSynthesis("aborted-once");
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		await wait(600);
		assert.deepEqual(tape.events, ["start", "end"], `应自愈成一次正常播报，实际：${JSON.stringify(tape.events)}`);
		assert.ok(counter.spoken >= 2, "应该重排过至少一次（唤醒句 + 正文）");
	});

	it("用户点了「停止」之后回来的 canceled 不算失败，不再刷红字", async () => {
		installSynthesis("aborted");
		const tape = recorder();
		speak("任务已完成", SETTINGS, tape.hooks);
		stopSpeaking();
		await wait(600);
		assert.deepEqual(tape.issues(), []);
	});
});

describe("诊断探针", () => {
	it("合成器正常时，诊断说是「能念」", async () => {
		installSynthesis("normal");
		const result = await diagnoseSpeech(600);
		assert.equal(result.available, true);
		assert.equal(result.started, true);
		assert.equal(result.voices, 1);
		assert.equal(result.online, 1);
	});

	it("合成器卡死时，诊断明确报「没开始也没报错」", async () => {
		installSynthesis("silent");
		// 探针的 timeout 也走压缩后的计时器
		const result = await diagnoseSpeech(600);
		assert.equal(result.started, false);
		assert.equal(result.error, null);
	});
});
