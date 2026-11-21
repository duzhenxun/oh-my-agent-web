/**
 * 网页诊断日志的宿主端点（`server/http/client-log-routes.ts`）。
 *
 * 这个端点把「浏览器里发生的事」写进服务端日志，所以两条底线要锁住：
 *   - 只写日志、不因为畸形输入报错（诊断通道不该自己变成故障源）；
 *   - 值一律裁剪（别让人把整段文本 / 整个快照塞进日志）。
 */
import assert from "node:assert/strict";
import { once } from "node:events";
import { createServer } from "node:http";
import { it } from "node:test";
import express from "express";
import { registerClientLogRoutes } from "../../server/http/client-log-routes.js";
import { createLogger } from "../../server/util/log.js";

async function startApp() {
	const lines: string[] = [];
	const logger = createLogger({
		level: "debug",
		sink: (line) => lines.push(line),
	});
	const app = express();
	app.use(express.json());
	registerClientLogRoutes(app, logger);
	const server = createServer(app);
	server.listen(0, "127.0.0.1");
	await once(server, "listening");
	const address = server.address();
	if (!address || typeof address === "string") throw new Error("拿不到端口");
	return {
		lines,
		post: async (body: unknown) => {
			const response = await fetch(`http://127.0.0.1:${address.port}/api/client-log`, {
				method: "POST",
				headers: { "Content-Type": "application/json" },
				body: JSON.stringify(body),
			});
			return { status: response.status, json: (await response.json()) as { ok?: boolean } };
		},
		close: () => server.close(),
	};
}

it("把事件写进日志，scope 标成 web", async (t) => {
	const app = await startApp();
	t.after(app.close);
	const result = await app.post({ event: "status", detail: { from: "idle", to: "listening" } });
	assert.equal(result.status, 200);
	assert.deepEqual(result.json, { ok: true });
	const entry = JSON.parse(app.lines.at(-1)!);
	assert.equal(entry.scope, "app.web");
	assert.equal(entry.msg, "status");
	assert.deepEqual(entry.ctx, { from: "idle", to: "listening" });
});

it("长字符串和过多字段会被裁剪", async (t) => {
	const app = await startApp();
	t.after(app.close);
	const detail: Record<string, unknown> = { text: "字".repeat(500) };
	for (let index = 0; index < 20; index += 1) detail[`k${index}`] = index;
	await app.post({ event: "text:local", detail });
	const entry = JSON.parse(app.lines.at(-1)!);
	assert.ok(entry.ctx.text.length <= 161, "长文本没被截断");
	assert.ok(Object.keys(entry.ctx).length <= 12, "字段数没被限制");
	assert.equal(entry.ctx.k0, 0);
});

it("没有 event 的请求照常 200，但不写日志", async (t) => {
	const app = await startApp();
	t.after(app.close);
	const before = app.lines.length;
	const result = await app.post({ detail: { a: 1 } });
	assert.equal(result.status, 200);
	assert.equal(app.lines.length, before);
});
