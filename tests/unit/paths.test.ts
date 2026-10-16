import { describe, expect, it } from "vitest";
import { pickExisting, webDistCandidates } from "../../server/util/paths.js";

describe("pickExisting", () => {
	it("返回第一个存在的候选", () => {
		expect(pickExisting(["/a", "/b", "/c"], (path) => path === "/b" || path === "/c")).toBe("/b");
	});

	it("都不存在时返回 null（调用方据此降级到开发提示页）", () => {
		expect(pickExisting(["/a", "/b"], () => false)).toBeNull();
	});
});

describe("webDistCandidates", () => {
	it("同时覆盖源码运行与编译产物运行两种布局", () => {
		// 源码：  <repo>/server/index.ts        → 上一层就是 <repo>
		// 编译后：<repo>/dist/server/index.js   → 上两层才是 <repo>
		expect(webDistCandidates("/repo/server")).toEqual(["/repo/web/dist", "/web/dist"]);
		expect(webDistCandidates("/repo/dist/server")).toEqual(["/repo/dist/web/dist", "/repo/web/dist"]);
	});

	it("第二候选能命中编译产物运行的仓库根", () => {
		expect(webDistCandidates("/repo/dist/server")[1]).toBe("/repo/web/dist");
	});
});
