import { describe, expect, it } from "vitest";
import { describePolicy, isAllowedHost, isAllowedOrigin } from "../../server/util/origin.js";

const policy = { port: 8790, devPorts: [5174] };

describe("Origin 校验（ADR-0006：这是挡「任意网页连本机端口」的唯一一层）", () => {
	it("放行 loopback 的自身端口与 dev 端口", () => {
		expect(isAllowedOrigin("http://127.0.0.1:8790", policy)).toBe(true);
		expect(isAllowedOrigin("http://localhost:8790", policy)).toBe(true);
		expect(isAllowedOrigin("http://127.0.0.1:5174", policy)).toBe(true);
		expect(isAllowedOrigin("https://localhost:5174", policy)).toBe(true);
	});

	it("拒绝外部站点（哪怕它指向本机端口）", () => {
		expect(isAllowedOrigin("https://evil.example.com", policy)).toBe(false);
		expect(isAllowedOrigin("http://127.0.0.1.evil.com:8790", policy)).toBe(false);
		expect(isAllowedOrigin("file://", policy)).toBe(false);
		expect(isAllowedOrigin("null", policy)).toBe(false);
	});

	it("拒绝 loopback 但端口不对的来源", () => {
		expect(isAllowedOrigin("http://127.0.0.1:9999", policy)).toBe(false);
		expect(isAllowedOrigin("http://127.0.0.1", policy)).toBe(false);
	});

	it("无 Origin 视为非浏览器客户端（测试脚本/CLI）放行", () => {
		expect(isAllowedOrigin(undefined, policy)).toBe(true);
		expect(isAllowedOrigin("", policy)).toBe(true);
	});
});

describe("Host 校验", () => {
	it("放行 loopback 与白名单端口", () => {
		expect(isAllowedHost("127.0.0.1:8790", policy)).toBe(true);
		expect(isAllowedHost("localhost:5174", policy)).toBe(true);
		expect(isAllowedHost("[::1]:8790", policy)).toBe(true);
	});

	it("拒绝非 loopback 主机（防 DNS rebinding 一类）", () => {
		expect(isAllowedHost("evil.example.com", policy)).toBe(false);
		expect(isAllowedHost("192.168.1.10:8790", policy)).toBe(false);
		expect(isAllowedHost("127.0.0.1:9999", policy)).toBe(false);
	});

	it("缺 Host 时放行（非浏览器客户端）", () => {
		expect(isAllowedHost(undefined, policy)).toBe(true);
	});
});

describe("错误信息", () => {
	it("把白名单讲清楚，连不上时不用猜", () => {
		expect(describePolicy(policy)).toContain("8790");
		expect(describePolicy(policy)).toContain("5174");
	});
});
