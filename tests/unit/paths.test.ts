import { describe, expect, it } from "vitest";
import { isPathInside, pickExisting, resolveInsideRoot, webDistCandidates } from "../../server/util/paths.js";

describe("pickExisting", () => {
	it("返回第一个存在的候选", () => {
		expect(pickExisting(["/a", "/b", "/c"], (path) => path === "/b" || path === "/c")).toBe("/b");
	});

	it("都不存在时返回 null（调用方据此降级到开发提示页）", () => {
		expect(pickExisting(["/a", "/b"], () => false)).toBeNull();
	});
});

describe("isPathInside（ADR-0006 的路径约束）", () => {
	it("根本身与子路径算在内", () => {
		expect(isPathInside("/root", "/root")).toBe(true);
		expect(isPathInside("/root", "/root/a/b.txt")).toBe(true);
		expect(isPathInside("/root/", "/root/a")).toBe(true);
	});

	it("靠字符串前缀骗不过去：/root2 不在 /root 内", () => {
		expect(isPathInside("/root", "/root2/file")).toBe(false);
	});

	it("上跳与外部路径一律不在内", () => {
		expect(isPathInside("/root", "/root/../etc/passwd")).toBe(false);
		expect(isPathInside("/root", "/etc/passwd")).toBe(false);
		expect(isPathInside("/root", "/root/../root")).toBe(true); // 归一化后回到根内
	});
});

describe("resolveInsideRoot（realpath 后才判定，防 symlink 逃逸）", () => {
	const realpathIdentity = (path: string) => path;

	it("根内路径放行", () => {
		expect(resolveInsideRoot("/root", "/root/a.txt", realpathIdentity)).toEqual({ ok: true, path: "/root/a.txt" });
	});

	it("symlink 指向根外时被拒", () => {
		// 模拟：/root/link → /etc/passwd
		const realpath = (path: string) => (path === "/root/link" ? "/etc/passwd" : path);
		const result = resolveInsideRoot("/root", "/root/link", realpath);
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.reason).toContain("越界");
	});

	it("路径不存在时宁可拒绝", () => {
		const realpath = () => {
			throw new Error("ENOENT");
		};
		const result = resolveInsideRoot("/root", "/root/nope", realpath);
		expect(result.ok).toBe(false);
	});

	it("根自己解析不了时也拒绝", () => {
		const realpath = (path: string) => {
			if (path === "/root") throw new Error("ENOENT");
			return path;
		};
		expect(resolveInsideRoot("/root", "/root/a", realpath).ok).toBe(false);
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
