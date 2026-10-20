/**
 * 访问鉴权（ADR-0031）：本机放行，其它来源必须过密码。
 *
 * 这一层的错误代价很高（要么被人随便进，要么自己进不去），所以按决策表逐条钉住。
 */
import { describe, expect, it } from "vitest";
import { decide, effectiveAddress, isLoopback, passwordFromHeader } from "../../server/http/auth.js";

describe("isLoopback", () => {
	it("IPv4 / IPv6 / v4-mapped 都算本机", () => {
		expect(isLoopback("127.0.0.1")).toBe(true);
		expect(isLoopback("127.1.2.3")).toBe(true);
		expect(isLoopback("::1")).toBe(true);
		expect(isLoopback("::ffff:127.0.0.1")).toBe(true);
	});

	it("局域网地址不算", () => {
		expect(isLoopback("192.168.1.5")).toBe(false);
		expect(isLoopback(undefined)).toBe(false);
	});
});

describe("passwordFromHeader", () => {
	it("从 Basic 头里取密码（用户名忽略）", () => {
		const value = `Basic ${Buffer.from("any:secret").toString("base64")}`;
		expect(passwordFromHeader(value)).toBe("secret");
	});

	it("不是 Basic / 格式不对 → null", () => {
		expect(passwordFromHeader(undefined)).toBeNull();
		expect(passwordFromHeader("Bearer abc")).toBeNull();
		expect(passwordFromHeader(`Basic ${Buffer.from("nocolon").toString("base64")}`)).toBeNull();
	});
});

describe("decide（决策表）", () => {
	const loopback = "127.0.0.1";
	const lan = "192.168.1.5";
	const good = `Basic ${Buffer.from("x:secret").toString("base64")}`;

	it("没设密码：本机放行，远程直接拒（不给登录框）", () => {
		expect(decide({ password: null, remoteAddress: loopback, authorization: undefined })).toBe("allow");
		expect(decide({ password: null, remoteAddress: lan, authorization: undefined })).toBe("forbid");
	});

	it("设了密码：本机仍然免密（本地开发不该被打断）", () => {
		expect(decide({ password: "secret", remoteAddress: loopback, authorization: undefined })).toBe("allow");
	});

	it("外部来源：密码对才放行", () => {
		expect(decide({ password: "secret", remoteAddress: lan, authorization: good })).toBe("allow");
		expect(decide({ password: "secret", remoteAddress: lan, authorization: undefined })).toBe("challenge");
		expect(
			decide({
				password: "secret",
				remoteAddress: lan,
				authorization: `Basic ${Buffer.from("x:wrong").toString("base64")}`,
			}),
		).toBe("challenge");
	});
});

describe("effectiveAddress（反代后的真实来源）", () => {
	it("对端是回环时，用 X-Forwarded-For 里的第一个地址", () => {
		expect(effectiveAddress("127.0.0.1", "192.168.1.9, 10.0.0.1")).toBe("192.168.1.9");
	});

	it("对端不是回环时**忽略**这个头（否则等于谁都能伪造）", () => {
		expect(effectiveAddress("192.168.1.5", "127.0.0.1")).toBe("192.168.1.5");
	});

	it("没有这个头就按原样", () => {
		expect(effectiveAddress("127.0.0.1", undefined)).toBe("127.0.0.1");
		expect(effectiveAddress("127.0.0.1", "  ")).toBe("127.0.0.1");
	});

	it("经反代来的远程请求仍然要密码", () => {
		const decision = decide({
			password: "secret",
			remoteAddress: effectiveAddress("127.0.0.1", "192.168.1.9"),
			authorization: undefined,
		});
		expect(decision).toBe("challenge");
	});
});
