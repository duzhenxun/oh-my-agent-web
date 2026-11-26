/**
 * 云端 TTS（DeepSeek）与云端 STT（DeepSeek）的接线。
 *
 * 为什么值得单测：
 *   · 密钥是**按厂商分块**读的（合成一个文件、识别一个文件，各家互不影响）——
 *     读错了就是「配了却一直报没配」，用户完全看不出哪儿错；
 *   · 两家都是「请求形状错了就 400」的 HTTP 接口，形状在本地钉住比每次真花钱试要便宜；
 *   · 识别这边有 120 秒硬上限，长音频必须自己切段再拼，拼错了会把两句话粘成一个词。
 */
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { readTtsConfig, providerSecrets, ttsConfigPath } from "../../server/tts/config.ts";
import { createDeepseekEngine } from "../../server/tts/deepseek.ts";
import { TtsError } from "../../server/tts/types.ts";
import { readSttConfig } from "../../server/stt/config.ts";
import { deepseekStt } from "../../server/stt/deepseek.ts";
import { qwenStt } from "../../server/stt/qwen.ts";
import { createQwenEngine } from "../../server/tts/qwen.ts";

const dir = () => mkdtempSync(join(tmpdir(), "oh-my-agent-web-cloud-voice-"));
const log = { warn: () => undefined };

/** 把 fetch 换成一次性的假响应，返回收到的请求，测完自动还原 */
function stubFetch(handler: (input: string, init: RequestInit) => Response | Promise<Response>) {
	const original = globalThis.fetch;
	const calls: { url: string; init: RequestInit }[] = [];
	globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
		const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
		calls.push({ url, init: init ?? {} });
		return handler(url, init ?? {});
	}) as typeof fetch;
	return { calls, restore: () => void (globalThis.fetch = original) };
}

const cleanups: (() => void)[] = [];
afterEach(() => {
	for (const cleanup of cleanups.splice(0)) cleanup();
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("AGENT_WEB_TTS_") || key.startsWith("AGENT_WEB_STT_")) delete process.env[key];
	}
});

describe("TTS 密钥配置（~/.oh-my-agent-web/tts.json）", () => {
	it("按厂商分块读，各家互不影响", () => {
		const dataDir = dir();
		writeFileSync(
			join(dataDir, "tts.json"),
			JSON.stringify({
				providers: {
					deepseek: { apiKey: "sk-deepseek", baseUrl: "https://api.deepseek.com" },
					qwen: { apiKey: "sk-qwen" },
				},
			}),
		);
		const config = readTtsConfig(dataDir);
		assert.equal(providerSecrets(config, "deepseek")?.apiKey, "sk-deepseek");
		assert.equal(providerSecrets(config, "qwen")?.apiKey, "sk-qwen");
		assert.equal(providerSecrets(config, "volcengine"), undefined);
	});

	it("也认老的单厂商扁平写法和顶层厂商名写法", () => {
		const flat = dir();
		writeFileSync(join(flat, "tts.json"), JSON.stringify({ provider: "deepseek", apiKey: "sk-flat" }));
		assert.equal(providerSecrets(readTtsConfig(flat), "deepseek")?.apiKey, "sk-flat");

		const bare = dir();
		writeFileSync(join(bare, "tts.json"), JSON.stringify({ deepseek: { apiKey: "sk-bare" } }));
		assert.equal(providerSecrets(readTtsConfig(bare), "deepseek")?.apiKey, "sk-bare");
	});

	it("环境变量按厂商覆盖文件里的同名项（不动别的厂商）", () => {
		const dataDir = dir();
		writeFileSync(
			join(dataDir, "tts.json"),
			JSON.stringify({ providers: { deepseek: { apiKey: "from-file" }, qwen: { apiKey: "keep-me" } } }),
		);
		process.env.AGENT_WEB_TTS_DEEPSEEK_KEY = "from-env";
		const config = readTtsConfig(dataDir);
		assert.equal(providerSecrets(config, "deepseek")?.apiKey, "from-env");
		assert.equal(providerSecrets(config, "qwen")?.apiKey, "keep-me");
	});

	it("AGENT_WEB_TTS_CONFIG 能换文件位置", () => {
		const dataDir = dir();
		const custom = join(dataDir, "custom.json");
		writeFileSync(custom, JSON.stringify({ providers: { deepseek: { apiKey: "sk-custom" } } }));
		process.env.AGENT_WEB_TTS_CONFIG = custom;
		cleanups.push(() => delete process.env.AGENT_WEB_TTS_CONFIG);
		assert.equal(ttsConfigPath(), custom);
		assert.equal(providerSecrets(readTtsConfig(), "deepseek")?.apiKey, "sk-custom");
	});
});

describe("DeepSeek TTS 引擎", () => {
	const speak = (secrets: Record<string, string> | undefined, text = "你好") =>
		createDeepseekEngine(secrets).speak({ text, voice: "stella", rate: 1 }, new AbortController().signal);

	it("按官方形状发请求：Bearer + text/voice_id/format", async () => {
		const stub = stubFetch(() => new Response(Buffer.from("RIFFwav"), { status: 200 }));
		cleanups.push(stub.restore);
		const audio = await speak({ apiKey: "sk-1" });
		assert.equal(audio.toString(), "RIFFwav");
		assert.equal(stub.calls.length, 1);
		assert.equal(stub.calls[0].url, "https://api.deepseek.com/v1/tools/tts");
		const headers = stub.calls[0].init.headers as Record<string, string>;
		assert.equal(headers.Authorization, "Bearer sk-1");
		const body = JSON.parse(String(stub.calls[0].init.body)) as Record<string, unknown>;
		assert.equal(body.text, "你好");
		assert.equal(body.voice_id, "stella");
		// 要 wav：前端 decodeAudioData 认它，pcm 裸流认不了
		assert.equal(body.format, "wav");
	});

	it("没配密钥时给一句「怎么配」，而不是「不支持的 provider」", async () => {
		const engine = createDeepseekEngine(undefined);
		assert.equal(engine.configured, false);
		assert.match(engine.note ?? "", /tts\.json/);
		await assert.rejects(speak(undefined), (error: unknown) => {
			assert.ok(error instanceof TtsError);
			assert.equal(error.status, 503);
			assert.match(error.message, /tts\.json|AGENT_WEB_TTS_KEY/);
			return true;
		});
	});

	it("内容审核拒绝（400）原样告诉用户，不吞成 502", async () => {
		const stub = stubFetch(() => new Response("Content Exists Risk", { status: 400 }));
		cleanups.push(stub.restore);
		await assert.rejects(speak({ apiKey: "sk-1" }), (error: unknown) => {
			assert.ok(error instanceof TtsError);
			assert.equal(error.status, 400);
			assert.match(error.message, /审核/);
			return true;
		});
	});

	it("密钥无效（401）映射成 503 + 指路", async () => {
		const stub = stubFetch(() => new Response("unauthorized", { status: 401 }));
		cleanups.push(stub.restore);
		await assert.rejects(speak({ apiKey: "bad" }), (error: unknown) => {
			assert.ok(error instanceof TtsError);
			assert.equal(error.status, 503);
			assert.match(error.message, /密钥/);
			return true;
		});
	});
});

describe("STT 配置（~/.oh-my-agent-web/stt.json）", () => {
	it("按厂商分块，自动选中唯一的那家", () => {
		const dataDir = dir();
		writeFileSync(join(dataDir, "stt.json"), JSON.stringify({ providers: { deepseek: { apiKey: "sk-asr" } } }));
		const read = readSttConfig(dataDir);
		assert.equal(read.config?.provider, "deepseek");
		assert.equal(read.config?.apiKey, "sk-asr");
	});

	it("顶层 provider 决定用哪块，别的厂商块不会串进来", () => {
		const dataDir = dir();
		writeFileSync(
			join(dataDir, "stt.json"),
			JSON.stringify({
				provider: "deepseek",
				providers: { deepseek: { apiKey: "sk-deepseek" }, qwen: { apiKey: "sk-qwen", model: "qwen3-asr-flash" } },
			}),
		);
		const read = readSttConfig(dataDir);
		assert.equal(read.config?.apiKey, "sk-deepseek");
		assert.equal(read.config?.model, undefined);
	});

	it("没配就是没配（回落本地识别，不报错）", () => {
		assert.equal(readSttConfig(dir()).config, null);
	});
});

describe("千问 TTS 引擎（百炼 Qwen-Audio-TTS）", () => {
	const speak = (secrets: Record<string, string> | undefined, voice = "longanlingxin_v3.1") =>
		createQwenEngine(secrets).speak({ text: "你好", voice, rate: 1.2 }, new AbortController().signal);

	it("发 SpeechSynthesizer 请求，并把返回的音频 URL 再下载一次", async () => {
		let call = 0;
		const stub = stubFetch((url) => {
			call += 1;
			if (call === 1) {
				return new Response(
					JSON.stringify({
						output: { finish_reason: "stop", audio: { url: "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav", data: "" } },
						usage: { characters: 2 },
					}),
					{ status: 200 },
				);
			}
			// 第二个请求就是去 OSS 拿字节
			return new Response(Buffer.from("RIFFqwen"), { status: 200 });
		});
		cleanups.push(stub.restore);

		const audio = await speak({ apiKey: "sk-qwen" });
		assert.equal(audio.toString(), "RIFFqwen");
		assert.equal(stub.calls.length, 2);
		assert.match(stub.calls[0].url, /\/api\/v1\/services\/audio\/tts\/SpeechSynthesizer$/);
		assert.equal(stub.calls[1].url, "https://dashscope-result-bj.oss-cn-beijing.aliyuncs.com/a.wav");

		const body = JSON.parse(String(stub.calls[0].init.body)) as {
			model: string;
			input: { text: string; voice: string; format: string; rate: number };
		};
		// 用户拍定用 3.1-flash，不是 plus
		assert.equal(body.model, "qwen-audio-3.1-tts-flash");
		assert.equal(body.input.format, "wav");
		// 这家支持语速（和 DeepSeek 不同），要把 rate 发出去
		assert.equal(body.input.rate, 1.2);
		assert.equal((stub.calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-qwen");
	});

	it("音色表按模型分：flash 能选到 plus 没有的精品音色", () => {
		const flash = createQwenEngine({ apiKey: "k", model: "qwen-audio-3.1-tts-flash" }).voices();
		const plus = createQwenEngine({ apiKey: "k", model: "qwen-audio-3.1-tts-plus" }).voices();
		assert.ok(flash.voices.some((voice) => voice.id === "yuxiaoyun_v3.1"));
		assert.ok(!plus.voices.some((voice) => voice.id === "yuxiaoyun_v3.1"));
		// 旗舰音色两边都得有，否则默认音色在 plus 上会被自己的白名单挡掉
		for (const voice of plus.voices) assert.ok(flash.voices.some((item) => item.id === voice.id));
	});

	it("音色不匹配（Engine error 411）翻成「换模型时音色要跟着换」", async () => {
		const stub = stubFetch(
			() =>
				new Response(
					JSON.stringify({ code: "InvalidParameter", message: "[cosyvoice:]Engine error [411]: TTS speak operation failed" }),
					{ status: 400 },
				),
		);
		cleanups.push(stub.restore);
		await assert.rejects(speak({ apiKey: "sk-qwen" }), (error: unknown) => {
			assert.ok(error instanceof TtsError);
			assert.equal(error.status, 400);
			assert.match(error.message, /音色/);
			return true;
		});
	});

	it("没配密钥时说清去哪儿填", async () => {
		const engine = createQwenEngine(undefined);
		assert.equal(engine.configured, false);
		assert.match(engine.note ?? "", /qwen/);
		await assert.rejects(speak(undefined), (error: unknown) => {
			assert.ok(error instanceof TtsError);
			assert.equal(error.status, 503);
			return true;
		});
	});
});

describe("千问 ASR provider（Qwen-Audio-ASR）", () => {
	const pcm = (seconds: number) => Buffer.alloc(seconds * 32_000, 1);

	it("multimodal messages + 必填 parameters，能取到嵌套的 output.text", async () => {
		const stub = stubFetch(
			() =>
				new Response(
					JSON.stringify({
						output: {
							output: { text: " 今天天气不错。 ", sentence: { text: "今天天气不错。" } },
							text: "今天天气不错。",
						},
					}),
					{ status: 200 },
				),
		);
		cleanups.push(stub.restore);
		const session = qwenStt.create({ provider: "qwen", apiKey: "sk-qwen" }, log);
		session.push(pcm(2));
		assert.equal(await session.end(), "今天天气不错。");

		const body = JSON.parse(String(stub.calls[0].init.body)) as {
			model: string;
			input: { messages: { content: { type: string; input_audio: { data: string } }[] }[] };
			parameters: { format: string; sample_rate: string };
		};
		assert.equal(body.model, "qwen-audio-3.1-asr-flash");
		// format / sample_rate 缺了上游直接 UNSUPPORTED_FORMAT，必须带上
		assert.equal(body.parameters.format, "wav");
		assert.equal(body.parameters.sample_rate, "16000");
		// 音频走 data URI（base64），不经第三方存储
		assert.match(body.input.messages[0].content[0].input_audio.data, /^data:audio\/wav;base64,/);
	});

	it("只有 sentence.text 时也能取到", async () => {
		const stub = stubFetch(
			() => new Response(JSON.stringify({ output: { sentence: { text: "只有句级结果" } } }), { status: 200 }),
		);
		cleanups.push(stub.restore);
		const session = qwenStt.create({ provider: "qwen", apiKey: "sk-qwen" }, log);
		session.push(pcm(2));
		assert.equal(await session.end(), "只有句级结果");
	});

	it("超长音频切段后拼接", async () => {
		let call = 0;
		const stub = stubFetch(() => new Response(JSON.stringify({ output: { text: call++ === 0 ? "前半句" : "后半句" } }), { status: 200 }));
		cleanups.push(stub.restore);
		const session = qwenStt.create({ provider: "qwen", apiKey: "sk-qwen" }, log);
		session.push(pcm(200));
		assert.equal(await session.end(), "前半句后半句");
		assert.equal(stub.calls.length, 2);
	});
});

describe("DeepSeek ASR provider", () => {
	const pcm = (seconds: number) => Buffer.alloc(seconds * 32_000, 1);
	/** 只测 end() 整段识别时关掉增量，免得定时器拖着用例 */
	const noIncremental = { incremental: false } as const;

	it("整段发 multipart，取 {text} 回来", async () => {
		const stub = stubFetch(
			() => new Response(JSON.stringify({ request_id: "r1", text: " 上海今天天气怎么样？ " }), { status: 200 }),
		);
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", endpoint: "", apiKey: "sk-asr", ...noIncremental }, log);
		session.push(pcm(2));
		const text = await session.end();
		assert.equal(text, "上海今天天气怎么样？");
		assert.equal(stub.calls[0].url, "https://api.deepseek.com/v1/tools/asr");
		assert.equal((stub.calls[0].init.headers as Record<string, string>).Authorization, "Bearer sk-asr");
		const file = (stub.calls[0].init.body as FormData).get("file") as File;
		assert.equal(file.type, "audio/wav");
		// WAV 头必须在（文档要求 16 位 PCM WAV，裸 PCM 会被 400 掉）
		assert.equal(Buffer.from(await file.arrayBuffer()).toString("ascii", 0, 4), "RIFF");
	});

	it("超过单请求时长上限的音频自动切段，中文之间不加空格", async () => {
		let call = 0;
		const stub = stubFetch(() => new Response(JSON.stringify({ text: call++ === 0 ? "前半句" : "后半句" }), { status: 200 }));
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", apiKey: "sk-asr", ...noIncremental }, log);
		session.push(pcm(200)); // 200 秒 > 110 秒的段长 → 两段
		const text = await session.end();
		assert.equal(stub.calls.length, 2);
		assert.equal(text, "前半句后半句");
	});

	it("太短的音频（静音误触）不发请求", async () => {
		const stub = stubFetch(() => new Response("{}", { status: 200 }));
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", apiKey: "sk-asr", ...noIncremental }, log);
		session.push(Buffer.alloc(1_000, 1));
		assert.equal(await session.end(), "");
		assert.equal(stub.calls.length, 0);
	});

	it("没配密钥时明确说要配哪个字段", async () => {
		const session = deepseekStt.create({ provider: "deepseek", ...noIncremental }, log);
		session.push(pcm(2));
		await assert.rejects(session.end(), /stt\.json/);
	});

	it("录音过程中就出字（准实时），end() 时用整段结果覆盖", async () => {
		// 第 1 次是录音中的增量（只识别到半句），第 2 次是 end() 的整段（完整）
		const replies = ["今天天气", "今天天气不错，我们去楼下走一走。"];
		let call = 0;
		const stub = stubFetch(
			() => new Response(JSON.stringify({ text: replies[Math.min(call++, replies.length - 1)] }), { status: 200 }),
		);
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", apiKey: "sk-asr", incrementalMs: 500 }, log);
		session.push(pcm(2));
		// 还没 end()，但已经该有字了 —— 这就是用户要的「边说边出」
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(session.text, "今天天气");
		assert.equal(call, 1);
		// 收尾用整段结果覆盖增量结果
		assert.equal(await session.end(), "今天天气不错，我们去楼下走一走。");
	});

	it("关掉增量（incremental: false）就只在说完时识别一次", async () => {
		const stub = stubFetch(() => new Response(JSON.stringify({ text: "说完了" }), { status: 200 }));
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", apiKey: "sk-asr", ...noIncremental, incrementalMs: 500 }, log);
		session.push(pcm(2));
		await new Promise((resolve) => setTimeout(resolve, 900));
		assert.equal(session.text, "");
		assert.equal(stub.calls.length, 0);
		assert.equal(await session.end(), "说完了");
		assert.equal(stub.calls.length, 1);
	});

	it("cancel() 后不再发任何请求", async () => {
		const stub = stubFetch(() => new Response(JSON.stringify({ text: "不该被调用" }), { status: 200 }));
		cleanups.push(stub.restore);
		const session = deepseekStt.create({ provider: "deepseek", apiKey: "sk-asr", incrementalMs: 500 }, log);
		session.push(pcm(2));
		session.cancel();
		await new Promise((resolve) => setTimeout(resolve, 800));
		assert.equal(stub.calls.length, 0);
		assert.equal(await session.end(), "");
	});
});
