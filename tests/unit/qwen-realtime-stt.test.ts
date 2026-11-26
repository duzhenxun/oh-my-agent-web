/**
 * 千问实时识别（WebSocket）：**边说边出字**的协议层。
 *
 * 为什么值得单测：这条链路全靠一串「约定」撑起来 —— 少一个参数就是没有中间结果，
 * 早发一帧音频就是 `task-failed`，`finish-task` 少了 `payload.input` 直接被上游拒绝。
 * 而这些都是**不联网就看不出来**的（真连一次要花时间，还依赖网络）。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { qwenRealtimeStt } from "../../server/stt/qwen-realtime.ts";

type Listener = (event: { data?: unknown; message?: string }) => void;

/** 假的 WebSocket：只记下发了什么，并允许测试手动「推」服务端事件 */
class FakeSocket {
	static last: FakeSocket | undefined;
	readonly sent: (string | Buffer)[] = [];
	readonly listeners = new Map<string, Listener[]>();
	closed = false;
	constructor(
		readonly url: string,
		readonly options?: { headers?: Record<string, string> },
	) {
		FakeSocket.last = this;
	}
	addEventListener(type: string, handler: Listener) {
		const list = this.listeners.get(type) ?? [];
		list.push(handler);
		this.listeners.set(type, list);
	}
	send(data: string | Uint8Array) {
		this.sent.push(typeof data === "string" ? data : Buffer.from(data));
	}
	close() {
		this.closed = true;
		this.emit("close");
	}
	emit(type: string, event: { data?: unknown; message?: string } = {}) {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
	/** 服务端事件的小工具 */
	event(kind: string, payload: unknown = {}) {
		this.emit("message", { data: JSON.stringify({ header: { event: kind }, payload }) });
	}
	started() {
		this.event("task-started");
	}
	sentence(text: string, end: boolean) {
		this.event("result-generated", { output: { sentence: { text, sentence_end: end } } });
	}
	finished() {
		this.event("task-finished");
	}
	/** 发出的 JSON 帧（二进制帧另算） */
	json(): Record<string, any>[] {
		return this.sent.filter((item): item is string => typeof item === "string").map((item) => JSON.parse(item));
	}
	binary(): Buffer[] {
		return this.sent.filter((item): item is Buffer => Buffer.isBuffer(item));
	}
}

const originalWebSocket = (globalThis as { WebSocket?: unknown }).WebSocket;
afterEach(() => {
	(globalThis as { WebSocket?: unknown }).WebSocket = originalWebSocket;
	FakeSocket.last = undefined;
});

function installFake() {
	(globalThis as { WebSocket?: unknown }).WebSocket = FakeSocket;
}

const log = { warn: () => undefined };
const pcm = (bytes: number) => Buffer.alloc(bytes, 7);

describe("千问实时识别（WebSocket）", () => {
	it("run-task 打开中间结果、近场 VAD 与心跳（少了这些就不是「边说边出字」）", () => {
		installFake();
		qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		assert.equal(socket.url, "wss://dashscope.aliyuncs.com/api-ws/v1/inference");
		assert.equal(socket.options?.headers?.Authorization, "Bearer sk-1");
		socket.emit("open");
		const run = socket.json()[0];
		assert.equal(run.header.action, "run-task");
		assert.equal(run.header.streaming, "duplex");
		assert.equal(run.payload.input && typeof run.payload.input, "object");
		assert.equal(run.payload.model, "qwen-audio-3.1-asr-flash-message");
		assert.equal(run.payload.parameters.format, "pcm");
		assert.equal(run.payload.parameters.sample_rate, 16000);
		assert.equal(run.payload.parameters.intermediate_result_enabled, true);
		assert.equal(run.payload.parameters.vad_model, "near_meeting_16k");
		assert.equal(run.payload.parameters.heartbeat, true);
	});

	it("task-started 之前的音频先攒着，连上后按顺序补发（说话别丢字）", () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		session.push(pcm(3200));
		session.push(pcm(640));
		assert.equal(socket.binary().length, 0, "还没 task-started 不该发音频");
		socket.emit("open");
		socket.started();
		const frames = socket.binary();
		assert.deepEqual(
			frames.map((frame) => frame.length),
			[3200, 640],
		);
		// 之后的音频直接发
		session.push(pcm(1000));
		assert.equal(socket.binary().length, 3);
	});

	it("中间结果逐步变长；sentence_end 后定型、当前句清空", () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		socket.emit("open");
		socket.started();
		assert.equal(session.text, "");
		socket.sentence("千", false);
		assert.equal(session.text, "千");
		socket.sentence("千问合成", false);
		assert.equal(session.text, "千问合成");
		socket.sentence("千问合成，这是第二家在线引擎。", true);
		assert.equal(session.text, "千问合成，这是第二家在线引擎。");
		// 下一句开始：定稿的留着，当前句从零开始
		socket.sentence("再说一句", false);
		assert.equal(session.text, "千问合成，这是第二家在线引擎。再说一句");
	});

	it("上游给「累计全文」时不会重复拼接", () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		socket.emit("open");
		socket.started();
		socket.sentence("第一句。", true);
		// 累计式：第二次直接给全文
		socket.sentence("第一句。第二句。", true);
		assert.equal(session.text, "第一句。第二句。");
	});

	it("end 发 finish-task（带 payload.input）并返回最终全文", async () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		socket.emit("open");
		socket.started();
		socket.sentence("你好，世界。", true);
		const ending = session.end();
		const finish = socket.json().find((frame) => frame.header?.action === "finish-task");
		assert.ok(finish, "必须发 finish-task");
		assert.deepEqual(finish!.payload, { input: {} });
		socket.finished();
		assert.equal(await ending, "你好，世界。");
		assert.equal(socket.closed, true);
	});

	it("上游 task-failed 时，仍把已经识别出来的部分交出去（不整句丢掉）", async () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		socket.emit("open");
		socket.started();
		socket.sentence("说到一半", false);
		const ending = session.end();
		socket.event("task-failed", {});
		assert.equal(await ending, "说到一半");
	});

	it("没配密钥就不连，end 也不会卡住", async () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime" }, log);
		assert.equal(FakeSocket.last, undefined);
		session.push(pcm(3200));
		assert.equal(await session.end(), "");
	});

	it("cancel 之后不再发音频，text 保持为空", async () => {
		installFake();
		const session = qwenRealtimeStt.create({ provider: "qwen-realtime", apiKey: "sk-1" }, log);
		const socket = FakeSocket.last!;
		socket.emit("open");
		socket.started();
		session.cancel();
		session.push(pcm(3200));
		assert.equal(socket.binary().length, 0);
		assert.equal(await session.end(), "");
	});
});
