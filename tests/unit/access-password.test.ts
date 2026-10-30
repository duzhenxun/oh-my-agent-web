/**
 * 访问密码（用户 2026-10-30）：
 *   1. 密码存在数据目录的 `password` 文件里（不是系统变量），启动时给了 `-P` 也要写进去；
 *   2. 本机（127.0.0.1）可以在 设置 → 远程 里读状态 / 设 / 改，改完立即生效；
 *   3. 远程（对端不是回环，或 Host 不是回环）一律 403；
 *   4. 跨站页面（Origin 与 Host 不同源）也不能改 —— 这两个端点注册在鉴权中间件之前。
 */
import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, before, describe, it } from "node:test";
import express from "express";
import { applyStoredOptions } from "../../server/cli-config.ts";
import { registerAuthRoutes } from "../../server/http/auth-routes.ts";
import { createPasswordStore, resolveStartupPassword, writePasswordFile } from "../../server/http/password-store.ts";

const tempDirs: string[] = [];

async function tempDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "agent-web-password-"));
	tempDirs.push(dir);
	return dir;
}

after(async () => {
	await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("password 文件：存下来的那份就是「配置里的密码」", () => {
	it("writePasswordFile 落一行明文；createPasswordStore 能读回来；命令行优先", async () => {
		const dir = await tempDir();
		await writePasswordFile(join(dir, "password"), "from-cli");
		assert.equal(await readFile(join(dir, "password"), "utf8"), "from-cli\n");

		// 启动时没给 -P：读文件兜底
		const env: Record<string, string | undefined> = {};
		assert.deepEqual(await applyStoredOptions(env, dir), { password: true, allowedHosts: false });
		assert.equal(env.AGENT_WEB_PASSWORD, "from-cli");

		// 显式给的密码优先（不被文件覆盖）
		const explicit: Record<string, string | undefined> = { AGENT_WEB_PASSWORD: "typed-by-user" };
		await applyStoredOptions(explicit, dir);
		assert.equal(explicit.AGENT_WEB_PASSWORD, "typed-by-user");

		// 运行时改密码：写盘 + 立即生效
		const store = createPasswordStore("from-cli", join(dir, "password"));
		assert.equal(store.get(), "from-cli");
		await store.set("changed-at-runtime");
		assert.equal(store.get(), "changed-at-runtime");
		assert.equal(await readFile(join(dir, "password"), "utf8"), "changed-at-runtime\n");
	});

	it("没有 password 文件时不补任何东西（= 只允许本机）", async () => {
		const dir = await tempDir();
		const env: Record<string, string | undefined> = {};
		assert.deepEqual(await applyStoredOptions(env, dir), { password: false, allowedHosts: false });
		assert.equal(env.AGENT_WEB_PASSWORD, undefined);
	});
});

describe("/api/auth/password：只认本机", () => {
	let server: import("node:http").Server;
	let base = "";
	let password: string | null = null;

	before(async () => {
		const app = express();
		registerAuthRoutes(app, {
			getPassword: () => password,
			setPassword: async (next) => {
				password = next;
			},
		});
		server = app.listen(0, "127.0.0.1");
		await new Promise<void>((done) => server.once("listening", () => done()));
		const address = server.address() as AddressInfo;
		base = `http://127.0.0.1:${address.port}`;
	});

	after(async () => {
		await new Promise<void>((done) => server.close(() => done()));
	});

	it("本机：GET 状态 → POST 设密码 → 立即生效并种 cookie", async () => {
		password = null;
		const status = await fetch(`${base}/api/auth/password`);
		assert.equal(status.status, 200);
		assert.deepEqual(await status.json(), { ok: true, set: false });

		const saved = await fetch(`${base}/api/auth/password`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "newpass123" }),
		});
		assert.equal(saved.status, 200);
		assert.match(String(saved.headers.get("set-cookie")), /agent-web-auth=/);
		assert.equal(password, "newpass123");

		const again = await fetch(`${base}/api/auth/password`);
		assert.deepEqual(await again.json(), { ok: true, set: true });
	});

	it("太短 / 空密码 → 400（不改动已存的那份）", async () => {
		password = "keep-me";
		const response = await fetch(`${base}/api/auth/password`, {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ password: "  ab " }),
		});
		assert.equal(response.status, 400);
		assert.equal(password, "keep-me");
	});

	it("远程来源（X-Forwarded-For 非回环）→ 403", async () => {
		password = "keep-me";
		const response = await fetch(`${base}/api/auth/password`, {
			method: "POST",
			headers: { "content-type": "application/json", "x-forwarded-for": "203.0.113.9" },
			body: JSON.stringify({ password: "hijacked" }),
		});
		assert.equal(response.status, 403);
		assert.equal(password, "keep-me");
	});

	it("跨站页面（Origin 与 Host 不同源）→ 403", async () => {
		password = "keep-me";
		const response = await fetch(`${base}/api/auth/password`, {
			method: "POST",
			headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://evil.example.com" },
			body: "password=hijacked",
		});
		assert.equal(response.status, 403);
		assert.equal(password, "keep-me");
	});
});

describe("密码的唯一来源是 <dataDir>/password（不看 AGENT_WEB_PASSWORD）", () => {
	it("文件有值 → 用文件；环境变量给的另一个值被忽略（并标记冲突）", async () => {
		const dir = await tempDir();
		await writePasswordFile(join(dir, "password"), "from-file");
		const resolved = resolveStartupPassword(join(dir, "password"), "from-env");
		assert.deepEqual(resolved, { password: "from-file", source: "file", conflict: true });
		// 文件里那份不能被环境变量改掉
		assert.equal(await readFile(join(dir, "password"), "utf8"), "from-file\n");
	});

	it("文件不存在 + 环境变量给了 → 一次性写进文件（以后都读文件）", async () => {
		const dir = await tempDir();
		const file = join(dir, "password");
		const resolved = resolveStartupPassword(file, "from-env");
		assert.deepEqual(resolved, { password: "from-env", source: "migrated", conflict: false });
		assert.equal(await readFile(file, "utf8"), "from-env\n");
		// 0644：跟 writePasswordFile 一致（用户 2026-10-30：同机任何账户可读）
		assert.equal((await stat(file)).mode & 0o777, 0o644);
		// 第二次启动（这次没给环境变量）拿到的还是同一份
		assert.deepEqual(resolveStartupPassword(file, undefined), {
			password: "from-env",
			source: "file",
			conflict: false,
		});
	});

	it("都没有 → 没有密码（远程一律不开，和以前一致）", async () => {
		const dir = await tempDir();
		assert.deepEqual(resolveStartupPassword(join(dir, "password"), ""), {
			password: null,
			source: "none",
			conflict: false,
		});
	});
});
