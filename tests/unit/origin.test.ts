/**
 * HTTP / WS 的同源门禁（`server/util/origin.ts`）。
 *
 * 这些是最该有单测的一类代码：判错一个分支，要么把用户挡在门外（改个端口就打不开），
 * 要么把整台机器交给任意网页（跨站 no-cors POST 能直接起终端）。
 *
 * 用 Node 内置的 `node:test`（`npm test` 走 `node --import tsx --test`），不引入新依赖。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isAllowedHost, isAllowedOrigin, isSameOrigin, type OriginPolicy } from "../../server/util/origin.js";

const policy: OriginPolicy = { port: 25257, devPorts: [5173], extraHosts: ["192.168.1.9"] };

describe("isSameOrigin", () => {
	it("同主机同端口 → true", () => {
		assert.equal(isSameOrigin("http://127.0.0.1:25257", "127.0.0.1:25257"), true);
	});
	it("默认端口按协议补齐（https 无端口 == :443）", () => {
		assert.equal(isSameOrigin("https://example.com", "example.com:443"), true);
		assert.equal(isSameOrigin("http://example.com", "example.com:80"), true);
	});
	it("端口不同 → false", () => {
		assert.equal(isSameOrigin("http://127.0.0.1:5173", "127.0.0.1:25257"), false);
	});
	it("主机不同 → false（这就是跨站请求的形状）", () => {
		assert.equal(isSameOrigin("http://evil.example", "127.0.0.1:25257"), false);
	});
	it("IPv6 带方括号也能对上", () => {
		assert.equal(isSameOrigin("http://[::1]:25257", "[::1]:25257"), true);
	});
	it("缺任一头 / 畸形 Origin → false", () => {
		assert.equal(isSameOrigin(undefined, "127.0.0.1:25257"), false);
		assert.equal(isSameOrigin("http://127.0.0.1:25257", undefined), false);
		assert.equal(isSameOrigin("null", "127.0.0.1:25257"), false);
		assert.equal(isSameOrigin("not a url", "127.0.0.1:25257"), false);
	});
});

describe("isAllowedOrigin", () => {
	it("没有 Origin（非浏览器客户端）放行", () => {
		assert.equal(isAllowedOrigin(undefined, policy), true);
	});
	it("loopback + 白名单端口放行", () => {
		assert.equal(isAllowedOrigin("http://127.0.0.1:25257", policy), true);
		assert.equal(isAllowedOrigin("http://localhost:5173", policy), true);
	});
	it("loopback 但端口不在白名单 → 拒（防别的本机服务冒用）", () => {
		assert.equal(isAllowedOrigin("http://127.0.0.1:9999", policy), false);
	});
	it("外站域名 → 拒", () => {
		assert.equal(isAllowedOrigin("http://evil.example", policy), false);
		assert.equal(isAllowedOrigin("https://evil.example:443", policy), false);
	});
	it("显式配置的局域网 IP 放行", () => {
		assert.equal(isAllowedOrigin("http://192.168.1.9:25257", policy), true);
	});
	it("非 http(s) 协议 → 拒", () => {
		assert.equal(isAllowedOrigin("file:///etc/passwd", policy), false);
		assert.equal(isAllowedOrigin("ws://127.0.0.1:25257", policy), false);
	});
});

describe("isAllowedHost", () => {
	it("缺失时放行（老客户端 / HTTP/1.0 不带 Host）", () => {
		assert.equal(isAllowedHost(undefined, policy), true);
	});
	it("loopback 带白名单端口放行", () => {
		assert.equal(isAllowedHost("127.0.0.1:25257", policy), true);
	});
	it("陌生主机名 → 拒（DNS rebinding）", () => {
		assert.equal(isAllowedHost("attacker.example:25257", policy), false);
	});
	it("端口不在白名单 → 拒", () => {
		assert.equal(isAllowedHost("127.0.0.1:1234", policy), false);
	});
});
