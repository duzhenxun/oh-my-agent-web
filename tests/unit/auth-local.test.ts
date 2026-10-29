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
import { describe, it } from "node:test";
import { cookieToken, decide } from "../../server/http/auth.ts";
import { isLoopbackHostHeader } from "../../server/util/origin.ts";

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
