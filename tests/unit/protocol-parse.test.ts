/**
 * 上行协议的形状校验（`server/protocol-parse.ts`）。
 *
 * 这是所有 WS / `/api/rpc` 请求的唯一入口，26 个 type 分支全在这里。
 * 以前唯一的回归网是 typecheck —— 而这个文件的 bug 全是**运行期**的
 * （CONTEXT.md 里记的 D7：`list_providers` 提前 return 导致 payload 丢失），
 * typecheck 一个都拦不住。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { parseClientRequest, REQUEST_TYPES } from "../../server/protocol-parse.js";
import type { ClientRequest } from "../../server/protocol.js";

const parse = (raw: unknown) => parseClientRequest(raw) as ClientRequest | null;

describe("parseClientRequest 基本形状", () => {
	it("非对象 / 缺 id / 缺 type / 未知 type → null", () => {
		assert.equal(parse(null), null);
		assert.equal(parse("get_state"), null);
		assert.equal(parse({ type: "get_state" }), null);
		assert.equal(parse({ id: "1" }), null);
		assert.equal(parse({ id: "", type: "get_state" }), null);
		assert.equal(parse({ id: "1", type: "nope" }), null);
	});

	it("每个声明过的 type 都能被解析器认出来（不会漏进 null）", () => {
		// 只做「认得出」的粗筛：这里不逐个构造 payload，细分支下面单独测。
		const minimal: Partial<Record<string, unknown>> = {
			set_engine: { engine: "pi" },
			refresh_actions: {},
			send_message: { text: "hi" },
			interrupt: { conversationId: "c1" },
			rename_session: { conversationId: "c1", title: "新名字" },
			approve: { requestId: "a1", decision: "once" },
			get_state: {},
			new_chat: {},
			persist_conversation: { conversationId: "c1" },
			close_ephemeral: { conversationId: "c1" },
			fork_session: { conversationId: "c1", messageId: "entry-1" },
			switch_conversation: { conversationId: "c1" },
			move_session: { conversationId: "c1", workspace: "/tmp/p" },
			set_settings: { settings: {} },
			set_model: { modelId: "openai/gpt" },
			set_approval_mode: { mode: "ask" },
			list_providers: {},
			upsert_provider: { provider: "p", baseUrl: "http://x", models: [] },
			delete_provider: { provider: "p" },
			test_provider: { provider: "p" },
			set_thinking_level: { level: "high" },
			update_model: { provider: "p", model: { id: "m" } },
			remove_model: { provider: "p", modelId: "m" },
			cancel_queued: { queueId: "q1" },
			set_enabled_models: { provider: "p", enabled: true },
			save_subagent_profile: { profile: { id: "x", label: "X" } },
			delete_subagent_profile: { profileId: "x" },
			set_subagent_settings: { enabled: true },
			interrupt_subagent: { runId: "r1" },
		};
		const unknown: string[] = [];
		for (const type of REQUEST_TYPES) {
			const payload = minimal[type] ?? {};
			const result = parse({ id: "1", type, payload, ...payload });
			if (result === null) unknown.push(type);
		}
		assert.deepEqual(unknown, [], `这些 type 被解析器漏掉了：${unknown.join(", ")}`);
	});

	it("get_state 不接受多余字段（形状收敛成 {id,type}）", () => {
		const result = parse({ id: "1", type: "get_state", payload: { junk: 1 } });
		assert.deepEqual(result, { id: "1", type: "get_state" });
	});
});

describe("parseClientRequest 细节分支", () => {
	it("refresh_actions 的 count 只接受 1..5（越界就当没给）", () => {
		const base = { id: "1", type: "refresh_actions" };
		assert.equal(parse({ ...base, payload: { count: 3 } })?.type, "refresh_actions");
		const tooBig = parse({ ...base, payload: { count: 99 } }) as { payload?: { count?: number } };
		assert.equal(tooBig.payload?.count, undefined);
		const zero = parse({ ...base, payload: { count: 0 } }) as { payload?: { count?: number } };
		assert.equal(zero.payload?.count, undefined);
	});

	it("delete_provider / test_provider 接受顶层与 payload 两种形状", () => {
		assert.deepEqual(parse({ id: "1", type: "delete_provider", provider: "p" }), {
			id: "1",
			type: "delete_provider",
			provider: "p",
		});
		assert.deepEqual(parse({ id: "1", type: "delete_provider", payload: { provider: "p" } }), {
			id: "1",
			type: "delete_provider",
			provider: "p",
		});
		// provider 为空 → 非法
		assert.equal(parse({ id: "1", type: "delete_provider", provider: "  " }), null);
	});

	it("approve 只认 once / always / deny", () => {
		const base = { id: "1", type: "approve", payload: { requestId: "a1" } };
		assert.equal(parse({ ...base, payload: { ...base.payload, decision: "once" } })?.type, "approve");
		assert.equal(parse({ ...base, payload: { ...base.payload, decision: "yes" } }), null);
	});

	it("new_chat 的 workspace 可选，空串当没给", () => {
		assert.deepEqual(parse({ id: "1", type: "new_chat" }), { id: "1", type: "new_chat" });
		assert.deepEqual(parse({ id: "1", type: "new_chat", payload: { workspace: "/tmp/p" } }), {
			id: "1",
			type: "new_chat",
			payload: { workspace: "/tmp/p" },
		});
	});
});
