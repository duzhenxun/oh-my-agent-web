import { describe, expect, it } from "vitest";
import {
	parseClientRequest,
	PROTOCOL_VERSION,
	SNAPSHOT_MESSAGE_LIMIT,
	TOOL_EXCERPT_CHARS,
} from "../../server/protocol.js";

describe("parseClientRequest", () => {
	it("接受合法请求", () => {
		expect(parseClientRequest({ id: "1", type: "send_message", payload: { text: "hi" } })).toEqual({
			id: "1",
			type: "send_message",
			payload: { text: "hi" },
		});
		expect(parseClientRequest({ id: "2", type: "interrupt", payload: { conversationId: "c1" } })).not.toBeNull();
		expect(
			parseClientRequest({ id: "3", type: "approve", payload: { requestId: "a1", decision: "always" } }),
		).not.toBeNull();
		expect(parseClientRequest({ id: "4", type: "get_state" })).toEqual({ id: "4", type: "get_state" });
	});

	it("拒绝未知类型与坏载荷", () => {
		expect(parseClientRequest({ id: "1", type: "nope" })).toBeNull();
		expect(parseClientRequest({ id: "1", type: "send_message" })).toBeNull();
		expect(parseClientRequest({ id: "1", type: "send_message", payload: { text: "" } })).toBeNull();
		expect(parseClientRequest({ id: "1", type: "send_message", payload: { text: 42 } })).toBeNull();
		expect(
			parseClientRequest({ id: "1", type: "approve", payload: { requestId: "a1", decision: "maybe" } }),
		).toBeNull();
		expect(parseClientRequest({ type: "get_state" })).toBeNull();
		expect(parseClientRequest(null)).toBeNull();
		expect(parseClientRequest("hello")).toBeNull();
		expect(parseClientRequest([])).toBeNull();
	});

	it("get_state 不接受额外载荷但也不因此报错（多余字段被忽略）", () => {
		expect(parseClientRequest({ id: "9", type: "get_state", payload: { junk: true } })).toEqual({
			id: "9",
			type: "get_state",
		});
	});
});

describe("协议常量", () => {
	it("形状固定（改这些常量等于改协议，必须同步 shim 与守卫）", () => {
		expect(PROTOCOL_VERSION).toBe(1);
		expect(SNAPSHOT_MESSAGE_LIMIT).toBe(100);
		expect(TOOL_EXCERPT_CHARS).toBe(2000);
	});
});
