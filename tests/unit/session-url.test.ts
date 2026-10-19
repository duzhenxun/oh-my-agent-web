/**
 * 会话与地址栏同步：解析 ?session= 与生成新地址（纯函数）。
 */
import { describe, expect, it } from "vitest";
import { sessionIdFromUrl, sessionUrlFor } from "../../web/src/session-url.ts";

describe("sessionIdFromUrl", () => {
	it("取 ?session= 的值", () => {
		expect(sessionIdFromUrl("?session=conv-abc")).toBe("conv-abc");
		expect(sessionIdFromUrl("?foo=1&session=conv-xyz")).toBe("conv-xyz");
	});

	it("没有 / 空白都返回 null", () => {
		expect(sessionIdFromUrl("")).toBeNull();
		expect(sessionIdFromUrl("?session=")).toBeNull();
		expect(sessionIdFromUrl("?session=%20%20")).toBeNull();
	});
});

describe("sessionUrlFor", () => {
	it("写入 session，保留其它参数与 hash", () => {
		expect(sessionUrlFor("http://127.0.0.1:5174/?foo=1#top", "conv-1")).toBe("/?foo=1&session=conv-1#top");
	});

	it("传 null 时删除 session", () => {
		expect(sessionUrlFor("http://127.0.0.1:5174/?session=conv-1&foo=1", null)).toBe("/?foo=1");
	});
});
