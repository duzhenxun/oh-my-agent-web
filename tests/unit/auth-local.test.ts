/**
 * 访问门禁：**只有「发给本机」的请求才算本机直连**（`server/http/auth.ts` 的 `decide`）。
 *
 * 用户的要求：「非 127.0.0.1 地址打开时，一定要输入密码」。
 *
 * 原来的判据只看 **TCP 对端地址**，于是同机反代 / 隧道（nginx、cloudflared、tailscale serve、
 * frp…）打过来的连接对端永远是 127.0.0.1 —— 用公网域名访问会被当成本机点开，**不打密码直接进**
 * （改之前实测：`curl -H 'Host: 192.168.31.112:25989' http://127.0.0.1:25989/` 返回 200）。
 *
 * 现在两者都要满足：对端是本机 **且** 请求是发给本机的（Host 是回环名）。
 */
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { describe, it } from "node:test";
import { decide, isCrossOriginRejected } from "../../server/http/auth.ts";
import { isLoopbackHostHeader, type OriginPolicy } from "../../server/util/origin.ts";

/** 登录 cookie 的值（`sha256("agent-web:" + 密码)`）——刻意在测试里重算一遍，把格式钉住 */
const cookieToken = (password: string): string => createHash("sha256").update(`agent-web:${password}`).digest("hex");

const PASSWORD = "testpass123";

describe("isLoopbackHostHeader", () => {
	it("回环名（含端口、IPv6 方括号）都算本机", () => {
		for (const host of ["127.0.0.1:25257", "localhost:25257", "localhost", "[::1]:25257", "127.0.0.5:1"]) {
			assert.equal(isLoopbackHostHeader(host), true, host);
		}
	});

	it("局域网 IP / 域名 / 隧道域名都不算本机", () => {
		for (const host of ["192.168.31.112:25257", "my-box.local:25257", "agent.example.com", "100.64.0.7:25257"]) {
			assert.equal(isLoopbackHostHeader(host), false, host);
		}
	});

	it("没有 Host 头 → 认为无法判断，按本机处理（浏览器与反代一定会带）", () => {
		assert.equal(isLoopbackHostHeader(undefined), true);
		assert.equal(isLoopbackHostHeader(""), true);
	});
});

describe("decide：本机直连的判定", () => {
	const base = { password: PASSWORD, authorization: undefined };

	it("对端本机 + Host 本机 → 放行（不用密码）", () => {
		assert.equal(decide({ ...base, remoteAddress: "127.0.0.1", host: "127.0.0.1:25257" }), "allow");
		assert.equal(decide({ ...base, remoteAddress: "::1", host: "localhost:25257" }), "allow");
	});

	it("**对端本机但 Host 是局域网 / 域名 → 必须输密码**（同机反代、隧道的漏洞）", () => {
		assert.equal(decide({ ...base, remoteAddress: "127.0.0.1", host: "192.168.31.112:25257" }), "challenge");
		assert.equal(decide({ ...base, remoteAddress: "127.0.0.1", host: "agent.example.com" }), "challenge");
	});

	it("对端是别的机器 → 必须输密码（不管 Host 写什么）", () => {
		assert.equal(decide({ ...base, remoteAddress: "192.168.31.9", host: "192.168.31.112:25257" }), "challenge");
		// 甚至自称来自本机 Host 也没用
		assert.equal(decide({ ...base, remoteAddress: "192.168.31.9", host: "127.0.0.1:25257" }), "challenge");
	});

	it("带了正确 cookie / Basic 就放行（不再要一次密码）", () => {
		const cookie = `agent-web-auth=${cookieToken(PASSWORD)}`;
		assert.equal(decide({ ...base, remoteAddress: "192.168.31.9", host: "192.168.31.112:25257", cookie }), "allow");
		assert.equal(
			decide({
				...base,
				remoteAddress: "192.168.31.9",
				host: "agent.example.com",
				authorization: `Basic ${Buffer.from(`me:${PASSWORD}`).toString("base64")}`,
			}),
			"allow",
		);
	});

	it("没设密码 + 非本机来源 → 直接拒（不是「空密码可进」）", () => {
		assert.equal(
			decide({ password: null, authorization: undefined, remoteAddress: "192.168.31.9", host: "192.168.31.112:25257" }),
			"forbid",
		);
		// 同机反代也一样：没密码就不该让域名访问进来
		assert.equal(
			decide({ password: null, authorization: undefined, remoteAddress: "127.0.0.1", host: "agent.example.com" }),
			"forbid",
		);
	});

	it("没有 Host 头的老客户端仍然按对端地址判断（本机放行 / 远程要密码）", () => {
		assert.equal(decide({ ...base, remoteAddress: "127.0.0.1" }), "allow");
		assert.equal(decide({ ...base, remoteAddress: "10.0.0.2" }), "challenge");
	});
});

/**
 * 跨源门禁只管「发给本机」：
 * 域名 / 局域网 IP 的访问已经要过密码门，不该再拿域名白名单卡一道
 * （用户的要求：「非 127.0.0.1 和域名访问不受限制，但必须先设密码」）。
 */
describe("isCrossOriginRejected：只拦发给本机的跨源请求", () => {
	const policy: OriginPolicy = { port: 25257, devPorts: [25257], extraHosts: [] };

	it("发给本机（Host 是回环）的跨源请求 → 拦（本机直连免密码 = CSRF 靶子）", () => {
		assert.equal(isCrossOriginRejected({ origin: "https://evil.example.com", host: "127.0.0.1:25257", policy }), true);
	});

	it("同源请求 → 放（页面是从这儿加载的，它的 POST 当然该能用）", () => {
		assert.equal(
			isCrossOriginRejected({ origin: "https://agent.example.com", host: "agent.example.com", policy }),
			false,
		);
		assert.equal(isCrossOriginRejected({ origin: "http://127.0.0.1:25257", host: "127.0.0.1:25257", policy }), false);
	});

	it("目标是域名 / 局域网 IP 的跨源请求 → 不拦（交给密码门，不用配 --allow-host）", () => {
		assert.equal(
			isCrossOriginRejected({ origin: "https://agent.example.com", host: "192.168.31.112:25257", policy }),
			false,
		);
		assert.equal(
			isCrossOriginRejected({ origin: "https://other.example.com", host: "agent.example.com", policy }),
			false,
		);
	});

	it("不带 Origin（curl / 脚本 / 老客户端）→ 不拦", () => {
		assert.equal(isCrossOriginRejected({ origin: undefined, host: "127.0.0.1:25257", policy }), false);
	});

	it("远程来源（local=false）→ 不拦，哪怕反代把 Host 重写成了 127.0.0.1", () => {
		// cloudflared / nginx 常见写法：proxy_set_header Host 127.0.0.1。
		// 只看 Host 的话，用自己域名访问的人会被判成「本机点开」，每一条 POST 都要去配 --allow-host ——
		// 用户 2026-10-30：不要域名白名单，只要不是本地访问就要密码。
		assert.equal(
			isCrossOriginRejected({ origin: "https://web.xs25.cn", host: "127.0.0.1:25257", policy, local: false }),
			false,
		);
		assert.equal(
			isCrossOriginRejected({ origin: "https://evil.example.com", host: "192.168.31.112:25257", policy, local: false }),
			false,
		);
	});

	it("真本机（local=true）→ 跨源照旧拦，本机自己的页面照旧放行", () => {
		assert.equal(
			isCrossOriginRejected({ origin: "https://evil.example.com", host: "127.0.0.1:25257", policy, local: true }),
			true,
		);
		assert.equal(
			isCrossOriginRejected({ origin: "http://127.0.0.1:25257", host: "127.0.0.1:25257", policy, local: true }),
			false,
		);
	});
});
