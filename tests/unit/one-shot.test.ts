/**
 * 一次性补全的编排层：模型选择顺序、失败兜底、错误文案。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	createTextCompleter,
	preferSessionTarget,
	splitModelId,
	type OneShotTarget,
} from "../../server/session/one-shot.js";

const target = (provider: string, model: string): OneShotTarget => ({
	provider,
	model,
	api: "openai-completions",
	baseUrl: "https://example.com/v1",
	credential: "sk-test",
});

describe("splitModelId", () => {
	it("拆 provider/model", () => {
		assert.deepEqual(splitModelId("deepseek/deepseek-chat"), { provider: "deepseek", model: "deepseek-chat" });
	});
	it("形状不对返回 null", () => {
		assert.equal(splitModelId("no-slash"), null);
		assert.equal(splitModelId("/model"), null);
		assert.equal(splitModelId("provider/"), null);
	});
});

describe("preferSessionTarget", () => {
	const targets = [target("a", "x"), target("b", "y"), target("c", "y")];

	it("精确匹配 provider/model 排第一位", () => {
		const ordered = preferSessionTarget(targets, "b/y");
		assert.deepEqual(ordered[0], target("b", "y"));
		assert.equal(ordered.length, 3);
	});

	it("provider 对不上时按模型 id 匹配", () => {
		const ordered = preferSessionTarget(targets, "other/y");
		assert.equal(ordered[0]?.model, "y");
	});

	it("完全匹配不上就保持原顺序", () => {
		assert.deepEqual(preferSessionTarget(targets, "z/none"), targets);
	});

	it("没有会话模型时原样返回", () => {
		assert.deepEqual(preferSessionTarget(targets, null), targets);
	});
});

describe("createTextCompleter", () => {
	it("引擎直连成功就不碰工作台凭证", async () => {
		let sent = 0;
		const complete = createTextCompleter({
			engineComplete: async () => "引擎给的文本",
			sessionModelOf: () => null,
			availableTargets: async () => {
				throw new Error("不该走到这里");
			},
			send: async () => {
				sent += 1;
				return { ok: true, text: "工作台" };
			},
		});
		const result = await complete({ conversationId: "c1", prompt: "p", system: "s" });
		assert.deepEqual(result, { ok: true, text: "引擎给的文本" });
		assert.equal(sent, 0);
	});

	it("引擎直连抛错 → 退到工作台直连", async () => {
		const seen: string[] = [];
		const complete = createTextCompleter({
			engineComplete: async () => {
				throw new Error("引擎炸了");
			},
			sessionModelOf: () => "b/y",
			availableTargets: async () => [target("a", "x"), target("b", "y")],
			send: async (t) => {
				seen.push(`${t.provider}/${t.model}`);
				return { ok: true, text: "工作台" };
			},
		});
		const result = await complete({ conversationId: "c1", prompt: "p", system: "s" });
		assert.deepEqual(result, { ok: true, text: "工作台" });
		// 会话模型优先
		assert.equal(seen[0], "b/y");
	});

	it("没有会话 id 时直接用工作台凭证", async () => {
		const complete = createTextCompleter({
			sessionModelOf: () => null,
			availableTargets: async () => [target("a", "x")],
			send: async () => ({ ok: true, text: "ok" }),
		});
		assert.deepEqual(await complete({ prompt: "p", system: "s" }), { ok: true, text: "ok" });
	});

	it("第一个模型失败就试下一个，最多 3 个", async () => {
		const tried: string[] = [];
		const complete = createTextCompleter({
			sessionModelOf: () => null,
			availableTargets: async () => [target("a", "1"), target("b", "2"), target("c", "3"), target("d", "4")],
			send: async (t) => {
				tried.push(t.model);
				return t.model === "3" ? { ok: true, text: "第三个成了" } : { ok: false, message: "401" };
			},
		});
		const result = await complete({ prompt: "p", system: "s" });
		assert.deepEqual(result, { ok: true, text: "第三个成了" });
		assert.deepEqual(tried, ["1", "2", "3"]);
	});

	it("没有任何带凭证的模型 → 明确让人去配", async () => {
		const complete = createTextCompleter({
			sessionModelOf: () => null,
			availableTargets: async () => [],
			send: async () => ({ ok: true, text: "不该发生" }),
		});
		const result = await complete({ prompt: "p", system: "s" });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "oneshot.no_model");
			assert.match(result.message, /模型/);
		}
	});

	it("全部失败 → 把每个模型的原因带上", async () => {
		const complete = createTextCompleter({
			sessionModelOf: () => null,
			availableTargets: async () => [target("a", "1")],
			send: async () => ({ ok: false, message: "401（invalid key）" }),
		});
		const result = await complete({ prompt: "p", system: "s" });
		assert.equal(result.ok, false);
		if (!result.ok) {
			assert.equal(result.code, "oneshot.failed");
			assert.match(result.message, /invalid key/);
		}
	});
});
