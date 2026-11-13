/**
 * 同一条错误在对话里**只留一条**（用户 2026-11-13：「这种出来一条提示就行，不用这么多」）。
 *
 * 缘起：一次连接抖动会被重试好几跳（pi 自己重试 + 宿主补试），每一跳失败都发一次
 * `error` 事件、追加一个错误块 —— 屏幕上于是摞出四条一模一样的 `Connection error.`。
 *
 * 两条契约分开测：
 *   1. `appendError`（服务端）：同 code + 同 message **就地合并**，次数累进 `count`，块数不涨；
 *   2. `buildTurnSegments`（前端）：历史里已经堆着的旧数据（可能被思考 / 工具隔开）也合一条，
 *      次数相加，位置落在**最后一次**出现的地方。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { appendError } from "../../server/snapshot/messages.ts";
import type { UiMessage } from "../../server/protocol.ts";
import { buildTurnSegments } from "../../web/src/turn-segments.ts";

const base: UiMessage = { id: "m1", role: "assistant", ts: 0, blocks: [] };

const errorBlock = (code: string, message: string, count?: number) => ({
	kind: "error" as const,
	code,
	message,
	...(count === undefined ? {} : { count }),
});

describe("appendError（服务端合并）", () => {
	it("同一条错误重复追加只留一个块，次数往上加", () => {
		let message = appendError(base, "engine.provider_error", "Connection error.");
		message = appendError(message, "engine.provider_error", "Connection error.");
		message = appendError(message, "engine.provider_error", "Connection error.");
		assert.equal(message.blocks.length, 1);
		const block = message.blocks[0];
		assert.ok(block && block.kind === "error");
		if (block && block.kind === "error") assert.equal(block.count, 3);
	});

	it("不同错误各留一条，互不吞掉", () => {
		let message = appendError(base, "engine.provider_error", "Connection error.");
		message = appendError(message, "engine.provider_error", "This operation was aborted");
		message = appendError(message, "engine.provider_error", "Connection error.");
		assert.equal(message.blocks.length, 2);
		const counts = message.blocks.map((block) => (block.kind === "error" ? block.count : null));
		assert.deepEqual(counts, [2, 1]);
	});

	it("不就地改别的块（只动那一条 error）", () => {
		const withText: UiMessage = { ...base, blocks: [{ kind: "text", text: "先说一句" }] };
		const message = appendError(withText, "engine.provider_error", "Connection error.");
		assert.equal(message.blocks.length, 2);
		assert.deepEqual(message.blocks[0], { kind: "text", text: "先说一句" });
	});
});

describe("buildTurnSegments（前端合并老数据）", () => {
	it("老历史里四条一模一样的错误块，合并成一条 ×4", () => {
		const message: UiMessage = {
			...base,
			blocks: [
				errorBlock("engine.provider_error", "Connection error."),
				errorBlock("engine.provider_error", "Connection error."),
				errorBlock("engine.provider_error", "Connection error."),
				errorBlock("engine.provider_error", "Connection error."),
			],
		};
		const { segments } = buildTurnSegments(message.blocks);
		const errors = segments.filter((segment) => segment.kind === "error");
		assert.equal(errors.length, 1);
		const only = errors[0];
		assert.ok(only && only.kind === "error");
		if (only && only.kind === "error") assert.equal(only.block.count, 4);
	});

	it("被思考 / 工具隔开的同一条错误也合，并落在最后一次的位置", () => {
		const message: UiMessage = {
			...base,
			blocks: [
				errorBlock("engine.provider_error", "Connection error."),
				{ kind: "thinking", text: "它又断了，再试一次" },
				errorBlock("engine.provider_error", "Connection error."),
				{ kind: "text", text: "还是不行" },
			],
		};
		const { segments } = buildTurnSegments(message.blocks);
		assert.deepEqual(
			segments.map((segment) => segment.kind),
			// 思考与它后面的工具合成一段「过程」；两条相同的错误只剩一条，落在最后一次出现的位置
			["process", "error", "text"],
		);
		const error = segments.find((segment) => segment.kind === "error");
		assert.ok(error && error.kind === "error");
		if (error && error.kind === "error") {
			assert.equal(error.block.count, 2);
			// 位置在「最后一次出现」处：正文「还是不行」排在它后面
			assert.equal(segments.at(-1)?.kind, "text");
		}
	});

	it("不同的错误不合并", () => {
		const message: UiMessage = {
			...base,
			blocks: [
				errorBlock("engine.provider_error", "Connection error."),
				errorBlock("engine.provider_error", "insufficient quota"),
			],
		};
		const { segments } = buildTurnSegments(message.blocks);
		assert.equal(segments.filter((segment) => segment.kind === "error").length, 2);
	});

	it("没有错误块时原样返回（顺序与内容都不动）", () => {
		const blocks: UiMessage["blocks"] = [
			{ kind: "thinking", text: "想一下" },
			{ kind: "text", text: "答案" },
		];
		const { segments, thinkingCount } = buildTurnSegments(blocks);
		assert.deepEqual(
			segments.map((segment) => segment.kind),
			// 思考不是独立的段：它带着自己后面的工具成一段「过程」
			["process", "text"],
		);
		assert.equal(thinkingCount, 1);
	});
});
