/**
 * 「想想」改成直连补全之后的行为：不再发隐藏回合，自己解析建议标记。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createRefreshActions } from "../../server/session/refresh-actions.js";
import { actionsOf, createServerState } from "../../server/snapshot/state.js";

const deps = (overrides: Partial<Parameters<typeof createRefreshActions>[0]> = {}) => {
	const state = createServerState("/tmp/ws");
	state.activeId = "c1";
	let seq = 0;
	return {
		state,
		create: () =>
			createRefreshActions({
				state,
				notice: () => {},
				pushSnapshot: () => {},
				completeText: async () => ({ ok: true, text: "[[action:suggest:跑一下测试]]" }),
				transcriptOf: async () => "用户：改完登录\n助手：好了",
				nextId: () => `action-${++seq}`,
				timeoutMs: 0,
				...overrides,
			}),
	};
};

describe("createRefreshActions", () => {
	it("解析模型给的建议标记，写进该会话并在快照里可见", async () => {
		const { state, create } = deps({
			completeText: async () => ({
				ok: true,
				text: "[[action:suggest:跑一下测试]]\n[[action:suggest:提交改动]]",
			}),
		});
		const result = await create()("c1", 5);
		assert.deepEqual(result, { ok: true });
		assert.deepEqual(
			actionsOf(state, "c1").map((action) => action.label),
			["跑一下测试", "提交改动"],
		);
	});

	it("把对话上下文拼进提示词（模型看不到会话，必须自带）", async () => {
		let seen = "";
		const { create } = deps({
			transcriptOf: async () => "用户：把登录改成手机号",
			completeText: async (input) => {
				seen = input.prompt;
				return { ok: true, text: "[[action:suggest:补测试]]" };
			},
		});
		await create()("c1", 5);
		assert.match(seen, /把登录改成手机号/);
	});

	it("模型没按格式回 → 明确报错，而不是清空原来的建议", async () => {
		const { state, create } = deps({
			completeText: async () => ({ ok: true, text: "我觉得可以先写测试。" }),
		});
		state.actionsByConversation.c1 = [{ id: "old", label: "旧建议", prompt: "旧建议" }];
		const result = await create()("c1", 5);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "actions.empty");
		assert.equal(actionsOf(state, "c1")[0]?.label, "旧建议");
	});

	it("补全失败时把原因带出来", async () => {
		const { create } = deps({
			completeText: async () => ({ ok: false, code: "oneshot.no_model", message: "没有可用模型" }),
		});
		const result = await create()("c1", 5);
		assert.equal(result.ok, false);
		if (!result.ok) assert.match(result.error.message, /没有可用模型/);
	});

	it("没有会话 id 且当前也没有会话 → 直接拒绝", async () => {
		const { state, create } = deps();
		state.activeId = null;
		const result = await create()(undefined, 5);
		assert.equal(result.ok, false);
		if (!result.ok) assert.equal(result.error.code, "session.none");
	});

	it("没传会话 id 时回退到当前会话", async () => {
		const { state, create } = deps();
		const result = await create()(undefined, 5);
		assert.deepEqual(result, { ok: true });
		assert.equal(actionsOf(state, "c1").length, 1);
	});
});
