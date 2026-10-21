/**
 * 回合结束的推送内容（手机锁屏两行要装得下「哪个项目的哪个会话」）。
 *
 * 断言的是**排版契约**：title = 项目名（工作区最后一段），body = 会话名；
 * 点开必须直达那条会话（url 带 ?session=），同一条会话的通知互相替换（tag）。
 */
import { describe, expect, it } from "vitest";
import { notifyTurnFinished, projectNameOf, type PushPayload, type PushStore } from "../../server/push/push.js";

function fakeStore() {
	const sent: PushPayload[] = [];
	const store = {
		send: async (payload: PushPayload) => {
			sent.push(payload);
			return { sent: 1, failed: 0 };
		},
	} as unknown as PushStore;
	return { store, sent };
}

describe("回合结束的推送内容", () => {
	it("标题用项目名，正文用会话名", async () => {
		const { store, sent } = fakeStore();
		notifyTurnFinished(store, {
			conversationId: "conv-1",
			title: "会员日 模拟测试",
			workspace: "/Users/dds/go/src/inke.activity.service",
		});
		await Promise.resolve();
		expect(sent[0]?.title).toBe("inke.activity.service");
		expect(sent[0]?.body).toBe("会员日 模拟测试");
	});

	it("点开直达那条会话，同会话的通知互相替换", async () => {
		const { store, sent } = fakeStore();
		notifyTurnFinished(store, { conversationId: "conv 2", title: "t", workspace: "/repo/agent-web" });
		await Promise.resolve();
		expect(sent[0]?.url).toBe("/?session=conv%202");
		expect(sent[0]?.tag).toBe("turn-conv 2");
	});

	it("工作区缺失 → 抬头回落应用名；会话名空着 → 正文回落「会话」", async () => {
		const { store, sent } = fakeStore();
		notifyTurnFinished(store, { conversationId: "conv-3", title: "   " });
		await Promise.resolve();
		expect(sent[0]?.title).toBe("Agent Web");
		expect(sent[0]?.body).toBe("会话");
	});

	it("projectNameOf 取最后一段，忽略尾部斜杠", () => {
		expect(projectNameOf("/a/b/c/")).toBe("c");
		expect(projectNameOf("")).toBe("Agent Web");
		expect(projectNameOf(undefined)).toBe("Agent Web");
	});
});
