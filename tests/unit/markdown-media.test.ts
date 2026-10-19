/**
 * markdown 的代码/图片落界面（纯函数）：
 * 重点是图片来源白名单——不能让模型一句话让界面去任意地址拉图。
 */
import { describe, expect, it } from "vitest";
import { languageLabelOf, imageSrcOf } from "../../web/src/markdown-media.ts";
import { mimeOf } from "../../server/files/file-service.ts";

describe("imageSrcOf", () => {
	it("远程图原样放行", () => {
		expect(imageSrcOf("https://example.com/a.png")).toBe("https://example.com/a.png");
		expect(imageSrcOf("http://127.0.0.1:8790/x.png")).toBe("http://127.0.0.1:8790/x.png");
	});

	it("自己上传的图原样放行", () => {
		expect(imageSrcOf("/api/uploads/abc.png")).toBe("/api/uploads/abc.png");
	});

	it("工作区里的图片文件 → 走 /api/files/raw（服务端保证只能看当前项目）", () => {
		expect(imageSrcOf("docs/shot.png")).toBe(`/api/files/raw?path=${encodeURIComponent("docs/shot.png")}`);
		expect(imageSrcOf("./docs/shot.png")).toBe(`/api/files/raw?path=${encodeURIComponent("docs/shot.png")}`);
		expect(imageSrcOf("/Users/dds/data/ai/agent-web/a.png")).toBe(
			`/api/files/raw?path=${encodeURIComponent("/Users/dds/data/ai/agent-web/a.png")}`,
		);
		expect(imageSrcOf("file:///tmp/a.png")).toBe(`/api/files/raw?path=${encodeURIComponent("/tmp/a.png")}`);
	});

	it("脚本 / data URL 一律拦截", () => {
		expect(imageSrcOf("javascript:alert(1)")).toBeNull();
		expect(imageSrcOf("data:image/svg+xml;base64,AAAA")).toBeNull();
		expect(imageSrcOf("   ")).toBeNull();
	});
});

describe("languageLabelOf", () => {
	it("从 code 的 className 取语言", () => {
		expect(languageLabelOf("hljs language-ts")).toBe("ts");
		expect(languageLabelOf("language-bash")).toBe("bash");
		expect(languageLabelOf(undefined)).toBe("");
		expect(languageLabelOf("hljs")).toBe("");
	});
});

describe("mimeOf（只放行图片/PDF）", () => {
	it("常见图片扩展名", () => {
		expect(mimeOf("a.PNG")).toBe("image/png");
		expect(mimeOf("a.jpeg")).toBe("image/jpeg");
		expect(mimeOf("a.svg")).toBe("image/svg+xml");
		expect(mimeOf("a.webp")).toBe("image/webp");
	});

	it("非白名单一律拒绝（否则就成了任意文件下载器）", () => {
		expect(mimeOf("server/index.ts")).toBe("");
		expect(mimeOf("package.json")).toBe("");
		expect(mimeOf("noext")).toBe("");
	});
});
