import { describe, expect, it } from "vitest";
import { readSessionModel } from "../../server/engine/pi-session-model.js";

/** handle 的最小结构：只有会话条目管理器 */
const handleWith = (entries: unknown[]) => ({ sessionManager: { getEntries: () => entries } });

describe("readSessionModel：会话持久化的模型", () => {
	it("取**最后一条** model_change（中途换过模型以最新的为准）", () => {
		const handle = handleWith([
			{ type: "model_change", provider: "openai-codex", modelId: "gpt-6.1-sol" },
			{ type: "message", message: { role: "user" } },
			{ type: "model_change", provider: "deepseek", modelId: "deepseek-flash" },
		]);
		expect(readSessionModel(handle)).toEqual({ provider: "deepseek", model: "deepseek-flash" });
	});

	it("没有 model_change 时返回 null（调用方继续找他路）", () => {
		expect(readSessionModel(handleWith([{ type: "message" }]))).toBeNull();
		expect(readSessionModel(undefined)).toBeNull();
	});

	it("脏数据（缺 provider / modelId 为空）不抛错", () => {
		expect(readSessionModel(handleWith([{ type: "model_change", modelId: "" }]))).toBeNull();
		expect(readSessionModel(handleWith([{ type: "model_change", modelId: "x" }]))).toEqual({
			provider: "?",
			model: "x",
		});
	});
});
