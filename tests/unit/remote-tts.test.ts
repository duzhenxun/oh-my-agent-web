import assert from "node:assert/strict";
import { describe, it, type TestContext } from "node:test";
import { setImmediate as nextTurn } from "node:timers/promises";
import {
	fetchRemoteVoices,
	isRemoteSpeechAvailable,
	speakRemote,
	splitSpeechText,
	type RemoteSpeechHooks,
} from "../../web/src/remote-tts.ts";
import { DEFAULT_TTS_SETTINGS, loadTtsSettings, saveTtsSettings, speak, stopSpeaking } from "../../web/src/tts.ts";

const REMOTE_SETTINGS = { provider: "edge", voice: "en-US-JennyNeural", rate: 1.4 } as const;
const EDGE_SETTINGS = {
	...DEFAULT_TTS_SETTINGS,
	provider: REMOTE_SETTINGS.provider,
	edgeVoice: REMOTE_SETTINGS.voice,
	rate: REMOTE_SETTINGS.rate,
	voiceURI: "local-voice",
};
const STORAGE_KEY = "agent-web.voice.tts";

function replaceGlobal(name: string, value: unknown): () => void {
	const original = Object.getOwnPropertyDescriptor(globalThis, name);
	Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
	return () => {
		if (original) Object.defineProperty(globalThis, name, original);
		else Reflect.deleteProperty(globalThis, name);
	};
}

class FakeSource {
	buffer: ArrayBuffer | null = null;
	onended: (() => void) | null = null;
	connectedTo: object | undefined;
	starts = 0;
	stops = 0;
	disconnects = 0;

	connect(destination: object) {
		this.connectedTo = destination;
	}
	start() {
		this.starts++;
	}
	stop() {
		this.stops++;
	}
	disconnect() {
		this.disconnects++;
	}
	finish() {
		this.onended?.();
	}
}

type PendingRequest = {
	url: Parameters<typeof fetch>[0];
	init: RequestInit | undefined;
	resolve: (response: Response) => void;
	reject: (reason: unknown) => void;
};

function installAudio(t: TestContext) {
	const requests: PendingRequest[] = [];
	const sources: FakeSource[] = [];
	const decoded: ArrayBuffer[] = [];
	const destination = {};
	const cancellations: Array<() => void> = [];
	let resumes = 0;
	let context: FakeAudioContext | undefined;
	class FakeAudioContext {
		state: "suspended" | "running" | "closed" = "suspended";
		destination = destination;
		constructor() {
			context = this;
		}
		async resume() {
			resumes++;
			this.state = "running";
		}
		async decodeAudioData(data: ArrayBuffer) {
			decoded.push(data);
			return data;
		}
		createBufferSource() {
			const source = new FakeSource();
			sources.push(source);
			return source;
		}
	}
	const restoreWindow = replaceGlobal("window", {
		AudioContext: FakeAudioContext,
		setTimeout: (callback: () => void, delay: number) => setTimeout(callback, delay).unref(),
		clearTimeout,
	});
	// Tests decide how each request settles, including a response that wins a race with abort.
	const fetchAudio: typeof fetch = (url, init) =>
		new Promise<Response>((resolve, reject) => {
			requests.push({ url, init, resolve, reject });
		});
	const restoreFetch = replaceGlobal("fetch", fetchAudio);
	t.after(async () => {
		try {
			stopSpeaking();
			for (const cancel of cancellations) cancel();
			for (const request of requests) request.resolve(new Response());
			await nextTurn();
		} finally {
			if (context) context.state = "closed"; // The production module caches its AudioContext.
			restoreFetch();
			restoreWindow();
		}
	});
	return {
		requests,
		sources,
		decoded,
		destination,
		get resumes() {
			return resumes;
		},
		play(text: string, hooks: RemoteSpeechHooks) {
			const cancel = speakRemote(text, REMOTE_SETTINGS, hooks);
			cancellations.push(cancel);
			return cancel;
		},
	};
}

function recordSpeech() {
	const events: string[] = [];
	const hooks = {
		onStart: () => events.push("start"),
		onEnd: () => events.push("end"),
		onCancel: () => events.push("cancel"),
		onIssue: (message: string) => events.push(`issue: ${message}`),
	};
	return { events, hooks };
}

function installStorage(t: TestContext) {
	const entries = new Map<string, string>();
	const storage = {
		getItem: (key: string) => entries.get(key) ?? null,
		setItem: (key: string, value: string) => {
			entries.set(key, value);
		},
	};
	t.after(replaceGlobal("localStorage", storage));
	return storage;
}

describe("Remote Edge voices", () => {
	it("loads voices with the supplied abort signal", async (t) => {
		const controller = new AbortController();
		let requestedUrl: Parameters<typeof fetch>[0] | undefined;
		let requestedSignal: AbortSignal | null | undefined;
		const restoreFetch = replaceGlobal("fetch", (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
			requestedUrl = url;
			requestedSignal = init?.signal;
			return new Response(JSON.stringify({ voices: [{ id: "en-US-JennyNeural", name: "Jenny", lang: "en-US" }] }));
		}) satisfies typeof fetch);
		t.after(restoreFetch);

		assert.deepEqual(await fetchRemoteVoices(controller.signal, "edge"), [
			{ id: "en-US-JennyNeural", name: "Jenny", lang: "en-US" },
		]);
		assert.equal(requestedUrl, "/api/tts/voices?provider=edge");
		assert.equal(requestedSignal, controller.signal);
	});

	it("rejects when the voice endpoint is unavailable", async (t) => {
		const restoreFetch = replaceGlobal(
			"fetch",
			(async () => new Response(null, { status: 503 })) satisfies typeof fetch,
		);
		t.after(restoreFetch);
		await assert.rejects(
			fetchRemoteVoices(new AbortController().signal, "edge"),
			/Unable to load Edge voices|无法加载 Edge 音色/,
		);
	});

	it("reports availability only when both Web Audio and fetch are present", () => {
		const restoreFetch = replaceGlobal("fetch", async () => new Response());
		const restoreWindow = replaceGlobal("window", {});
		try {
			assert.equal(isRemoteSpeechAvailable(), false);
			const restoreAudioWindow = replaceGlobal("window", { AudioContext: class {} });
			try {
				assert.equal(isRemoteSpeechAvailable(), true);
				const restoreMissingFetch = replaceGlobal("fetch", undefined);
				try {
					assert.equal(isRemoteSpeechAvailable(), false);
				} finally {
					restoreMissingFetch();
				}
			} finally {
				restoreAudioWindow();
			}
		} finally {
			restoreWindow();
			restoreFetch();
		}
	});
});

describe("splitSpeechText", () => {
	it("preserves punctuation, whitespace and emoji across chunks", () => {
		const text = "？！\n  你好😀！\n\nHi，👩‍💻 and 🇨🇳.  \n";
		assert.equal(splitSpeechText(text, 16).join(""), text);
		assert.deepEqual(splitSpeechText(""), []);
	});

	it("limits UTF-8 bytes even for a long sentence and never cuts a surrogate pair", () => {
		const text = "你😀".repeat(800);
		const chunks = splitSpeechText(text);
		assert.ok(chunks.length > 1);
		const encoder = new TextEncoder();
		const decoder = new TextDecoder("utf-8", { fatal: true });
		const decoded = chunks.map((chunk) => {
			const bytes = encoder.encode(chunk);
			assert.ok(bytes.length > 0 && bytes.length <= 1800, `chunk has ${bytes.length} UTF-8 bytes`);
			return decoder.decode(bytes);
		});
		assert.equal(decoded.join(""), text);
		assert.deepEqual(splitSpeechText("你好😀界😀", 7), ["你好", "😀界", "😀"]);
	});

	it("packs complete sentences together and breaks before a sentence that would overflow", () => {
		assert.deepEqual(splitSpeechText("你好。Hi!\n再见？", 14), ["你好。Hi!\n", "再见？"]);
	});
});

describe("Edge TTS playback", () => {
	it("posts the selected Edge settings and each chunk, with start and end around playback", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		const first = `${"文".repeat(597)}。`;
		const second = "尾句😀！";
		speak(first + second, EDGE_SETTINGS, {
			...speech.hooks,
			onStart() {
				assert.equal(audio.sources[0]?.starts, 1, "onStart must follow source.start()");
				speech.hooks.onStart();
			},
		});
		assert.equal(audio.resumes, 1, "resume must run during the user gesture");
		await nextTurn();
		assert.equal(audio.requests.length, 1);
		assert.equal(audio.sources.length, 0);
		assert.deepEqual(speech.events, []);

		audio.requests[0]!.resolve(new Response(Uint8Array.of(1, 2, 3)));
		await nextTurn();
		assert.equal(audio.requests.length, 2);
		for (const [index, text] of [first, second].entries()) {
			const { url, init } = audio.requests[index]!;
			assert.equal(url, "/api/tts/speak");
			assert.equal(init?.method, "POST");
			assert.equal(new Headers(init?.headers).get("content-type"), "application/json");
			assert.deepEqual(JSON.parse(String(init?.body)), { ...REMOTE_SETTINGS, text });
			assert.equal(init?.signal?.aborted, false);
		}
		assert.equal(audio.sources.length, 1);
		const firstSource = audio.sources[0]!;
		assert.equal(firstSource.starts, 1);
		assert.equal(firstSource.connectedTo, audio.destination);
		assert.equal(firstSource.buffer, audio.decoded[0]);
		assert.deepEqual(new Uint8Array(audio.decoded[0]!), Uint8Array.of(1, 2, 3));
		assert.deepEqual(speech.events, ["start"]);

		audio.requests[1]!.resolve(new Response(Uint8Array.of(4, 5, 6)));
		await nextTurn();
		assert.equal(audio.sources.length, 1, "prefetched audio must wait for the current source to end");
		firstSource.finish();
		await nextTurn();
		assert.equal(firstSource.disconnects, 1);
		assert.equal(audio.sources.length, 2);
		const secondSource = audio.sources[1]!;
		assert.equal(secondSource.starts, 1);
		assert.equal(secondSource.buffer, audio.decoded[1]);
		assert.deepEqual(speech.events, ["start"]);
		secondSource.finish();
		await nextTurn();
		assert.equal(secondSource.disconnects, 1);
		assert.deepEqual(speech.events, ["start", "end"]);
	});

	it("stops and disconnects the playing source when canceled", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		const cancel = audio.play("停止当前播放", speech.hooks);
		await nextTurn();
		audio.requests[0]!.resolve(new Response(Uint8Array.of(1)));
		await nextTurn();
		const source = audio.sources[0]!;
		assert.equal(source.starts, 1);
		assert.deepEqual(speech.events, ["start"]);

		cancel();
		assert.equal(source.stops, 1);
		assert.equal(source.disconnects, 1);
		assert.equal(audio.requests[0]!.init?.signal?.aborted, true);
		source.finish(); // An ended event can still arrive after stop().
		await nextTurn();
		assert.equal(source.disconnects, 1);
		assert.deepEqual(speech.events, ["start"]);
	});

	it("aborts a pending request and ignores audio that arrives after cancellation", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		const cancel = audio.play("在请求期间取消", speech.hooks);
		await nextTurn();
		const request = audio.requests[0]!;
		assert.equal(request.init?.signal?.aborted, false);
		cancel();
		assert.equal(request.init?.signal?.aborted, true);
		request.resolve(new Response(Uint8Array.of(1)));
		await nextTurn();
		assert.equal(audio.decoded.length, 0);
		assert.equal(audio.sources.length, 0);
		assert.deepEqual(speech.events, []);
	});

	it("reports a network error once through onIssue", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		audio.play("网络错误", speech.hooks);
		await nextTurn();
		audio.requests[0]!.reject(new TypeError("Failed to fetch"));
		await nextTurn();
		assert.deepEqual(speech.events, ["issue: Failed to fetch"]);
		assert.equal(audio.sources.length, 0);
	});

	it("reports a server error once through onIssue", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		audio.play("无效音色", speech.hooks);
		await nextTurn();
		audio.requests[0]!.resolve(
			new Response(JSON.stringify({ error: "Unsupported voice" }), {
				status: 400,
				headers: { "content-type": "application/json" },
			}),
		);
		await nextTurn();
		assert.deepEqual(speech.events, ["issue: Unsupported voice"]);
		assert.equal(audio.sources.length, 0);
	});

	it("ends an empty utterance without requesting or starting audio", async (t) => {
		const audio = installAudio(t);
		const speech = recordSpeech();
		audio.play("", speech.hooks);
		await nextTurn();
		assert.equal(audio.requests.length, 0);
		assert.equal(audio.sources.length, 0);
		assert.deepEqual(speech.events, ["end"]);
	});

	it("aborts the old request when the next speak takes over and can stop the new playback", async (t) => {
		const audio = installAudio(t);
		const oldSpeech = recordSpeech();
		const newSpeech = recordSpeech();
		speak("上一条", EDGE_SETTINGS, oldSpeech.hooks);
		await nextTurn();
		const oldRequest = audio.requests[0]!;
		assert.equal(oldRequest.init?.signal?.aborted, false);

		speak("下一条", EDGE_SETTINGS, newSpeech.hooks);
		assert.equal(oldRequest.init?.signal?.aborted, true);
		assert.deepEqual(oldSpeech.events, ["cancel"]);
		oldRequest.reject(oldRequest.init!.signal!.reason);
		await nextTurn();
		assert.equal(audio.requests.length, 2);
		assert.equal(audio.sources.length, 0);
		const newRequest = audio.requests[1]!;
		assert.equal(newRequest.init?.signal?.aborted, false);
		assert.equal(JSON.parse(String(newRequest.init?.body)).text, "下一条");
		newRequest.resolve(new Response(Uint8Array.of(2)));
		await nextTurn();
		assert.equal(audio.sources.length, 1);
		assert.deepEqual(newSpeech.events, ["start"]);

		stopSpeaking();
		assert.equal(audio.sources[0]!.stops, 1);
		assert.equal(newRequest.init?.signal?.aborted, true);
		await nextTurn();
		assert.deepEqual(oldSpeech.events, ["cancel"]);
		assert.deepEqual(newSpeech.events, ["start", "cancel"]);
	});
});

describe("TTS settings migration", () => {
	const legacy = { enabled: false, readReplies: true, rate: 1.2, voiceURI: "legacy-voice", allowOnline: false };

	it("loads legacy settings with the browser provider and a default Edge voice", (t) => {
		const storage = installStorage(t);
		storage.setItem(STORAGE_KEY, JSON.stringify(legacy));
		assert.deepEqual(loadTtsSettings(), { ...DEFAULT_TTS_SETTINGS, ...legacy, provider: "browser" });
	});

	it("persists the migrated provider and Edge voice independently of the browser voice", (t) => {
		const storage = installStorage(t);
		storage.setItem(STORAGE_KEY, JSON.stringify(legacy));
		const edge = { ...loadTtsSettings(), provider: "edge", edgeVoice: REMOTE_SETTINGS.voice } as const;
		saveTtsSettings(edge);
		assert.deepEqual(JSON.parse(storage.getItem(STORAGE_KEY)!), {
			...DEFAULT_TTS_SETTINGS,
			...legacy,
			provider: "edge",
			edgeVoice: REMOTE_SETTINGS.voice,
		});
		assert.deepEqual(loadTtsSettings(), edge);

		saveTtsSettings({ ...edge, provider: "browser" });
		assert.deepEqual(loadTtsSettings(), { ...edge, provider: "browser" });
	});

	it("keeps Kokoro and Qwen3 voices independent when switching engines", (t) => {
		const storage = installStorage(t);
		const kokoro = { ...loadTtsSettings(), provider: "kokoro", kokoroVoice: "zm_yunxi" } as const;
		saveTtsSettings(kokoro);
		assert.deepEqual(loadTtsSettings(), kokoro);
		const qwen3 = { ...loadTtsSettings(), provider: "qwen3", qwen3Voice: "aiden" } as const;
		saveTtsSettings(qwen3);
		assert.deepEqual(loadTtsSettings(), { ...qwen3, kokoroVoice: "zm_yunxi" });
	});

	it("falls back to the browser for malformed providers while retaining saved voices", (t) => {
		const storage = installStorage(t);
		for (const provider of ["unsupported", null, 42]) {
			storage.setItem(STORAGE_KEY, JSON.stringify({ ...legacy, provider, edgeVoice: REMOTE_SETTINGS.voice }));
			assert.deepEqual(loadTtsSettings(), {
				...DEFAULT_TTS_SETTINGS,
				...legacy,
				provider: "browser",
				edgeVoice: REMOTE_SETTINGS.voice,
			});
		}
	});
});
