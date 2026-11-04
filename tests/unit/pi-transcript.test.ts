/**
 * 历史回放里「工具卡应该显示成什么状态」。
 *
 * 背景：用户报「有时莫名其妙就卡住了」，截图里是两个 bash 显示「完成」、没有任何输出，
 * 也没有下文。真相不是模型卡住，而是**服务在工具执行中途被重启**（dev 的
 * `tsx --watch` 改文件就重启 / `aw restart`）：pi 的会话文件里只落了带 toolCall 的
 * 助手消息，toolResult 那条根本没来得及写。以前这种悬空的调用默认按 `ok` 渲染，
 * 界面上就成了「跑完了，但什么也没做」——比报错更让人困惑。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { entriesToUiMessages } from "../../server/engine/pi-transcript.ts";
import { reconcileText } from "../../server/snapshot/messages.ts";
import { mapSessionEvent } from "../../server/engine/pi-events.ts";
import type { ToolBlock, UiMessage } from "../../server/protocol.ts";

const ts = 1793329130000;

function assistantWithBashCall(id: string, command: string) {
	return {
		type: "message",
		id: "entry-call",
		timestamp: ts,
		message: {
			role: "assistant",
			stopReason: "toolUse",
			timestamp: ts,
			content: [{ type: "toolCall", id, name: "bash", arguments: { command } }],
		},
	};
}

function toolResult(id: string, text: string, extra: Record<string, unknown> = {}) {
	return {
		type: "message",
		id: "entry-result",
		timestamp: ts + 1000,
		message: {
			role: "toolResult",
			toolCallId: id,
			toolName: "bash",
			timestamp: ts + 1000,
			content: [{ type: "text", text }],
			...extra,
		},
	};
}

function toolBlocks(messages: UiMessage[]): ToolBlock[] {
	return messages.flatMap((message) => message.blocks.filter((block): block is ToolBlock => block.kind === "tool"));
}

describe("pi 会话回放：工具卡状态", () => {
	it("有调用没结果（服务重启把这一轮带走了）→ failed，不是 ok、也不会一直转圈", () => {
		const blocks = toolBlocks(entriesToUiMessages([assistantWithBashCall("t1", "ls")]));
		assert.equal(blocks.length, 1);
		assert.equal(blocks[0]!.status, "failed");
		assert.equal(blocks[0]!.outputExcerpt, "");
	});

	it("同一轮里两条悬空调用都收口（截图里那种两条 bash 的情况）", () => {
		const entry = assistantWithBashCall("t1", "ls");
		const message = entry.message as Record<string, unknown>;
		message.content = [
			{ type: "toolCall", id: "t1", name: "bash", arguments: { command: "ls" } },
			{ type: "toolCall", id: "t2", name: "bash", arguments: { command: "pwd" } },
		];
		const blocks = toolBlocks(entriesToUiMessages([entry]));
		assert.deepEqual(
			blocks.map((block) => block.status),
			["failed", "failed"],
		);
	});

	it("有结果的照旧回填 ok + 输出 + 退出码", () => {
		const blocks = toolBlocks(
			entriesToUiMessages([
				assistantWithBashCall("t1", "ls"),
				toolResult("t1", "file.txt", { details: { exitCode: 0 } }),
			]),
		);
		assert.equal(blocks[0]!.status, "ok");
		assert.equal(blocks[0]!.outputExcerpt, "file.txt");
		assert.equal(blocks[0]!.exitCode, 0);
	});

	it("结果报错 → failed（跟悬空调用是两回事，别混为一谈）", () => {
		const blocks = toolBlocks(
			entriesToUiMessages([assistantWithBashCall("t1", "boom"), toolResult("t1", "炸了", { isError: true })]),
		);
		assert.equal(blocks[0]!.status, "failed");
		assert.equal(blocks[0]!.outputExcerpt, "炸了");
	});

	it("live（这一轮还在跑）→ 保持 running，不许提前判死", () => {
		const blocks = toolBlocks(entriesToUiMessages([assistantWithBashCall("t1", "ls")], { live: true }));
		assert.equal(blocks[0]!.status, "running");
	});
});

/**
 * 用户消息不能被并进助手气泡（用户 2026-11-03：「文案有问题，怎么有时候出来一个字」）。
 *
 * 历史回放要把「一轮里的多条助手消息」合成一条，但那个合并条件以前只判了
 * 「上一条是助手」，于是**用户消息**也被当成助手的一部分塞进上一条气泡：
 * 界面上自己的消息不见了，回复里却冒出几句短的、来路不明的正文。
 */
describe("历史回放：用户消息单独成条", () => {
	const userEntry = (id: string, text: string, at: number) => ({
		type: "message",
		id,
		timestamp: at,
		message: { role: "user", timestamp: at, content: [{ type: "text", text }] },
	});
	const assistantEntry = (id: string, text: string, at: number) => ({
		type: "message",
		id,
		timestamp: at,
		message: {
			role: "assistant",
			stopReason: "stop",
			timestamp: at,
			content: [{ type: "text", text }],
		},
	});

	it("助手 → 用户 → 助手：三条，用户那条是 user 气泡", () => {
		const messages = entriesToUiMessages([
			userEntry("u1", "第一个问题", ts),
			assistantEntry("a1", "第一个回答", ts + 1),
			userEntry("u2", "追问一句", ts + 2),
			assistantEntry("a2", "第二个回答", ts + 3),
		]);
		assert.deepEqual(
			messages.map((message) => message.role),
			["user", "assistant", "user", "assistant"],
		);
		// 用户那句话只出现在它自己的气泡里，没有被并进上一个回答
		const assistantTexts = messages
			.filter((message) => message.role === "assistant")
			.flatMap((message) => message.blocks.filter((block) => block.kind === "text"));
		assert.equal(
			assistantTexts.some((block) => block.kind === "text" && block.text.includes("追问一句")),
			false,
		);
	});

	it("一轮里的多条助手消息仍然合并成一条（工具轮次）", () => {
		const messages = entriesToUiMessages([
			userEntry("u1", "干活", ts),
			assistantEntry("a1", "我先看看", ts + 1),
			assistantEntry("a2", "看完了，结果是 X", ts + 2),
		]);
		assert.deepEqual(
			messages.map((message) => message.role),
			["user", "assistant"],
		);
		const texts = messages[1]!.blocks.filter((block) => block.kind === "text");
		assert.equal(texts.length, 2);
	});
});

/**
 * `text_end` 的权威全文校正（用户 2026-11-03：「怎么有时候出来一个字」）。
 *
 * 增量是尽最大努力的推送：丢一个 delta，界面就只剩半句。SDK 在 `text_end` 里给了
 * 这一段的完整内容，宿主用它把尾部正文块补全 —— 但只能「补全前缀」，不能覆盖别的正文。
 */
describe("权威正文校正 reconcileText", () => {
	const textMsg = (text: string): UiMessage => ({
		id: "m1",
		role: "assistant",
		ts,
		blocks: [{ kind: "text", text }],
	});

	it("丢了增量：一个字 → 补成整句", () => {
		const next = reconcileText(textMsg("两"), "两个候选：先看 A 再看 B。");
		const block = next.blocks[0];
		assert.equal(block?.kind === "text" && block.text, "两个候选：先看 A 再看 B。");
	});

	it("已经一致：原样返回（同一引用，不触发多余渲染）", () => {
		const message = textMsg("整句都在");
		assert.equal(reconcileText(message, "整句都在"), message);
	});

	it("尾部已比权威更长 / 内容不同：不碰", () => {
		const message = textMsg("前一段说明后一段说明");
		assert.equal(reconcileText(message, "另一段完全不同的正文"), message);
	});

	it("尾部是工具块：不越过工具块插正文", () => {
		const message: UiMessage = {
			id: "m1",
			role: "assistant",
			ts,
			blocks: [
				{ kind: "text", text: "先说一句。" },
				{
					kind: "tool",
					toolCallId: "t1",
					name: "bash",
					argsSummary: "ls",
					status: "ok",
					outputExcerpt: "",
					truncated: false,
					startedAt: ts,
				},
			],
		};
		assert.equal(reconcileText(message, "先说一句。"), message);
	});
});

describe("SDK 事件映射：text_end 是权威全文", () => {
	it("text_end → text_end（带 content）", () => {
		const mapped = mapSessionEvent({
			type: "message_update",
			message: { role: "assistant", content: [] },
			assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "两处都叫置顶" },
		});
		assert.deepEqual(mapped, { type: "text_end", text: "两处都叫置顶" });
	});

	it("空 content 不产生事件", () => {
		assert.equal(
			mapSessionEvent({
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_end", contentIndex: 0, content: "" },
			}),
			null,
		);
	});

	it("text_delta 仍然优先映射（不受 text_end 影响）", () => {
		assert.deepEqual(
			mapSessionEvent({
				type: "message_update",
				message: { role: "assistant", content: [] },
				assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: "两" },
			}),
			{ type: "text_delta", text: "两" },
		);
	});
});
