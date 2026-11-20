import assert from "node:assert/strict";
import { test } from "node:test";
import { completeOnce } from "../../server/providers/one-shot.js";

test("one-shot model requests do not expose tools and honor external cancellation", async () => {
	const controller = new AbortController();
	let captured: RequestInit | undefined;
	const completion = completeOnce({
		api: "openai-completions",
		baseUrl: "https://example.com/v1",
		modelId: "test",
		credential: "test",
		system: "text only",
		prompt: "draft a note",
		signal: controller.signal,
		fetchImpl: async (_url, request) => {
			captured = request;
			return new Promise<Response>((_resolve, reject) => {
				request?.signal?.addEventListener("abort", () => reject(request.signal!.reason), { once: true });
			});
		},
	});
	assert.ok(captured?.signal);
	const body = JSON.parse(String(captured.body));
	assert.equal(body.tools, undefined);
	assert.equal(body.tool_choice, undefined);
	controller.abort();
	assert.deepEqual(await completion, { ok: false, message: "请求超时" });
});
