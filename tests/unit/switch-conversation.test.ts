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

function harness(options: {
	inFlight: boolean;
	opened: UiMessage[];
	mine?: boolean;
	log?: (message: string, ctx?: Record<string, unknown>) => void;
	statsCalls?: (string | undefined)[];
}) {
	const state = createServerState(WORKSPACE);
	// 这条会话只存在于引擎侧（pi 历史会话）：不在本进程的 conversations 里
	state.activeId = null;
	if (options.mine) {
		state.conversations = [
			{ id: CONV, workspace: WORKSPACE, title: "自建" } as unknown as (typeof state.conversations)[number],
		];
	}
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
		refreshStats: (id) => {
			options.statsCalls?.push(id);
		},
		parkPrevious: () => {},
		isTurnActive: () => options.inFlight,
		pushSnapshot: () => {
			snapshots += 1;
		},
		...(options.log ? { log: options.log } : {}),
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

/**
 * 切会话的分段计时（手机上「切会话慢」唯一可信的定位手段）。
 *
 * 只要这些字段还在，就能从日志直接读出「是打开会话贵、模型回读贵，还是快照构建贵」——
 * 少了哪一格，就只能靠猜。所以这里把日志形状也当契约锁住。
 */
describe("切到一条不在运行中的历史会话：统计要重算", () => {
	it("切过去时按该会话 id 刷新统计，不然上下文用量一直是 0", async () => {
		const statsCalls: (string | undefined)[] = [];
		const { switchTo } = harness({ inFlight: false, opened: [], statsCalls });

		await switchTo(CONV, "client-1");

		assert.deepEqual(statsCalls, [CONV]);
	});
});

describe("切会话的分段计时日志", () => {
	function collector() {
		const lines: Record<string, unknown>[] = [];
		return {
			lines,
			log: (_message: string, ctx?: Record<string, unknown>) => {
				lines.push(ctx ?? {});
			},
		};
	}

	it("真的重新打开时，四段耗时都有数", async () => {
		const sink = collector();
		const { switchTo } = harness({ inFlight: false, opened: [message("m-1", "user", "你好")], log: sink.log });

		await switchTo(CONV, "client-1");

		assert.equal(sink.lines.length, 1, "一次切会话一行日志");
		const ctx = sink.lines[0]!;
		assert.equal(ctx.outcome, "ok");
		assert.equal(ctx.reopened, true);
		assert.equal(ctx.mine, false);
		assert.equal(ctx.messages, 1);
		for (const phase of ["open", "models", "thinking", "build", "total"]) {
			assert.equal(typeof ctx[phase], "number", `${phase} 应该是一个毫秒数`);
			assert.ok(Number(ctx[phase]) >= 0, `${phase} 不能是负数`);
		}
	});

	it("已经是当前会话、消息也在内存里：不重读转录，open 那一格缺省", async () => {
		const sink = collector();
		const { state, switchTo } = harness({ inFlight: false, opened: [message("m-1", "user", "你好")], log: sink.log });
		await switchTo(CONV, "client-1");

		sink.lines.length = 0;
		const result = await switchTo(CONV, "client-1");

		assert.equal(result.ok, true);
		assert.equal(sink.lines[0]?.reopened, false);
		assert.equal(sink.lines[0]?.open, undefined, "没重新打开就不该有 open 耗时");
		assert.equal(state.activeId, CONV);
	});

	it("自建会话走另一条路：mine=true，也有 stats/build 两格", async () => {
		const sink = collector();
		const { switchTo } = harness({ inFlight: false, opened: [], mine: true, log: sink.log });

		await switchTo(CONV, "client-1");

		const ctx = sink.lines[0]!;
		assert.equal(ctx.outcome, "ok");
		assert.equal(ctx.mine, true);
		assert.equal(ctx.open, undefined, "自建会话不读转录");
		for (const phase of ["models", "thinking", "stats", "build", "total"]) {
			assert.equal(typeof ctx[phase], "number", `${phase} 应该是一个毫秒数`);
		}
	});

	it("失败也要落一行（会话不存在）", async () => {
		const sink = collector();
		const { switchTo } = harness({ inFlight: false, opened: [], log: sink.log });

		const result = await switchTo("pi:missing", "client-1");

		assert.equal(result.ok, false);
		assert.equal(sink.lines.length, 1);
		assert.equal(sink.lines[0]?.outcome, "not_found");
		assert.equal(typeof sink.lines[0]?.total, "number");
	});
});
