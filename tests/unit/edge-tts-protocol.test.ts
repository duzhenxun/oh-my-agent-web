import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer, type Server } from "node:http";
import express from "express";
import { after, before, describe, it } from "node:test";
import { createTtsRouter, ttsJsonErrorHandler } from "../../server/tts/routes.js";
import { createTtsService, MAX_TEXT_CHARACTERS } from "../../server/tts/service.js";
import type { TtsEngine, TtsInput, TtsVoice } from "../../server/tts/types.js";

const voices: TtsVoice[] = [
	{ id: "zh-CN-XiaoxiaoNeural", name: "晓晓", lang: "zh-CN" },
	{ id: "en-US-AriaNeural", name: "Aria", lang: "en-US" },
];
const mp3 = Buffer.from([0xff, 0xfb, 0x90, 0x64]);
type Handler = (input: TtsInput, signal: AbortSignal) => Promise<Buffer>;
const requests: TtsInput[] = [];
let synthesize: Handler = async (input) => {
	requests.push(input);
	return mp3;
};
const fakeEngine: TtsEngine = {
	voices: () => ({ voices }),
	speak(input, signal) {
		requests.push(input);
		return synthesize(input, signal);
	},
};
const service = createTtsService(new Map([["edge", fakeEngine]]));
const app = express();
app.use(express.json());
app.use("/api/tts", ttsJsonErrorHandler, createTtsRouter(service));
const server: Server = createServer(app);
let origin: string;
before(async () => {
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	origin = `http://127.0.0.1:${address.port}`;
});
after(async () => {
	server.close();
	await once(server, "close");
});

const post = (body: unknown) =>
	fetch(`${origin}/api/tts/speak`, {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify(body),
	});

describe("Edge TTS HTTP protocol", () => {
	it("lists edge voices from the required response envelope", async () => {
		const response = await fetch(`${origin}/api/tts/voices?provider=edge`);
		assert.equal(response.status, 200);
		assert.deepEqual((await response.json()).voices, voices);
		assert.equal((await fetch(`${origin}/api/tts/voices?provider=other`)).status, 400);
	});

	it("returns synthesized MP3 bytes with the audio MIME type and default voice", async () => {
		const response = await post({ provider: "edge", text: "你好，世界。" });
		assert.equal(response.status, 200);
		assert.match(response.headers.get("content-type") ?? "", /^audio\/mpeg/);
		assert.deepEqual(Buffer.from(await response.arrayBuffer()), mp3);
		assert.equal(requests.at(-1)?.voice, "zh-CN-XiaoxiaoNeural");
		assert.equal(requests.at(-1)?.rate, 1);
	});

	it("converts a supported voice, text, and speaking rate into the engine request", async () => {
		const response = await post({ provider: "edge", text: "Hello", voice: "en-US-AriaNeural", rate: 1.5 });
		assert.equal(response.status, 200);
		assert.deepEqual(requests.at(-1), { text: "Hello", voice: "en-US-AriaNeural", rate: 1.5 });
	});

	it("returns JSON errors for invalid providers, voices, text, and rates", async () => {
		const cases: Array<[unknown, number]> = [
			[{ provider: "other", text: "hello" }, 400],
			[{ provider: "edge", text: "hello", voice: "en-US-Unknown" }, 400],
			[{ provider: "edge", text: "  " }, 400],
			[{ provider: "edge", text: "hello", rate: 0.49 }, 400],
			[{ provider: "edge", text: "hello", rate: 2.01 }, 400],
			[{ provider: "edge", text: "hello", rate: Number.NaN }, 400],
			[{ provider: "edge", text: "x".repeat(MAX_TEXT_CHARACTERS + 1) }, 400],
			[{ provider: "edge", text: "unsafe\u0000text" }, 400],
			[null, 400],
		];
		for (const [body, status] of cases) {
			const response = await post(body);
			assert.equal(response.status, status);
			assert.equal(response.headers.get("content-type")?.startsWith("application/json"), true);
			assert.equal(typeof (await response.json()).error, "string");
		}
	});

	it("returns JSON for malformed JSON", async () => {
		const response = await fetch(`${origin}/api/tts/speak`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: "{broken",
		});
		assert.equal(response.status, 400);
		assert.equal(typeof (await response.json()).error, "string");
	});

	it("fails quickly rather than queueing work beyond the concurrency limit", async () => {
		let started!: () => void;
		const entered = new Promise<void>((resolve) => (started = resolve));
		let unblock!: () => void;
		synthesize = () =>
			new Promise((resolve) => {
				unblock = () => resolve(mp3);
				started();
			});
		const limited = createTtsService(new Map([["edge", fakeEngine]]), { maxConcurrent: 1 });
		const limitedApp = express();
		limitedApp.use(express.json());
		limitedApp.use("/api/tts", ttsJsonErrorHandler, createTtsRouter(limited));
		const limitedServer = createServer(limitedApp);
		limitedServer.listen(0, "127.0.0.1");
		await once(limitedServer, "listening");
		const address = limitedServer.address();
		assert.ok(address && typeof address !== "string");
		const endpoint = `http://127.0.0.1:${address.port}/api/tts/speak`;
		try {
			const pending = fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "edge", text: "one" }),
			});
			await entered;
			const rejected = await fetch(endpoint, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({ provider: "edge", text: "two" }),
			});
			assert.equal(rejected.status, 429);
			assert.equal(rejected.headers.get("retry-after"), "1");
			unblock();
			assert.equal((await pending).status, 200);
		} finally {
			limitedServer.close();
			await once(limitedServer, "close");
			synthesize = async () => mp3;
		}
	});

	it("propagates a disconnected client as an engine abort", async () => {
		let engineSignal!: AbortSignal;
		synthesize = (_input, signal) =>
			new Promise((_resolve, reject) => {
				engineSignal = signal;
				signal.addEventListener("abort", () => reject(signal.reason), { once: true });
			});
		const controller = new AbortController();
		const pending = fetch(`${origin}/api/tts/speak`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ provider: "edge", text: "cancel me" }),
			signal: controller.signal,
		});
		for (let i = 0; i < 100 && !engineSignal; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.ok(engineSignal, "synthesis should start");
		controller.abort();
		await assert.rejects(pending, { name: "AbortError" });
		for (let i = 0; i < 100 && !engineSignal.aborted; i++) await new Promise((resolve) => setTimeout(resolve, 10));
		assert.equal(engineSignal.aborted, true);
		synthesize = async () => mp3;
	});
});
