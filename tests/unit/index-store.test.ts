/**
 * 会话索引（ADR-0005 §2）：可重建、原子写、坏了不致命。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { appendText, createMessage } from "../../server/snapshot/messages.js";
import { appendMessage, createTranscript } from "../../server/session/jsonl-store.js";
import {
	indexPath,
	loadOrRebuildIndex,
	parseIndex,
	readIndex,
	rebuildFromTranscripts,
	removeIndex,
	writeIndex,
} from "../../server/session/index-store.js";

let dataDir = "";

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), "agent-web-index-"));
});

afterEach(() => {
	rmSync(dataDir, { recursive: true, force: true });
});

async function seedConversation(id: string, title: string, createdAt: number) {
	await createTranscript(dataDir, { v: 1, id, workspace: "/tmp/ws", createdAt, title });
	const first = appendText(createMessage(`m-${id}-1`, "user", createdAt + 1), `第一条 ${title}`);
	const second = appendText(createMessage(`m-${id}-2`, "assistant", createdAt + 2), "收到");
	await appendMessage(dataDir, id, first);
	await appendMessage(dataDir, id, second);
}

describe("parseIndex（纯函数）", () => {
	it("解析合法索引", () => {
		const text = JSON.stringify({
			v: 1,
			conversations: [{ id: "a", title: "t", createdAt: 1, updatedAt: 2, workspace: "/w", messageCount: 3 }],
		});
		expect(parseIndex(text)).toHaveLength(1);
	});

	it("坏 JSON / 缺字段 / 不是数组都返回 null（调用方据此重建）", () => {
		expect(parseIndex("{ 坏")).toBeNull();
		expect(parseIndex('{"v":1}')).toBeNull();
		expect(parseIndex('{"v":1,"conversations":{}}')).toBeNull();
		expect(parseIndex('{"v":1,"conversations":[{"id":"a"}]}')).toBeNull();
	});
});

describe("读写与重建", () => {
	it("写索引是原子替换（不留 .tmp，也不写坏文件）", async () => {
		await writeIndex(dataDir, [{ id: "a", title: "t", createdAt: 1, updatedAt: 2, workspace: "/w", messageCount: 0 }]);
		expect(existsSync(indexPath(dataDir))).toBe(true);
		expect(existsSync(`${indexPath(dataDir)}.tmp`)).toBe(false);
		const parsed = JSON.parse(readFileSync(indexPath(dataDir), "utf8"));
		expect(parsed.v).toBe(1);
		expect(parsed.conversations).toHaveLength(1);
	});

	it("删掉索引后能从转录全量重建（含标题、时间、消息数）", async () => {
		await seedConversation("conv-1", "会话一", 1000);
		await seedConversation("conv-2", "会话二", 2000);

		const rebuilt = await rebuildFromTranscripts(dataDir);
		expect(rebuilt.map((meta) => meta.id)).toEqual(["conv-1", "conv-2"]);
		expect(rebuilt[0]).toMatchObject({ title: "会话一", messageCount: 2, createdAt: 1000, updatedAt: 1002 });
	});

	it("loadOrRebuildIndex：有索引就直接用，没索引就重建并写回", async () => {
		await seedConversation("conv-1", "会话一", 1000);

		const first = await loadOrRebuildIndex(dataDir);
		expect(first.rebuilt).toBe(true);
		expect(first.conversations).toHaveLength(1);
		expect(existsSync(indexPath(dataDir))).toBe(true);

		const second = await loadOrRebuildIndex(dataDir);
		expect(second.rebuilt).toBe(false);
		expect(second.conversations.map((meta) => meta.id)).toEqual(["conv-1"]);
	});

	it("索引被写坏时自动重建（不抛错、不丢会话）", async () => {
		await seedConversation("conv-1", "会话一", 1000);
		writeFileSync(indexPath(dataDir), "{ 这不是合法索引", "utf8");

		const result = await loadOrRebuildIndex(dataDir);
		expect(result.rebuilt).toBe(true);
		expect(result.conversations.map((meta) => meta.id)).toEqual(["conv-1"]);
	});

	it("readIndex 在文件缺失时返回 null", async () => {
		expect(await readIndex(dataDir)).toBeNull();
	});

	it("removeIndex 幂等（不存在也不报错）", async () => {
		await removeIndex(dataDir);
		await removeIndex(dataDir);
		expect(await readIndex(dataDir)).toBeNull();
	});
});
