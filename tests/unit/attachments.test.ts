/**
 * 附件前端的纯函数（ADR-0020 §P3）：选文件、限制、markdown 引用。
 * 上传本身走 fetch，不在这里测（由冒烟覆盖真实路由）。
 */
import { describe, expect, it } from "vitest";
import { imagesMarkdown, MAX_ATTACHMENTS, MAX_UPLOAD_BYTES, pickUploadableFiles } from "../../web/src/attachments.ts";
import type { AttachmentRef } from "../../web/src/types.ts";

const file = (name: string, size = 100, type = "image/png") => ({ name, size, type });

describe("pickUploadableFiles", () => {
	it("正常文件全部收下", () => {
		const { accepted, rejected } = pickUploadableFiles([file("a.png"), file("b.png")], 0);
		expect(accepted.map((item) => item.name)).toEqual(["a.png", "b.png"]);
		expect(rejected).toEqual([]);
	});

	it("数量上限：算上已附加的，最多 5 个", () => {
		const { accepted, rejected } = pickUploadableFiles([file("a"), file("b"), file("c")], 4);
		expect(accepted.map((item) => item.name)).toEqual(["a"]);
		expect(rejected).toHaveLength(2);
		expect(rejected[0]).toContain("最多");
	});

	it("空文件与超限文件被拒（并说明原因）", () => {
		const { accepted, rejected } = pickUploadableFiles([file("empty", 0), file("big", MAX_UPLOAD_BYTES + 1)], 0);
		expect(accepted).toEqual([]);
		expect(rejected.join(" ")).toContain("空文件");
		expect(rejected.join(" ")).toContain("10MB");
	});

	it("正好 10MB 放行（边界是 > 才拒）", () => {
		expect(pickUploadableFiles([file("edge", MAX_UPLOAD_BYTES)], 0).accepted).toHaveLength(1);
	});

	it("上限常量与 ADR 一致", () => {
		expect(MAX_ATTACHMENTS).toBe(5);
		expect(MAX_UPLOAD_BYTES).toBe(10 * 1024 * 1024);
	});
});

describe("imagesMarkdown", () => {
	const attachment = (id: string, kind: "image" | "file", name = "x.png"): AttachmentRef => ({
		id,
		kind,
		name,
		mime: kind === "image" ? "image/png" : "text/plain",
		bytes: 10,
	});

	it("图片写成 markdown（引用走 /api/uploads，刷新后仍能显示）", () => {
		expect(imagesMarkdown([attachment("abc", "image", "截图.png")])).toContain("![截图.png](/api/uploads/abc)");
	});

	it("非图片不进正文（它们由服务端写成路径引用）", () => {
		expect(imagesMarkdown([attachment("abc", "file", "a.md")])).toBe("");
	});

	it("多张图各占一行", () => {
		const text = imagesMarkdown([attachment("a", "image"), attachment("b", "image")]);
		expect(text.split("\n").filter((line) => line.startsWith("!["))).toHaveLength(2);
	});

	it("没有图片时返回空串（不往正文里塞空行）", () => {
		expect(imagesMarkdown([])).toBe("");
	});
});
