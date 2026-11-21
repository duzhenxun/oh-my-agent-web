import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it, type TestContext } from "node:test";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import express from "express";
import { createTtsRouter, ttsJsonErrorHandler } from "../../server/tts/routes.js";
import { createTtsService, MAX_TEXT_CHARACTERS, type TtsService } from "../../server/tts/service.js";
import { TtsError, type TtsEngine } from "../../server/tts/types.js";

const fakeWorker = fileURLToPath(new URL("./fixtures/local-tts-worker.mjs", import.meta.url));
const signal = () => new AbortController().signal;
const request = (text: string, provider = "kokoro") => ({ text, provider });

function localService(t: TestContext, timeoutMs = 2_000) {
	const previous = [process.env.OH_MY_AGENT_TTS_PYTHON, process.env.OH_MY_AGENT_TTS_SCRIPT];
	process.env.OH_MY_AGENT_TTS_PYTHON = process.execPath;
	process.env.OH_MY_AGENT_TTS_SCRIPT = fakeWorker;
	const service = createTtsService(undefined, { timeoutMs });
	t.after(() => {
		service.close();
		for (const [index, key] of ["OH_MY_AGENT_TTS_PYTHON", "OH_MY_AGENT_TTS_SCRIPT"].entries()) {
			if (previous[index] === undefined) delete process.env[key];
			else process.env[key] = previous[index];
		}
	});
	return service;
}

async function http(t: TestContext, service: TtsService) {
	const app = express();
	app.use(express.json());
	app.use("/api/tts", ttsJsonErrorHandler, createTtsRouter(service));
	const server = createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	t.after(() => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))));
	const address = server.address();
	assert.ok(address && typeof address !== "string");
	const endpoint = `http://127.0.0.1:${address.port}/api/tts`;
	return {
		voices: (provider: string) => fetch(`${endpoint}/voices?provider=${provider}`),
		post: (body: unknown) =>
			fetch(`${endpoint}/speak`, {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(body),
			}),
	};
}

async function whenReady(service: TtsService, text: string) {
	const deadline = Date.now() + 2_000;
	for (;;) {
		try {
			return await service.speak(request(text), signal());
		} catch (error) {
			if (!(error instanceof TtsError && error.status === 429) || Date.now() >= deadline) throw error;
			await delay(10);
		}
	}
}

it("serves the offline local voice lists and rejects invalid synthesis requests before spawning", async (t) => {
	const service = localService(t);
	const endpoint = await http(t, service);
	process.env.OH_MY_AGENT_TTS_PYTHON = process.execPath + ".does-not-exist";
	const voices = {
		kokoro: [
			"zf_xiaobei",
			"zf_xiaoni",
			"zf_xiaoxiao",
			"zf_xiaoyi",
			"zm_yunjian",
			"zm_yunxi",
			"zm_yunxia",
			"zm_yunyang",
		],
		qwen3: ["serena", "vivian", "sohee", "ono_anna", "aiden", "eric", "ryan", "dylan", "uncle_fu"],
	};
	for (const [provider, ids] of Object.entries(voices)) {
		const response = await endpoint.voices(provider);
		assert.equal(response.status, 200);
		assert.deepEqual(
			(await response.json()).voices.map((voice: { id: string }) => voice.id),
			ids,
		);
	}
	assert.equal((await endpoint.voices("edge")).status, 200);
	assert.equal((await endpoint.voices("unsupported")).status, 400);
	for (const body of [
		{ ...request("你好"), voice: "serena" },
		{ ...request("你好", "qwen3"), voice: "zf_xiaoxiao" },
		{ ...request("你好"), voice: "" },
		{ ...request("你好"), rate: 2.1 },
		request(" \t\n"),
		request("你好\u0000"),
		request("你好\ud800"),
		request("😀".repeat(MAX_TEXT_CHARACTERS + 1)),
	]) {
		const response = await endpoint.post(body);
		assert.equal(response.status, 400);
		assert.equal(typeof (await response.json()).error, "string");
	}
});

it("routes both providers, applies their default voices and reuses the worker across requests", async (t) => {
	const endpoint = await http(t, localService(t));
	for (const [index, provider] of ["kokoro", "kokoro", "qwen3"].entries()) {
		const response = await endpoint.post(request("defaults", provider));
		assert.equal(response.status, 200);
		assert.equal(response.headers.get("content-type"), "audio/wav");
		assert.equal(response.headers.get("cache-control"), "no-store");
		const wav = Buffer.from(await response.arrayBuffer());
		assert.equal(wav.toString("ascii", 0, 4), "RIFF");
		assert.equal(wav.readUInt32LE(24), 24_000);
		assert.equal(wav.readInt16LE(44), index + 1);
	}
	const custom = await endpoint.post({ ...request("custom", "qwen3"), voice: "vivian", rate: 1.5 });
	assert.equal(custom.status, 200);
	await custom.arrayBuffer();
	const boundary = await endpoint.post(request("😀".repeat(MAX_TEXT_CHARACTERS)));
	assert.equal(boundary.status, 200);
	await boundary.arrayBuffer();
});

it("uses Edge and its existing defaults when provider is omitted", async (t) => {
	const edge: TtsEngine = {
		voices: () => ({ voices: [{ id: "zh-CN-XiaoxiaoNeural", name: "晓晓", lang: "zh-CN" }] }),
		async speak(input) {
			assert.deepEqual(input, { text: "你好", voice: "zh-CN-XiaoxiaoNeural", rate: 1 });
			return Buffer.from([0xff, 0xfb]);
		},
	};
	const endpoint = await http(t, createTtsService(new Map([["edge", edge]])));
	const response = await endpoint.post({ text: "你好" });
	assert.equal(response.status, 200);
	assert.equal(response.headers.get("content-type"), "audio/mpeg");
	assert.deepEqual(Buffer.from(await response.arrayBuffer()), Buffer.from([0xff, 0xfb]));
});

it("rejects concurrent local HTTP requests with 429 and Retry-After", async (t) => {
	const service = localService(t);
	const endpoint = await http(t, service);
	const first = service.speak(request("slow"), signal());
	const second = await endpoint.post(request("defaults", "qwen3"));
	assert.equal(second.status, 429);
	assert.equal(second.headers.get("retry-after"), "1");
	await second.json();
	assert.equal((await first).audio.readInt16LE(44), 1);
});

it("rejects abort immediately and keeps the local slot busy until the canceled reply is drained", async (t) => {
	const service = localService(t);
	const controller = new AbortController();
	const first = service.speak(request("slow"), controller.signal);
	controller.abort();
	await assert.rejects(first, { name: "AbortError" });
	await assert.rejects(service.speak(request("defaults", "qwen3"), signal()), { status: 429 });
	assert.equal((await whenReady(service, "defaults")).audio.readInt16LE(44), 2);
});

it("times out and replaces a stuck worker, even after the client has aborted", async (t) => {
	const service = localService(t, 500);
	await assert.rejects(service.speak(request("hang"), signal()), { status: 504 });
	assert.equal((await whenReady(service, "defaults")).audio.readInt16LE(44), 1);
	const controller = new AbortController();
	const first = service.speak(request("hang"), controller.signal);
	controller.abort();
	await assert.rejects(first, { name: "AbortError" });
	await assert.rejects(service.speak(request("defaults"), signal()), { status: 429 });
	assert.equal((await whenReady(service, "defaults")).audio.readInt16LE(44), 1);
});

it("rejects a pending synthesis and disables local providers on shutdown", async (t) => {
	const service = localService(t);
	const pending = service.speak(request("hang"), signal());
	service.close();
	await assert.rejects(pending, { status: 502 });
	await assert.rejects(service.speak(request("defaults"), signal()), { status: 502 });
});

it("sanitizes spawn, exit and protocol failures and starts a new worker on retry", async (t) => {
	const service = localService(t);
	process.env.OH_MY_AGENT_TTS_PYTHON = process.execPath + ".does-not-exist";
	await assert.rejects(service.speak(request("private text"), signal()), { status: 502, message: "本地 TTS 合成失败" });
	process.env.OH_MY_AGENT_TTS_PYTHON = process.execPath;
	for (const text of ["exit", "malformed", "bad-wav", "unknown-error"]) {
		await assert.rejects(whenReady(service, text), { status: 502, message: "本地 TTS 合成失败" });
		assert.equal((await whenReady(service, "defaults")).audio.readInt16LE(44), 1);
	}
});
