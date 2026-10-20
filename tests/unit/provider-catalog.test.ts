/**
 * pi 的 provider 目录（models.json）：nexita 这类 provider 住在这里，
 * 改动必须写回这份文件（而不是另建一份 models-store 覆盖条目）。
 */
import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MODELS_STORE_FILE, createProviderStore } from "../../server/providers/provider-store.js";

let agentDir = "";
beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "agent-web-catalog-"));
	mkdirSync(agentDir, { recursive: true });
});
afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
});
const store = () => createProviderStore({ agentDir, now: () => 1700000000000 });

describe("目录里的 provider 也能改（写回 models.json，不另建覆盖条目）", () => {
	const catalog = {
		providers: {
			nexita: {
				api: "openai-responses",
				baseUrl: "https://codeapi.nexita.net/v1",
				apiKey: "sk-catalog",
				models: [
					{ id: "gpt-6", name: "GPT-6" },
					{ id: "gpt-6-luna", name: "GPT-6 Luna" },
				],
			},
		},
	};

	it("改模型规格写回 models.json，models-store 不动", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		const result = await store().updateModel("nexita", {
			id: "gpt-6",
			name: "GPT-6 改名",
			reasoning: true,
			imageInput: true,
			contextWindow: 200000,
			maxTokens: 8192,
			cost: null,
		});
		expect(result.ok).toBe(true);
		const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(after.providers.nexita.models[0]).toMatchObject({
			id: "gpt-6",
			name: "GPT-6 改名",
			reasoning: true,
			input: ["text", "image"],
			contextWindow: 200000,
		});
		expect(after.providers.nexita.apiKey).toBe("sk-catalog"); // key 不能被抹掉
		expect(statSync(join(agentDir, "models.json")).mode & 0o777).toBe(0o600);
		// 不该在 models-store 里造覆盖条目
		expect(() => readFileSync(join(agentDir, MODELS_STORE_FILE), "utf8")).toThrow();
	});

	it("移除模型也只动目录里的这一个", async () => {
		writeFileSync(join(agentDir, "models.json"), JSON.stringify(catalog));
		expect((await store().removeModel("nexita", "gpt-6")).ok).toBe(true);
		const after = JSON.parse(readFileSync(join(agentDir, "models.json"), "utf8"));
		expect(after.providers.nexita.models.map((model: { id: string }) => model.id)).toEqual(["gpt-6-luna"]);
	});
});
