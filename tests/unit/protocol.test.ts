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

describe("new_chat 可以指定项目（ADR-0021 §2）", () => {
	it("不传 payload = 继承当前会话的工作区", () => {
		expect(parseClientRequest({ id: "1", type: "new_chat" })).toEqual({ id: "1", type: "new_chat" });
	});

	it("传了 workspace 就带上（项目行上的「+」）", () => {
		expect(parseClientRequest({ id: "2", type: "new_chat", payload: { workspace: "/repo/other" } })).toEqual({
			id: "2",
			type: "new_chat",
			payload: { workspace: "/repo/other" },
		});
	});

	it("空 workspace 视为没传（回落到继承）", () => {
		expect(parseClientRequest({ id: "3", type: "new_chat", payload: { workspace: "" } })).toEqual({
			id: "3",
			type: "new_chat",
		});
	});
});

describe("set_approval_mode（P4 审批模式）", () => {
	it("接受 ask / allow", () => {
		expect(parseClientRequest({ id: "r1", type: "set_approval_mode", payload: { mode: "allow" } })).toEqual({
			id: "r1",
			type: "set_approval_mode",
			payload: { mode: "allow" },
		});
		expect(parseClientRequest({ id: "r2", type: "set_approval_mode", payload: { mode: "ask" } })?.type).toBe(
			"set_approval_mode",
		);
	});

	it("拒绝其它取值与缺字段", () => {
		expect(parseClientRequest({ id: "r3", type: "set_approval_mode", payload: { mode: "yolo" } })).toBeNull();
		expect(parseClientRequest({ id: "r4", type: "set_approval_mode", payload: {} })).toBeNull();
		expect(parseClientRequest({ id: "r5", type: "set_approval_mode" })).toBeNull();
	});
});

describe("set_thinking_level（P4 思考强度）", () => {
	it("接受合法档位", () => {
		expect(parseClientRequest({ id: "t1", type: "set_thinking_level", payload: { level: "high" } })).toEqual({
			id: "t1",
			type: "set_thinking_level",
			payload: { level: "high" },
		});
	});

	it("缺 level / 空白 → 拒绝", () => {
		expect(parseClientRequest({ id: "t2", type: "set_thinking_level", payload: {} })).toBeNull();
		expect(parseClientRequest({ id: "t3", type: "set_thinking_level", payload: { level: "  " } })).toBeNull();
	});

	it("provider 的 delete / test 也在白名单里（曾经漏掉被判 bad_payload）", () => {
		expect(parseClientRequest({ id: "t4", type: "delete_provider", payload: { provider: "acme" } })?.type).toBe(
			"delete_provider",
		);
		expect(parseClientRequest({ id: "t5", type: "test_provider", payload: { provider: "acme" } })?.type).toBe(
			"test_provider",
		);
	});
});
