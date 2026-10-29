/**
 * stdio JSON-RPC 客户端的**生命周期**回归测试（codex / dsh 共用这一份，`server/engine/jsonrpc-stdio.ts`）。
 *
 * 这里用真子进程（`node <假引擎>.mjs`），因为要证的正是「跨进程」的那件事：
 *
 *   1. `close()` 之后重新 `ensureStarted()`，**旧进程残留的半行不能污染新进程的第一帧**。
 *      没修之前的表现：close 时 buffer 里若挂着 `{"id":99,"res`（对端刚好写了一截），
 *      重启后新进程的响应会被拼成 `{"id":99,"res{"id":2,…}` → JSON.parse 失败 →
 *      被当成「非 JSON 帧」丢掉 → 请求一直等到超时，用户看到的是「切回这个引擎就连不上」。
 *      更隐蔽的是 `onGone` 里有 `if (child !== process) return`，close 之后没人会清 buffer。
 *
 *   2. 子进程已经退出后再写 stdin，不该把整个进程带走（stdin 的 'error' 必须有人接）。
 *      没修之前的路径：EPIPE 以 'error' 事件出现在 Writable 上，没有监听 = 未捕获异常，
 *      而本仓只注册了 unhandledRejection —— 整个工作台会跟着退出。
 *
 * 假引擎刻意提供 `half` 方法：**按需**吐半行（不带换行），这样才能精确制造「buffer 里挂着半行」的状态，
 * 而不是让假引擎自己把后续帧也拼坏。
 */
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { createJsonRpcStdioClient } from "../../server/engine/jsonrpc-stdio.ts";

const FAKE_ENGINE = `
let buffer = "";
process.stdin.setEncoding("utf8");
const reply = (id, result) => process.stdout.write(JSON.stringify({ id, result }) + "\\n");
process.stdin.on("data", (chunk) => {
	buffer += chunk;
	let index;
	while ((index = buffer.indexOf("\\n")) >= 0) {
		const line = buffer.slice(0, index);
		buffer = buffer.slice(index + 1);
		const message = JSON.parse(line);
		if (message.method === "initialize") reply(message.id, { ok: true });
		else if (message.method === "die") process.exit(0); // 不回包，直接死（模拟引擎崩溃）
		else if (message.method === "ping") reply(message.id, "pong");
		else if (message.method === "half") {
			// 先回包，**再**吐半行（不带换行）：模拟「对端刚写了一半就被关掉」，
			// 顺序反了会把这次回复自己拼坏
			reply(message.id, "half");
			process.stdout.write('{"id":99,"res');
		}
	}
});
// stdin 关了就自己退，别在测试里留下活着的子进程
process.stdin.on("end", () => process.exit(0));
`;

const withFakeEngine = async (run: (bin: string, args: string[]) => Promise<void>): Promise<void> => {
	const dir = mkdtempSync(join(tmpdir(), "omaw-rpc-"));
	const script = join(dir, "fake-engine.mjs");
	writeFileSync(script, FAKE_ENGINE);
	try {
		await run(process.execPath, [script]);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
};

test("close() 之后重启：旧进程的半行不会污染新进程的第一帧", async () => {
	await withFakeEngine(async (bin, args) => {
		const client = createJsonRpcStdioClient({
			name: "fake",
			bin,
			args,
			// 给个短超时：没修的话这条会以「请求超时」失败，而不是把测试挂住
			timeoutMs: 3000,
			handshake: async (call) => ({ version: (await call("initialize")) ? "1" : null }),
		});

		await client.ensureStarted();
		assert.equal(await client.request("ping"), "pong");
		// 制造污染：buffer 里挂上 `{"id":99,"res`（没有换行，永远不会被消费）
		assert.equal(await client.request("half"), "half");

		client.close();

		// 重新拉起：新进程的第一个响应必须是**能解析的完整帧**
		await client.ensureStarted();
		assert.equal(await client.request("ping"), "pong");
		client.close();
	});
});

test("子进程自己死了：拒掉在飞请求、标记不可用，下次请求自动重拉", async () => {
	await withFakeEngine(async (bin, args) => {
		const client = createJsonRpcStdioClient({
			name: "fake",
			bin,
			args,
			timeoutMs: 3000,
			handshake: async (call) => ({ version: (await call("initialize")) ? "1" : null }),
		});
		const exits: string[] = [];
		const exited = new Promise<void>((resolve) => {
			client.onExit((error) => {
				exits.push(error.message);
				resolve();
			});
		});

		await client.ensureStarted();
		assert.equal(await client.request("ping"), "pong");

		// 引擎崩了（不回包直接 exit）：在飞请求必须被拒，不许一直挂着
		await assert.rejects(client.request("die"), /已退出|关闭|超时/);
		await exited;
		assert.equal(client.isReady(), false, "挂了就该标记成不可用");
		assert.equal(exits.length >= 1, true);

		// 「挂了就重来」：下一次请求自己把进程拉起来
		assert.equal(await client.request("ping"), "pong");
		assert.equal(client.isReady(), true);
		client.close();
	});
});
