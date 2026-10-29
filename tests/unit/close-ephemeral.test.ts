/**
 * 关闭临时对话（`server/session/close-ephemeral.ts`）。
 *
 * 这条路径跟「删除」是两件事：删除动磁盘上的会话文件（可恢复），关闭只放掉内存里的东西
 * （临时会话本来就没有文件）。所以要守住的规矩是：
 *   1. 临时会话能关，关完**内存里就不该再有它**（侧栏那一行立刻消失）；
 *   2. 普通会话不能走这条路（有文件，该用「删除」），报错要说清楚；
 *   3. 跑着回合不能关（等于把一轮对话拦腰砍断）；
 *   4. 关不存在的会话要有明确错误码，不是静默成功。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { createCloseEphemeral } from "../../server/session/close-ephemeral.ts";
import type { ConversationMeta } from "../../server/protocol.ts";

const WORKSPACE = "/tmp/agent-web-close-ephemeral";

function makeHarness(options: { ephemeral?: boolean; busy?: boolean } = {}) {
	const conversations: ConversationMeta[] = [
		{
			id: "c1",
			title: "临时的那条",
			createdAt: 0,
			updatedAt: 0,
			workspace: WORKSPACE,
			...(options.ephemeral === false ? {} : { ephemeral: true }),
		},
	];
	const discarded: string[] = [];
	const notices: { text: string; level: string }[] = [];
	let snapshotPushes = 0;

	const close = createCloseEphemeral({
		conversations: () => conversations,
		isBusy: () => options.busy === true,
		discard: (conversationId) => {
			discarded.push(conversationId);
			const index = conversations.findIndex((item) => item.id === conversationId);
			if (index >= 0) conversations.splice(index, 1);
		},
		notice: (text, level) => notices.push({ text, level }),
		pushSnapshot: () => {
			snapshotPushes += 1;
		},
	});

	return { conversations, discarded, notices, close, pushes: () => snapshotPushes };
}

describe("关闭临时对话", () => {
	it("关掉之后：内存里的会话没了、句柄被放掉、推一帧快照、给一条提示", () => {
		const { conversations, discarded, notices, close, pushes } = makeHarness();
		assert.deepEqual(close("c1"), { ok: true });
		assert.deepEqual(discarded, ["c1"], "要走 discard（否则侧栏那行还在、还能点进去发消息）");
		assert.equal(conversations.length, 0);
		assert.equal(notices.length, 1);
		assert.equal(pushes(), 1, "客户端靠快照才知道那一行没了");
	});

	it("普通会话拒绝：它有文件，该走「删除」，不该被这条路径丢内容", () => {
		const { conversations, discarded, close } = makeHarness({ ephemeral: false });
		const result = close("c1");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.error.code, "session.not_ephemeral");
		assert.deepEqual(discarded, [], "拒绝时一个字都不许动");
		assert.equal(conversations.length, 1);
	});

	it("跑着回合拒绝：不能把一轮对话拦腰砍断", () => {
		const { discarded, close } = makeHarness({ busy: true });
		const result = close("c1");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.error.code, "session.busy");
		assert.deepEqual(discarded, []);
	});

	it("会话不存在 → session.not_found（不是静默成功）", () => {
		const { close, pushes } = makeHarness();
		const result = close("nope");
		assert.equal(result.ok, false);
		assert.equal(result.ok === false && result.error.code, "session.not_found");
		assert.equal(pushes(), 0);
	});
});
