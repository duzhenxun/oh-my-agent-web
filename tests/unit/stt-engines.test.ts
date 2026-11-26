/**
 * 云端识别「换引擎 / 换模型」这条路的单测。
 *
 * 为什么值得钉住：
 *   · 面板切换引擎会**写回 `stt.json`**，那文件里是密钥 —— 写坏了就是把用户的 key 抹掉；
 *   · 千问的「整段识别」和「实时识别」是两个 provider，百炼那边却是同一把 key。
 *     切过去要用兄弟 provider 的 key 代抄（`qwen` → `qwen-realtime`），抄错了就变成
 *     「切完判定没配密钥、静默掉回本地识别」，用户只会觉得“切了个没用的东西”；
 *   · `-flash-message` 那个模型只属于**实时**引擎，挂错引擎要当场说清楚，而不是等厂商回 400。
 */
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { AsrService } from "../../server/asr/service.ts";
import { readSttConfig, readSttProviders, saveSttSelection, sttConfigPath } from "../../server/stt/config.ts";
import { listSttProviders } from "../../server/stt/index.ts";

/** `debug` 也要有：`readCloud()` 把「云端已启用」降成 debug（启动时不再往终端刷一行） */
const silentLog = { debug: () => undefined, warn: () => undefined };
const dirs: string[] = [];

function tempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), "aw-stt-engines-"));
	dirs.push(dir);
	return dir;
}

afterEach(() => {
	for (const dir of dirs.splice(0)) {
		// 测试目录里有假密钥，删干净即可
		void dir;
	}
});

function seed(dir: string, config: unknown): void {
	writeFileSync(sttConfigPath(dir), JSON.stringify(config, null, 2), { mode: 0o600 });
}

describe("服务端声明的可选模型", () => {
	it("整段识别与实时识别的模型不串台", () => {
		const qwen = listSttProviders().find((provider) => provider.id === "qwen");
		const realtime = listSttProviders().find((provider) => provider.id === "qwen-realtime");
		const omni = listSttProviders().find((provider) => provider.id === "qwen-omni-realtime");
		assert.ok(qwen?.models?.includes("qwen-audio-3.1-asr-flash"));
		// 旧版 ASR message 协议（run-task / result-generated）
		assert.ok(realtime?.models?.includes("qwen-audio-3.1-asr-flash-message"));
		// Realtime 协议（session.update / input_audio_buffer.append）——两者不能混用
		assert.ok(omni?.models?.includes("qwen3.8-omni-flash-realtime"));
		assert.equal(qwen?.models?.includes("qwen-audio-3.1-asr-flash-message"), false);
		assert.equal(realtime?.models?.includes("qwen3.8-omni-flash-realtime"), false);
	});
});

describe("切换云端引擎（写回 stt.json）", () => {
	it("只改选中项，别家的密钥与字段原样保留", () => {
		const dir = tempDir();
		seed(dir, {
			provider: "qwen",
			providers: {
				qwen: { apiKey: "sk-qwen", model: "qwen-audio-3.1-asr-flash" },
				deepseek: { apiKey: "sk-deepseek", language: "zh" },
			},
		});

		saveSttSelection({ provider: "deepseek" }, dir);

		const parsed = JSON.parse(readFileSync(sttConfigPath(dir), "utf8")) as {
			provider: string;
			providers: Record<string, Record<string, string>>;
		};
		assert.equal(parsed.provider, "deepseek");
		// 千问那块一点都不能丢
		assert.equal(parsed.providers.qwen.apiKey, "sk-qwen");
		assert.equal(parsed.providers.qwen.model, "qwen-audio-3.1-asr-flash");
		assert.equal(parsed.providers.deepseek.language, "zh");
	});

	it("model 传空串 = 回到 provider 默认（删掉这个键）", () => {
		const dir = tempDir();
		seed(dir, {
			provider: "qwen",
			providers: { qwen: { apiKey: "sk-qwen", model: "qwen-audio-3.1-asr-flash" } },
		});

		saveSttSelection({ provider: "qwen", model: "" }, dir);

		const parsed = JSON.parse(readFileSync(sttConfigPath(dir), "utf8")) as {
			providers: Record<string, Record<string, string>>;
		};
		assert.equal("model" in parsed.providers.qwen, false);
		assert.equal(parsed.providers.qwen.apiKey, "sk-qwen");
	});

	it("文件读不懂时不覆盖（里面有密钥）", () => {
		const dir = tempDir();
		writeFileSync(sttConfigPath(dir), "{ 这不是 JSON", "utf8");
		assert.throws(() => saveSttSelection({ provider: "qwen" }, dir), /读不出来/);
		// 原文件一个字都不能变
		assert.equal(readFileSync(sttConfigPath(dir), "utf8"), "{ 这不是 JSON");
	});

	it("readSttProviders 能看见每一家的配置块（面板列引擎要用）", () => {
		const dir = tempDir();
		seed(dir, {
			provider: "qwen",
			providers: { qwen: { apiKey: "sk-qwen" }, "qwen-realtime": {}, deepseek: { apiKey: "sk-ds" } },
		});
		const { blocks } = readSttProviders(dir);
		assert.equal(blocks.qwen.apiKey, "sk-qwen");
		assert.equal(blocks.deepseek.apiKey, "sk-ds");
		assert.equal(blocks["qwen-realtime"].apiKey, undefined);
	});
});

describe("AsrService.selectCloud", () => {
	it("切到实时识别时，借用同厂商兄弟 provider 的密钥", () => {
		const dir = tempDir();
		seed(dir, {
			provider: "qwen",
			providers: { qwen: { apiKey: "sk-qwen" } },
		});
		const service = new AsrService({ log: silentLog, dataDir: dir });

		const engines = service.selectCloud({ provider: "qwen-realtime" });

		assert.equal(engines.provider, "qwen-realtime");
		// 百炼那边是同一把 key：不代抄就会被判「没配密钥」，静默掉回本地识别
		const realtime = readSttProviders(dir).blocks["qwen-realtime"];
		assert.equal(realtime.apiKey, "sk-qwen");
		// 原来那家不受影响
		assert.equal(readSttProviders(dir).blocks.qwen.apiKey, "sk-qwen");
	});

	it("把实时模型挂到整段引擎上：当场报错，不写配置", () => {
		const dir = tempDir();
		seed(dir, { provider: "qwen", providers: { qwen: { apiKey: "sk-qwen" } } });
		const service = new AsrService({ log: silentLog, dataDir: dir });

		assert.throws(
			() => service.selectCloud({ provider: "qwen", model: "qwen-audio-3.1-asr-flash-message" }),
			/是「千问 实时识别（旧版 ASR message 协议）」的模型/,
		);
		assert.throws(
			() => service.selectCloud({ provider: "qwen", model: "qwen3.8-omni-flash-realtime" }),
			/qwen3\.8-omni-flash-realtime.*provider：qwen-omni-realtime/,
		);
		assert.equal(readSttConfig(dir).config?.model, undefined);
	});

	it("未知引擎 / 没配密钥都给出可读原因", () => {
		const dir = tempDir();
		seed(dir, { provider: "qwen", providers: { qwen: { apiKey: "sk-qwen" } } });
		const service = new AsrService({ log: silentLog, dataDir: dir });

		assert.throws(() => service.selectCloud({ provider: "nope" }), /未知的识别引擎/);
		assert.throws(() => service.selectCloud({ provider: "openai-compatible" }), /还没配密钥/);
	});
});

describe("面板列引擎时的「已配密钥」", () => {
	it("只配过 qwen 也能直接选 Omni 实时（兄弟 provider 共用一把 key）", () => {
		const dir = tempDir();
		seed(dir, { provider: "qwen", providers: { qwen: { apiKey: "sk-qwen" } } });
		const service = new AsrService({ log: silentLog, dataDir: dir });

		const engines = service.cloudEngines().engines;
		const omni = engines.find((engine) => engine.id === "qwen-omni-realtime");

		// 灰掉的选项点不到，互借密钥的逻辑就永远没机会跑 —— 所以这里必须算「已配置」
		assert.equal(omni?.configured, true);
		// 但别家厂商不能被顺手点亮
		assert.equal(engines.find((engine) => engine.id === "deepseek")?.configured, false);
	});
});
