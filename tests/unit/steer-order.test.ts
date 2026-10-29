/**
 * 插队消息的**显示顺序**（`web/src/steer-order.ts`）。
 *
 * 服务端只能把插队那句话追加到这一轮末尾，而它其实是插在中间的 ——
 * 界面要在画之前把它挪到"它打断的那条助手消息"前面，否则看起来像先答后问。
 * 这里锁住四类：会挪的情况、不该挪的两种情况（正常下一轮 / 时间落在区间外）、连着插队。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { liftSteeredMessages } from "../../web/src/steer-order.ts";
import type { UiMessage } from "../../web/src/types.ts";

const user = (id: string, ts: number, steer = false): UiMessage => ({
	id,
	role: "user",
	ts,
	blocks: [{ kind: "text", text: id }],
	...(steer ? { steer: true } : {}),
});

const assistant = (id: string, ts: number, endedAt?: number): UiMessage => ({
	id,
	role: "assistant",
	ts,
	blocks: [{ kind: "text", text: id }],
	...(endedAt === undefined ? {} : { endedAt }),
});

const ids = (messages: UiMessage[]) => messages.map((message) => message.id);

describe("插队消息挪到它打断的那条助手消息前面", () => {
	it("回合结束后（助手有 endedAt）也照挪", () => {
		const list = [user("u1", 0), assistant("a1", 10, 500), user("s1", 200, true)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "s1", "a1"]);
	});

	it("那一条还在流式（没有 endedAt）时同样挪", () => {
		const list = [user("u1", 0), assistant("a1", 10), user("s1", 200, true)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "s1", "a1"]);
	});

	it("连着插两条：按到达顺序排在助手前面", () => {
		const list = [user("u1", 0), assistant("a1", 10, 600), user("s1", 200, true), user("s2", 300, true)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "s1", "s2", "a1"]);
	});
});

describe("不该动的情况", () => {
	it("普通用户消息（不是插队）：原地不动", () => {
		const list = [user("u1", 0), assistant("a1", 10, 500), user("u2", 600)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "a1", "u2"]);
	});

	it("时间落在助手消息之外（上一轮发的）：即使带 steer 标记也不挪", () => {
		const list = [user("u1", 0), assistant("a1", 10, 100), user("s1", 200, true)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "a1", "s1"]);
	});

	it("前面不是助手消息（连发两条用户消息）：不动", () => {
		const list = [user("u1", 0), user("s1", 5, true), assistant("a1", 10, 500)];
		assert.deepEqual(ids(liftSteeredMessages(list)), ["u1", "s1", "a1"]);
	});

	it("空列表 / 单条：原样返回", () => {
		assert.deepEqual(liftSteeredMessages([]), []);
		const one = [user("u1", 0)];
		assert.deepEqual(ids(liftSteeredMessages(one)), ["u1"]);
	});

	it("纯函数：不改入参", () => {
		const list = [user("u1", 0), assistant("a1", 10, 500), user("s1", 200, true)];
		const before = JSON.stringify(list);
		liftSteeredMessages(list);
		assert.equal(JSON.stringify(list), before);
	});
});
