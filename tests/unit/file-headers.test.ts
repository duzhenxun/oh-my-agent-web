/**
 * 「回字节」接口的公共响应头（`server/http/file-headers.ts`，ADR-0034）。
 *
 * 要守住的是两件不同的事，测试也按这两条线写：
 *   1. **顶层导航**：地址栏/新标签页直接打开 `/api/files/raw?path=/tmp/x.html` 时，
 *      它不能变成一张能调 `/api` 的同源页面 → 必须转成下载；
 *   2. **页面内嵌**：html 报告走 iframe（DOM 已 sandbox）、图片走 `<img>`，
 *      这些照旧内联，否则预览功能就废了。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	applyFileResponseHeaders,
	attachmentHeader,
	filenameOf,
	isActiveContentMime,
	isEmbeddedRequest,
} from "../../server/http/file-headers.js";

const fakeResponse = () => {
	const headers: Record<string, string> = {};
	return {
		headers,
		setHeader: (name: string, value: string) => {
			headers[name.toLowerCase()] = value;
		},
	};
};

test("主动内容判定：html / xhtml / svg / xml 算，图片和音视频不算", () => {
	assert.equal(isActiveContentMime("text/html; charset=utf-8"), true);
	assert.equal(isActiveContentMime("application/xhtml+xml"), true);
	assert.equal(isActiveContentMime("image/svg+xml"), true);
	assert.equal(isActiveContentMime("application/xml"), true);
	assert.equal(isActiveContentMime("image/png"), false);
	assert.equal(isActiveContentMime("video/mp4"), false);
	assert.equal(isActiveContentMime("text/plain; charset=utf-8"), false);
});

test("内嵌判定：iframe/img 算内嵌；document 不算；拿不到头也不按内嵌算（宁严不宽）", () => {
	assert.equal(isEmbeddedRequest({ "sec-fetch-dest": "iframe" }), true);
	assert.equal(isEmbeddedRequest({ "sec-fetch-dest": "image" }), true);
	assert.equal(isEmbeddedRequest({ "sec-fetch-dest": "document" }), false);
	assert.equal(isEmbeddedRequest({}), false);
	assert.equal(isEmbeddedRequest({ "sec-fetch-dest": "" }), false);
});

test("顶层导航打开 html → 转下载，且带 nosniff + CSP sandbox", () => {
	const response = fakeResponse();
	const result = applyFileResponseHeaders({ "sec-fetch-dest": "document" }, response, {
		mime: "text/html; charset=utf-8",
		filename: "报告.html",
	});
	assert.equal(result.downloaded, true);
	assert.equal(response.headers["x-content-type-options"], "nosniff");
	assert.match(response.headers["content-disposition"] ?? "", /^attachment;/);
	// 非 ASCII 文件名要走 RFC 5987
	assert.match(response.headers["content-disposition"] ?? "", /filename\*=UTF-8''%E6%8A%A5%E5%91%8A\.html/);
	// filename= 那份必须是纯 ASCII：Node 的 setHeader 会拒掉非 ASCII 头值（ERR_INVALID_CHAR），
	// 这里用真响应验证过，别改成直传中文
	const plainName = /filename="([^"]*)"/.exec(response.headers["content-disposition"] ?? "")?.[1] ?? "";
	assert.match(plainName, /^[\x20-\x7e]*$/);
	assert.match(response.headers["content-security-policy"] ?? "", /sandbox/);
});

test("iframe 里打开 html（报告预览）→ 保持内联，只加 nosniff", () => {
	const response = fakeResponse();
	const result = applyFileResponseHeaders({ "sec-fetch-dest": "iframe" }, response, {
		mime: "text/html; charset=utf-8",
		filename: "报告.html",
	});
	assert.equal(result.downloaded, false);
	assert.equal(response.headers["content-disposition"], undefined);
	assert.equal(response.headers["content-security-policy"], undefined, "预览里脚本还要能跑");
	assert.equal(response.headers["x-content-type-options"], "nosniff");
});

test("普通图片：内联、不下载，但仍带 nosniff", () => {
	const response = fakeResponse();
	for (const dest of ["document", "image"]) {
		const result = applyFileResponseHeaders({ "sec-fetch-dest": dest }, response, { mime: "image/png" });
		assert.equal(result.downloaded, false);
	}
	assert.equal(response.headers["x-content-type-options"], "nosniff");
	assert.equal(response.headers["content-disposition"], undefined);
});

test("attachmentHeader 会把引号/换行压掉，避免头注入", () => {
	const header = attachmentHeader('a"b\\c\r\nd.svg');
	assert.ok(!header.includes("\n"));
	assert.ok(!header.includes("\r"));
	assert.match(header, /^attachment; filename="a_b_c__d\.svg"/);
});

test("filenameOf：取最后一段，兼容反斜杠路径和空值", () => {
	assert.equal(filenameOf("a/b/report.html"), "report.html");
	assert.equal(filenameOf("a\\b\\x.svg"), "x.svg");
	assert.equal(filenameOf(""), "file");
	assert.equal(filenameOf(".."), "file");
});
