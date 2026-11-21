/**
 * 回归：用户在听写途中切了会话 → 语音文字不许串到新会话里，也不许替他发出去。
 *
 * 报的 bug（2026-11-21）：「我在别的会话里面发语音文字的话，他会串会话」。
 *
 * 成因：语音听写是模块级单例（浮条在 `App`），而草稿正文和光标锚点是**每条会话一份**，
 * 切会话只交接草稿（`handoffDraft`），没人通知听写。于是下一个中间结果会拿上一条会话的锚点
 * 整段替换新会话的草稿，静音到点还会把那句话发给新会话。
 *
 * 这个文件在 node 里跑：先把 `window` / `document` / `fetch` / `SpeechRecognition` 摆好，
 * 再 import 语音模块（它模块级就会读这些）。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";

type ResultEvent = { results: ArrayLike<ArrayLike<{ transcript?: string }>> };

class FakeRecognition {
	lang = "";
	continuous = false;
	interimResults = false;
	maxAlternatives = 1;
	onresult: ((event: ResultEvent) => void) | null = null;
	onerror: ((event: { error?: string }) => void) | null = null;
	onend: (() => void) | null = null;
	started = 0;
	aborted = 0;
	start(): void {
		this.started += 1;
	}
	stop(): void {}
	abort(): void {
		this.aborted += 1;
	}
	/** 模拟浏览器吐一段（累积的）识别结果 */
	emitResult(transcript: string): void {
		this.onresult?.({ results: [[{ transcript }]] });
	}
}

const recognitions: FakeRecognition[] = [];
class RecordingRecognition extends FakeRecognition {
	constructor() {
		super();
		recognitions.push(this);
	}
}

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = {
	isSecureContext: true,
	SpeechRecognition: RecordingRecognition,
	setInterval: (handler: () => void, ms: number) => setInterval(handler, ms) as unknown as number,
	clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
	setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms) as unknown as number,
	clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	dispatchEvent: () => true,
};
globals.document = {
	visibilityState: "visible",
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	dispatchEvent: () => true,
};
// 设置同步会打宿主接口：这里让所有请求都「失败」，模块按「没有远端设置」处理
globals.fetch = async () => ({ ok: false, json: async () => ({}) });

const voice = await import("../../web/src/voice-input.ts");
const {
	bindVoiceBridge,
	startVoiceInput,
	stopVoiceInput,
	voiceInputStatus,
	loadVoiceInputSettings,
	saveVoiceInputSettings,
} = voice;

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** 一个可控的"输入框"：它会记录被写进来的字、被要求发送的次数 */
function makeBridge(conversationId: string | null) {
	const texts: string[] = [];
	let submits = 0;
	let ends = 0;
	const bridge = {
		// 和 `Composer` 一样用 getter 读当前会话：切会话时这个值立刻变
		conversationId,
		onStart: () => undefined,
		onText: (text: string) => texts.push(text),
		onEnd: () => {
			ends += 1;
		},
		submitVoice: () => {
			submits += 1;
		},
	};
	return {
		bridge,
		texts,
		submits: () => submits,
		ends: () => ends,
		switchTo(next: string | null) {
			bridge.conversationId = next;
		},
	};
}

function armVoice(): FakeRecognition {
	saveVoiceInputSettings({
		...loadVoiceInputSettings(),
		engine: "browser",
		autoSend: true,
		continuous: false,
		silenceMs: 800,
	});
	startVoiceInput();
	assert.equal(voiceInputStatus(), "listening");
	const recognition = recognitions.at(-1);
	assert.ok(recognition, "应该已经开了一个识别会话");
	return recognition;
}

afterEach(() => {
	if (voiceInputStatus() !== "idle") stopVoiceInput();
	bindVoiceBridge(null);
});

describe("语音听写的会话归属", () => {
	it("听写途中切会话：新会话一个字都收不到，听写就地收摊", () => {
		const target = makeBridge("conv-A");
		bindVoiceBridge(target.bridge);
		const recognition = armVoice();

		recognition.emitResult("你好呀");
		assert.deepEqual(target.texts, ["你好呀"]);

		// 用户在侧栏点了另一条会话：Composer 那边 getter 立刻返回新 id
		target.switchTo("conv-B");
		recognition.emitResult("你好呀，别串会话");

		assert.deepEqual(target.texts, ["你好呀"], "切走之后的识别结果不能写进新会话的草稿");
		assert.equal(voiceInputStatus(), "idle", "听写应当就地收摊，而不是继续往新会话里写");
	});

	it("切会话后静音到点：不替用户把这句话发给新会话", async () => {
		const target = makeBridge("conv-A");
		bindVoiceBridge(target.bridge);
		const recognition = armVoice();

		recognition.emitResult("我看一眼这个");
		assert.deepEqual(target.texts, ["我看一眼这个"]);

		target.switchTo("conv-B");
		await sleep(1200);

		assert.equal(target.submits(), 0, "静音到点也不许自动发送：那句话属于上一条会话");
		assert.equal(voiceInputStatus(), "idle");
	});

	it("没切会话时照常自动发送（别把正常路径一起挡了）", async () => {
		const target = makeBridge("conv-A");
		bindVoiceBridge(target.bridge);
		const recognition = armVoice();

		recognition.emitResult("这条正常发出去");
		await sleep(1200);

		assert.equal(target.submits(), 1);
		assert.deepEqual(target.texts, ["这条正常发出去"]);
	});

	it("切到「新会话」那一屏也算切走", async () => {
		const target = makeBridge("conv-A");
		bindVoiceBridge(target.bridge);
		const recognition = armVoice();

		recognition.emitResult("先说一句");
		target.switchTo(null);
		recognition.emitResult("先说一句又说一句");

		assert.deepEqual(target.texts, ["先说一句"]);
		assert.equal(voiceInputStatus(), "idle");
	});
});
