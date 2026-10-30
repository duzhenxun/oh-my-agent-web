/**
 * 删除会话的两条路：**只改名**（默认）vs **真删**（`purge`）。
 *
 * 用户 2026-10-30：「这种删除是真删除吗？」—— 查出来 pi 那条路只是把
 * `xxx.jsonl` 改名成 `xxx.jsonl.deleted-<时间戳>`，磁盘上攒了 207 个、469MB。
 * 于是加了第二颗按钮「彻底删除」（A 方案），走 `unlink`。
 *
 * 这个测试把两条路的**落盘结果**钉住，免得以后谁顺手把默认那条改成真删：
 *   - 不给 `purge`（或给 false）→ 原文件不在了、`.deleted-` 那份在（可恢复）；
 *   - 给 `purge: true` → 两份都不在（不可恢复）；
 *   - 真删一个本来就不存在的文件 → 当成功（`gone`），不该报错。
 */
import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import type { EnginePort } from "../../server/engine/port.ts";
import { createSessionDeleter } from "../../server/session/delete-session.ts";
import type { PiProject } from "../../server/protocol.ts";

/** 没有原生删除能力的引擎 = pi 那条路（`deleteSession` 不实现） */
const piLikeEngine = {} as unknown as EnginePort;

let dir = "";
const pathOf = (name: string) => join(dir, name);

/** 一条假的会话文件：内容无所谓，这里只关心它在不在 */
async function makeSession(name: string): Promise<string> {
	const path = pathOf(name);
	await writeFile(path, `{"type":"session"}\n`);
	return path;
}

function deleterFor(sessionPath: string | null) {
	return createSessionDeleter({
		engine: piLikeEngine,
		projects: () =>
			[
				{
					cwd: dir,
					sessions: sessionPath === null ? [] : [{ id: "s1", sessionPath }],
				},
			] as unknown as PiProject[],
		handleOf: () => sessionPath,
		discard: () => undefined,
		refresh: async () => undefined,
		pushSnapshot: () => undefined,
	});
}

describe("删除会话：改名 vs 真删", () => {
	before(async () => {
		dir = await mkdtemp(join(tmpdir(), "agent-web-purge-"));
	});
	after(() => undefined);

	it("默认（不给 purge）：只改名，文件还在磁盘上，能从 .deleted-* 找回", async () => {
		const path = await makeSession("a.jsonl");
		const result = await deleterFor(path)("s1");
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.mode, "file");
		assert.equal(existsSync(path), false, "原路径上不该再有文件");
		const left = (await readdir(dir)).filter((name) => name.startsWith("a.jsonl.deleted-"));
		assert.equal(left.length, 1, "应该留下一份 .deleted-<时间戳>");
	});

	it("purge: true：真删，磁盘上什么都不剩", async () => {
		const path = await makeSession("b.jsonl");
		const result = await deleterFor(path)("s1", { purge: true });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.mode, "purged");
		assert.equal(existsSync(path), false);
		const left = (await readdir(dir)).filter((name) => name.startsWith("b.jsonl"));
		assert.deepEqual(left, [], "真删之后连 .deleted- 那份都不该有");
	});

	it("purge 一个本来就不在的文件：当成功（幂等），不报错", async () => {
		const path = pathOf("c.jsonl"); // 从没创建过
		const result = await deleterFor(path)("s1", { purge: true });
		assert.equal(result.ok, true);
		assert.equal(result.ok && result.mode, "gone");
	});

	it("purge 不会误伤同目录的其它会话文件", async () => {
		const keep = await makeSession("d.jsonl");
		const gone = await makeSession("e.jsonl");
		await deleterFor(gone)("s1", { purge: true });
		assert.equal(existsSync(gone), false);
		assert.equal(existsSync(keep), true, "同目录的其它会话必须原样留着");
	});
});
