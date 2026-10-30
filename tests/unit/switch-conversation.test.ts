/**
 * 切会话时**不能拿引擎转录覆盖「正在飞」的那一轮**（`server/session/switch-conversation.ts`）。
 *
 * 用户 2026-10-30：「跑着跑着，我发的话跟当前 agent 的思考、工具调用信息都看不到了」。
 *
 * 机制：跑一轮时，服务端把「用户消息 + 占位的 assistant 消息」放进 `state.messages[conv]`，
 * 之后所有增量（text_delta / tool_start / tool_end）都按 messageId 往这个数组里 patch。
 * 而打开一条 pi 历史会话会 `readUiMessages` **整份覆盖**这个数组 —— 转录里是上一次落盘的内容，
 * 覆盖之后：增量全对不上（静默失效）、刚发的用户消息也一起没了；引擎读回空数组时整块空白。
 *
 * 规矩：这条会话有回合在飞时，只把转录当「补历史」用（内存里一条都没有才采用）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { UiMessage } from "../../server/protocol.ts";
import { createClientView } from "../../server/session/client-view.ts";
import { createSwitchConversation } from "../../server/session/switch-conversation.ts";
import { createServerState } from "../../server/snapshot/state.ts";

const CONV = "pi:hist-1";
const WORKSPACE = "/w";

function message(id: string, role: "user" | "assistant", text: string): UiMessage {
	return { id, role, ts: 1_000, blocks: [{ kind: "text", text }] } as UiMessage;
}

function harness(options: { inFlight: boolean; opened: UiMessage[] }) {
	const state = createServerState(WORKSPACE);
	// 这条会话只存在于引擎侧（pi 历史会话）：不在本进程的 conversations 里
	state.activeId = null;
	const clientView = createClientView();
	let snapshots = 0;
	const switchTo = createSwitchConversation({
		state,
		clientView,
		infoOf: (id) => (id === CONV ? { workspace: WORKSPACE } : null),
		open: async () => options.opened,
		refreshSessions: async () => {},
		refreshModels: async () => {},
		refreshThinking: async () => {},
		refreshStats: () => {},
		parkPrevious: () => {},
		isTurnActive: () => options.inFlight,
		pushSnapshot: () => {
			snapshots += 1;
		},
	});
	return { state, clientView, switchTo, snapshots: () => snapshots };
}

describe("切到一条正在跑的历史会话", () => {
	it("回合在飞：不覆盖内存里的消息（在飞那条用户消息 + 助手占位都还在）", async () => {
		const inFlightMessages = [message("m-user", "user", "帮我改一下"), message("m-asst", "assistant", "")];
		const { state, switchTo } = harness({ inFlight: true, opened: [] });
		state.messages[CONV] = [...inFlightMessages];

		const result = await switchTo(CONV, "client-1");

		assert.equal(result.ok, true);
		assert.deepEqual(state.messages[CONV], inFlightMessages);
		assert.equal(state.activeId, CONV, "视图还是要切过去");
	});

	it("回合在飞、但内存里一条都没有（刚重启）：采用转录补历史", async () => {
		const loaded = [message("m-old", "user", "很久以前的话")];
		const { state, switchTo } = harness({ inFlight: true, opened: loaded });
		state.messages[CONV] = [];

		await switchTo(CONV, "client-1");
		assert.deepEqual(state.messages[CONV], loaded);
	});

	it("没有回合在跑：照旧用转录刷新（切回来能看到磁盘上的最新内容）", async () => {
		const loaded = [message("m-1", "user", "旧问题"), message("m-2", "assistant", "旧回答")];
		const { state, switchTo } = harness({ inFlight: false, opened: loaded });
		state.messages[CONV] = [message("m-stale", "user", "内存里的旧副本")];

		await switchTo(CONV, "client-1");
		assert.deepEqual(state.messages[CONV], loaded);
	});

	it("视图按客户端各记一份，并且会推一帧快照", async () => {
		const { clientView, switchTo, snapshots } = harness({ inFlight: false, opened: [] });
		await switchTo(CONV, "client-1");
		assert.equal(clientView.activeFor("client-1", null), CONV);
		assert.equal(clientView.activeFor("client-2", null), null, "别的客户端不受影响");
		assert.ok(snapshots() >= 1);
	});
});
