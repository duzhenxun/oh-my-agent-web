/**
 * 401 时「跳独立登录页」而不是「刷新 / 弹 SPA 弹框」（`web/src/auth-expiry.ts`）。
 *
 * 钉住的是用户真实报过的两个问题：
 *   1. 「打开 192.168.17.100:25257 一闪一闪的」→ 401 触发整页刷新，而开发态 `GET /` 是 Vite 给的，
 *      永远拿不到服务端登录页 → 无限重载。**所以 401 绝不能刷新页面。**
 *   2. 「用域名访问挺慢的」→ 弹框方案得先把整个 SPA 拉起来（几百个模块），走隧道几十秒；
 *      而 `/login` 是后端渲染的一张静态页。**所以 401 要直接跳到 `/login`。**
 *
 * 另一条边界：已经在 `/login` 上就不要再跳（登录页自己的请求拿到 401 时不能套娃）。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { loginPageUrl, reloadIfUnauthorized, reloadOnExpiredLogin } from "../../web/src/auth-expiry.ts";

/** 临时挂上 `location`（这两条路径只在浏览器里跑） */
async function withLocation(
	pathname: string,
	run: (state: { replaced: string[]; reloaded: number }) => Promise<void>,
): Promise<void> {
	const state = { replaced: [] as string[], reloaded: 0 };
	const globals = globalThis as unknown as Record<string, unknown>;
	const saved = { location: globals.location, fetch: globals.fetch };
	globals.location = {
		pathname,
		replace: (url: string) => {
			state.replaced.push(url);
		},
		reload: () => {
			state.reloaded += 1;
		},
	};
	try {
		await run(state);
	} finally {
		for (const [key, value] of Object.entries(saved)) {
			if (value === undefined) delete globals[key];
			else globals[key] = value;
		}
	}
}

test("401：跳到 /login，且绝不刷新页面（刷新=开发态无限重载）", async () => {
	await withLocation("/", async (state) => {
		assert.equal(reloadIfUnauthorized(401), true);
		assert.deepEqual(state.replaced, [loginPageUrl()]);
		assert.equal(state.reloaded, 0);
	});
});

test("已经在 /login 上：不再跳（否则自己套娃）", async () => {
	await withLocation("/login", async (state) => {
		assert.equal(reloadIfUnauthorized(401), true);
		assert.deepEqual(state.replaced, []);
		assert.equal(state.reloaded, 0);
	});
});

test("非 401：什么都不做（500 / 403 / 502 交给退避重连）", async () => {
	await withLocation("/", async (state) => {
		for (const status of [200, 403, 500, 502]) assert.equal(reloadIfUnauthorized(status), false);
		assert.deepEqual(state.replaced, []);
		assert.equal(state.reloaded, 0);
	});
});

test("SSE 断开后探健康接口：只有 401 才跳登录页", async () => {
	await withLocation("/", async (state) => {
		const globals = globalThis as unknown as Record<string, unknown>;
		globals.fetch = async () => ({ status: 401 });
		await reloadOnExpiredLogin();
		assert.deepEqual(state.replaced, [loginPageUrl()]);

		state.replaced.length = 0;
		globals.fetch = async () => ({ status: 503 });
		await reloadOnExpiredLogin();
		assert.deepEqual(state.replaced, []);

		// 网络层直接抛（后端正在重启）：同样不跳，等重连
		globals.fetch = async () => {
			throw new Error("ECONNREFUSED");
		};
		await reloadOnExpiredLogin();
		assert.deepEqual(state.replaced, []);
		assert.equal(state.reloaded, 0);
	});
});
