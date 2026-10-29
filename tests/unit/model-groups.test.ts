/**
 * 模型选择器只列已启用的模型（`web/src/model-groups.ts`）。
 *
 * 这是用户直接提的展示要求：「模型不启用的时候，选择模型上看不到它们」。
 * 面板里明明是 `0/9 启用`，选择器里却还能看到那个 provider 的 9 个模型 ——
 * 停用的东西还能选中、选完又用不了，等于把做过的决定重新摆回眼前。
 *
 * 白名单语义必须与 `server/providers/enabled-models.ts` 一致（空 = 全开）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { filterEnabledModels, groupModels, providerOf } from "../../web/src/model-groups.ts";
import type { ModelOption } from "../../web/src/types.ts";

const model = (id: string): ModelOption => ({ id, label: id.split("/")[1] ?? id }) as ModelOption;

const universe = [
	model("nexita-codex/gpt-5.6-luna"),
	model("nexita-codex/gpt-5.6-sol"),
	model("openai-codex/gpt-6.1-sol"),
	model("openai-codex/gpt-6-luna"),
	model("opencode-go/claude-haiku-5.5"),
];

const ids = (list: ModelOption[]) => list.map((item) => item.id);

describe("filterEnabledModels", () => {
	it("空白名单 = 全开（pi 的语义：不限制）", () => {
		assert.deepEqual(ids(filterEnabledModels(universe, [])), ids(universe));
	});

	it("provider/** 只放行那个 provider 的全部模型", () => {
		const enabled = filterEnabledModels(universe, ["openai-codex/**"]);
		assert.deepEqual(ids(enabled), ["openai-codex/gpt-6.1-sol", "openai-codex/gpt-6-luna"]);
	});

	it("单模型条目只放行那一个", () => {
		const enabled = filterEnabledModels(universe, ["openai-codex/gpt-6.1-sol"]);
		assert.deepEqual(ids(enabled), ["openai-codex/gpt-6.1-sol"]);
	});

	it("用户遇到的那一幕：nexita-codex 是 0/9，就不该出现在列表里", () => {
		// 面板显式关掉了 nexita-codex（其它 provider 全开），白名单里没有它的任何条目
		const allowlist = universe.filter((item) => providerOf(item) !== "nexita-codex").flatMap((item) => [item.id]);
		const enabled = filterEnabledModels(universe, allowlist);
		assert.equal(
			enabled.some((item) => providerOf(item) === "nexita-codex"),
			false,
			"已停用的 provider 还留在选择器里",
		);
		// 分组里也不该留下一个空壳组头（截图里那个 NEXITA-CODEX 标题）
		const groups = groupModels(enabled);
		assert.equal(
			groups.some((group) => group.provider === "nexita-codex"),
			false,
		);
	});

	it("全部停用 → 空列表（UI 显示「去面板里勾选」而不是空白）", () => {
		assert.deepEqual(filterEnabledModels(universe, ["other-provider/**"]), []);
	});

	it("白名单里的条目指向不存在的模型时不影响其它模型", () => {
		const enabled = filterEnabledModels(universe, ["opencode-go/claude-haiku-5.5", "gone/model"]);
		assert.deepEqual(ids(enabled), ["opencode-go/claude-haiku-5.5"]);
	});

	it("不认识形状的 id（没有斜杠）不拦：宁可多显示，也不要凭空消失", () => {
		const weird = [model("gpt-unknown")];
		assert.deepEqual(ids(filterEnabledModels(weird, ["openai-codex/**"])), ["gpt-unknown"]);
	});
});
