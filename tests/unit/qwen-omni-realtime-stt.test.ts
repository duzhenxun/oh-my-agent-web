/**
 * 千问 Omni 实时识别（Realtime 协议）的协议层单测。
 *
 * 为什么值得钉住：这条链路全靠一串约定支撑，而**错一个就只是「能连上但不出字」**，
 * 不联网根本看不出来：
 *   · 端点必须是 `/api-ws/v1/realtime?model=…`（不是 ASR message 的 `/api-ws/v1/inference`）；
 *   · `session.updated` 之前发音频会被上游拒，所以要先攒着；
 *   · 音频要 base64 塞进 JSON 的 `input_audio_buffer.append`（不是发二进制帧）；
 *   · 预览文本在 `delta.stash`（累积），定稿在 `completed.transcript` —— 拿错字段就等于没字。
 *
 * 这里的期望值都来自 2026-11-24 用真实 key 实测（`say` 合成 3.1s 语音），不是照文档猜的。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { qwenOmniRealtimeStt } from "../../server/stt/qwen-omni-realtime.ts";

type Listener = (event: { data?: unknown; message?: string }) => void;

class FakeSocket {
	static last: FakeSocket | undefined;
	readonly sent: string[] = [];
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
		this.sent.push(typeof data === "string" ? data : Buffer.from(data).toString("base64"));
	}
	close() {
		this.closed = true;
		this.emit("close");
	}
	emit(type: string, event: { data?: unknown; message?: string } = {}) {
		for (const handler of this.listeners.get(type) ?? []) handler(event);
	}
	/** 把服务端事件推给 provider */
	push(payload: unknown) {
		this.emit("message", { data: JSON.stringify(payload) });
	}
	parsed() {
		return this.sent.map((item) => JSON.parse(item) as Record<string, unknown>);
	}
}

const realWebSocket = globalThis.WebSocket;

function install(): FakeSocket {
	// @ts-expect-error 测试里用假 socket 顶替内置 WebSocket
	globalThis.WebSocket = FakeSocket;
	const session = qwenOmniRealtimeStt.create(
		{ provider: "qwen-omni-realtime", endpoint: "", apiKey: "sk-test" },
		{ warn: () => undefined },
	);
	const socket = FakeSocket.last;
	assert.ok(socket, "provider 应该建了连接");
	socket.emit("open");
	// 让测试拿到 session 的同时也能拿到 socket
	(FakeSocket as unknown as { session?: unknown }).session = session;
	return socket;
}

function session() {
	return (FakeSocket as unknown as { session: ReturnType<typeof qwenOmniRealtimeStt.create> }).session;
}

afterEach(() => {
	globalThis.WebSocket = realWebSocket;
	FakeSocket.last = undefined;
	(FakeSocket as unknown as { session?: unknown }).session = undefined;
});

describe("千问 Omni 实时识别的协议", () => {
	it("端点带 ?model=，鉴权走 Authorization 头", () => {
		const socket = install();
		assert.match(socket.url, /\/api-ws\/v1\/realtime\?model=qwen3\.8-omni-flash-realtime$/);
		assert.equal(socket.options?.headers?.Authorization, "Bearer sk-test");
	});

	it("open 之后先发 session.update（只要文字、16k PCM、server_vad）", () => {
		const socket = install();
		const first = socket.parsed()[0];
		assert.equal(first.type, "session.update");
		const config = first.session as Record<string, unknown>;
		assert.deepEqual(config.modalities, ["text"]);
		assert.equal(config.input_audio_format, "pcm16");
		assert.equal(config.sample_rate, 16000);
		assert.deepEqual(config.turn_detection, { type: "server_vad" });
	});

	it("session.updated 之前不发音频，之后按 base64 追加", () => {
		const socket = install();
		const audio = Buffer.alloc(32, 7);
		session().push(audio);
		// 还没 updated：一块都不能发（发了上游会拒）
		assert.equal(socket.parsed().filter((item) => item.type === "input_audio_buffer.append").length, 0);
		socket.push({ type: "session.updated" });
		const appends = socket.parsed().filter((item) => item.type === "input_audio_buffer.append");
		assert.equal(appends.length, 1);
		assert.equal(appends[0].audio, audio.toString("base64"));
	});

	it("预览取 delta.stash，定稿取 completed.transcript", async () => {
		const socket = install();
		socket.push({ type: "session.updated" });
		session().push(Buffer.alloc(8, 1));

		socket.push({ type: "conversation.item.input_audio_transcription.delta", text: "", stash: "你好" });
		assert.equal(session().text, "你好");
		socket.push({ type: "conversation.item.input_audio_transcription.delta", text: "", stash: "你好，这是" });
		assert.equal(session().text, "你好，这是");

		socket.push({
			type: "conversation.item.input_audio_transcription.completed",
			transcript: "你好，这是一次语音识别测试。",
		});
		const text = await session().end();
		assert.equal(text, "你好，这是一次语音识别测试。");
		assert.equal(socket.closed, true);
	});

	it("没配密钥时抛错，而不是静默返回空串", async () => {
		// @ts-expect-error 测试里用假 socket 顶替内置 WebSocket
		globalThis.WebSocket = FakeSocket;
		const empty = qwenOmniRealtimeStt.create(
			{ provider: "qwen-omni-realtime", endpoint: "" },
			{ warn: () => undefined },
		);
		await assert.rejects(async () => empty.end(), /还没配密钥/);
	});
});

describe("千问 Omni 实时：收尾的两个坑", () => {
	it("VAD 已经断句时，end() 不再发 commit、也不空等超时", async () => {
		const socket = install();
		socket.push({ type: "session.updated" });
		session().push(Buffer.alloc(8, 1));
		socket.push({ type: "conversation.item.input_audio_transcription.delta", text: "", stash: "你好" });
		socket.push({ type: "conversation.item.input_audio_transcription.completed", transcript: "你好。" });

		const started = Date.now();
		const text = await session().end();
		const elapsed = Date.now() - started;

		assert.equal(text, "你好。");
		// 已定稿：不该再 commit（那一下必定回 buffer too small）
		assert.equal(socket.parsed().some((item) => item.type === "input_audio_buffer.commit"), false);
		// 也不该走 10 秒超时
		assert.ok(elapsed < 2000, `end() 用了 ${elapsed}ms`);
	});

	it("上游回 buffer too small 属于正常情况，不当失败", async () => {
		const socket = install();
		socket.push({ type: "session.updated" });
		session().push(Buffer.alloc(8, 1));
		// VAD 已经把音频消费掉：我们那次 commit 就会收到这个错
		socket.push({ type: "error", error: { message: "Error committing input audio buffer: buffer too small, or have no audio." } });

		const started = Date.now();
		const text = await session().end();
		const elapsed = Date.now() - started;

		assert.equal(text, "");
		assert.ok(elapsed < 2000, `end() 用了 ${elapsed}ms`);
	});

	it("真错误仍然抛出来（不能静默失败）", async () => {
		const socket = install();
		socket.push({ type: "session.updated" });
		socket.push({ type: "error", error: { message: "Invalid API-key provided." } });
		await assert.rejects(async () => session().end(), /Invalid API-key/);
	});
});
