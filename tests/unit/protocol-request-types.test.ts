/**
 * 上行请求类型的白名单（回归：`remove_model` / `cancel_queued` 曾经漏在 REQUEST_TYPES 外面）。
 *
 * 症状特别隐蔽：请求发出去被当成「载荷不合法」丢掉，界面上按钮点了没反应，
 * 既没有报错也没有日志线索 —— 之前「移除」点了删不掉就是这个。
 */
import { describe, expect, it } from "vitest";
import { REQUEST_TYPES, parseClientRequest } from "../../server/protocol-parse.js";

/** 协议里定义的全部类型（新增类型时必须同时加到这里与 REQUEST_TYPES） */
const EXPECTED = [
	"send_message",
	"interrupt",
	"approve",
	"get_state",
	"new_chat",
	"switch_conversation",
	"set_settings",
	"set_model",
	"set_approval_mode",
	"list_providers",
	"upsert_provider",
	"delete_provider",
	"test_provider",
	"set_thinking_level",
	"update_model",
	"remove_model",
	"cancel_queued",
];

describe("REQUEST_TYPES 白名单", () => {
	it("一个都不能漏（漏了 = 按钮点了没反应）", () => {
		for (const type of EXPECTED) expect(REQUEST_TYPES).toContain(type);
	});

	it("白名单里没有协议之外的类型", () => {
		for (const type of REQUEST_TYPES) expect(EXPECTED).toContain(type);
	});

	it("remove_model 能被解析出来（真删过才发现它之前是坏的）", () => {
		expect(parseClientRequest({ id: "x", type: "remove_model", payload: { provider: "p", modelId: "m" } })).toEqual({
			id: "x",
			type: "remove_model",
			payload: { provider: "p", modelId: "m" },
		});
	});

	it("cancel_queued 同样能被解析", () => {
		expect(parseClientRequest({ id: "y", type: "cancel_queued", payload: { queueId: "q" } })).toEqual({
			id: "y",
			type: "cancel_queued",
			payload: { queueId: "q" },
		});
	});
});
