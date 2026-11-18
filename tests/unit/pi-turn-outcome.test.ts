/**
 * 「一轮到底算出错还是算完成」的判断题。
 *
 * 真事（2026-11-18，会话 d6c2333f）：模型已经给出完整总结（stopReason=stop），
 * 3ms 后迟到一条 "Connection error."，旧逻辑据此把整轮标成 error，
 * 界面只剩一条红条，答案本身却被当成失败。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isCleanAssistantEnd, turnFailed } from "../../server/engine/pi-turn-outcome.ts";

describe("isCleanAssistantEnd", () => {
	it("助手消息以 stop 结束 = 正常说完", () => {
		assert.equal(
			isCleanAssistantEnd({ type: "message_end", message: { role: "assistant", stopReason: "stop" } }),
			true,
		);
	});

	it("出错的助手消息、工具调用中间态、用户消息都不算说完", () => {
		assert.equal(
			isCleanAssistantEnd({ type: "message_end", message: { role: "assistant", stopReason: "error" } }),
			false,
		);
		assert.equal(
			isCleanAssistantEnd({ type: "message_end", message: { role: "assistant", stopReason: "toolUse" } }),
			false,
		);
		assert.equal(isCleanAssistantEnd({ type: "message_end", message: { role: "user" } }), false);
	});

	it("不是 message_end 或缺 message 时返回 false（不抛异常）", () => {
		assert.equal(isCleanAssistantEnd({ type: "message_update" }), false);
		assert.equal(isCleanAssistantEnd({ type: "message_end" }), false);
		assert.equal(isCleanAssistantEnd({ type: "message_end", message: null }), false);
	});
});

describe("turnFailed", () => {
	it("正常说完之后迟到的报错：不算失败（就是这次的 bug）", () => {
		assert.equal(turnFailed({ aborted: false, errorCount: 1, completed: true }), false);
	});

	it("没有正常说完，又有报错：算失败", () => {
		assert.equal(turnFailed({ aborted: false, errorCount: 1, completed: false }), true);
	});

	it("没有任何报错：不算失败", () => {
		assert.equal(turnFailed({ aborted: false, errorCount: 0, completed: false }), false);
		assert.equal(turnFailed({ aborted: false, errorCount: 0, completed: true }), false);
	});

	it("用户停止 / 看门狗中断：永远不算失败（它走 interrupted 分支）", () => {
		assert.equal(turnFailed({ aborted: true, errorCount: 2, completed: false }), false);
	});
});
