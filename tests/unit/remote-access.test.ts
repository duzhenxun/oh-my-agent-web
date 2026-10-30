/**
 * 「现在是不是远程访问」+ **退出远程登录**（`web/src/auth-expiry.ts`）。
 *
 * 背景（用户 2026-10-30）：「远程访问时，输入密码后可以用，但想退出如何退出呢」——
 * 服务端一直有 `POST /api/auth/logout`，但那只是端点，界面上没有入口就等于没有。
 * 这里钉住两件容易写错的事：
 *   1. 「远程」只看地址：localhost / 127.0.0.1 / ::1 是本机（免密、没有登录态），别的都算远程；
 *   2. 退出必须**打服务端**再离开页面（去 `/login`）—— 只清前端 state 的话，
 *      下一个请求照样带着那张 cookie 进去。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { isRemoteAccess, logoutRemote } from "../../web/src/auth-expiry.ts";

type Stubbed = { location?: unknown; fetch?: unknown };
const g = globalThis as unknown as Stubbed;
const original = { location: g.location, fetch: g.fetch };

function stubLocation(hostname: string): { reloads: number; replaced: string[] } {
	const state = { reloads: 0, replaced: [] as string[] };
	g.location = {
		hostname,
		host: `${hostname}:25257`,
		pathname: "/",
		replace: (url: string) => {
			state.replaced.push(url);
		},
		reload: () => {
			state.reloads += 1;
		},
	};
	return state;
}

afterEach(() => {
	g.location = original.location;
	g.fetch = original.fetch;
});

describe("isRemoteAccess", () => {
	it("本机地址：localhost / 127.0.0.1 / ::1（含 IPv6 方括号）都不算远程", () => {
		for (const hostname of ["localhost", "LOCALHOST", "127.0.0.1", "::1", "[::1]"]) {
			stubLocation(hostname);
			assert.equal(isRemoteAccess(), false, hostname);
		}
	});

	it("域名 / 隧道 / 局域网 IP 都算远程（隧道进来时地址栏写的是域名）", () => {
		for (const hostname of ["agent.xs25.cn", "192.168.1.20", "192-168-1-20.ngrok-free.app"]) {
			stubLocation(hostname);
			assert.equal(isRemoteAccess(), true, hostname);
		}
	});

	it("没有 location 的环境（单测 / 非浏览器）当成不是远程，不抛错", () => {
		g.location = undefined;
		assert.equal(isRemoteAccess(), false);
	});
});

describe("logoutRemote", () => {
	it("先打 POST /api/auth/logout，再去 /login（服务端那张独立登录页）", async () => {
		const location = stubLocation("agent.xs25.cn");
		const calls: string[] = [];
		g.fetch = async (url: string, init?: { method?: string }) => {
			calls.push(`${init?.method ?? "GET"} ${url}`);
			return { ok: true, status: 204 };
		};

		logoutRemote();
		await new Promise((done) => setTimeout(done, 0));

		assert.deepEqual(calls, ["POST /api/auth/logout"]);
		assert.deepEqual(location.replaced, ["/login"]);
		// 绝不能整页刷新：开发态 `GET /` 是 Vite 给的，刷了会无限重载
		assert.equal(location.reloads, 0);
	});

	it("服务端打不通也照样去登录页：cookie 没清掉是服务端的事，界面不能卡在「点了没反应」", async () => {
		const location = stubLocation("agent.xs25.cn");
		g.fetch = async () => {
			throw new Error("network down");
		};

		logoutRemote();
		await new Promise((done) => setTimeout(done, 0));

		assert.deepEqual(location.replaced, ["/login"]);
	});
});
