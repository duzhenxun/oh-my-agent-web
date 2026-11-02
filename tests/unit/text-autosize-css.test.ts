/**
 * 手机上不许「有的字自己变大」（用户 2026-11-02 截图：同一个会话列表里个别标题大一圈）。
 *
 * 现场：侧栏所有会话行的字号只有一条规则（`sidebar.css` 的 `.pi-row`，标题继承它），
 * 手机视口实测每行计算值都是 14px —— 可截图上两条中英混排的窄长标题明显更大，行高也跟着高。
 *
 * 根因不在应用里：iOS Safari / WKWebView 的 **文本自动放大**（text autosizing，Android Chrome
 * 叫 font boosting）会**按文本块**自己决定撑大谁，规则跟排版无关，所以只发生在一部分块上。
 * 应用侧没有任何 `text-size-adjust` 声明 = 把决定权交给了浏览器。
 *
 * 这里钉住两件事，防止以后被顺手删掉：
 *   ① `html` 上必须声明 `text-size-adjust: 100%`（含 `-webkit-` 前缀）；
 *   ② 全站其余地方不许再出现别的值（`auto` / `none` / 百分比以外的写法），否则又是一半字大一半小。
 */
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { describe, it } from "node:test";

const STYLES_DIR = new URL("../../web/src/styles/", import.meta.url);

const read = (file: string) => readFileSync(new URL(file, STYLES_DIR), "utf8");

/** 取「选择器列表里含 `selector` 的那条规则」的声明块（base.css 里是 `html,\nbody { … }`） */
function declarationsFor(css: string, selector: string): string {
	const blocks = [...css.matchAll(/(?:^|\n)([^{}]+)\{([^{}]*)\}/g)];
	const hit = blocks.find(([, selectors]) =>
		selectors
			.split(",")
			.map((each) => each.trim())
			.includes(selector),
	);
	assert.ok(hit, `找不到选择器里含 ${selector} 的 CSS 规则`);
	return hit[2] ?? "";
}

/** 全站所有 `text-size-adjust` 声明（含 `-webkit-` 前缀）：`文件:声明` */
function allDeclarations(): { file: string; decl: string }[] {
	const out: { file: string; decl: string }[] = [];
	for (const file of readdirSync(STYLES_DIR).filter((name) => name.endsWith(".css"))) {
		for (const match of read(file).matchAll(/(-webkit-)?text-size-adjust:\s*([^;]+);/g)) {
			out.push({ file, decl: match[0].trim() });
		}
	}
	return out;
}

describe("手机端文本自动放大", () => {
	it("html 上声明了标准属性和 -webkit- 前缀两个版本", () => {
		const html = declarationsFor(read("base.css"), "html");
		// 只写标准属性：老一点儿的 iOS（WKWebView）只认 -webkit- 那个，等于没关
		assert.match(html, /(^|\n)\s*-webkit-text-size-adjust:\s*100%;/);
		assert.match(html, /(^|\n)\s*text-size-adjust:\s*100%;/);
	});

	it("值是 100%（按 CSS 的 px 渲染），不是 none / auto", () => {
		const html = declarationsFor(read("base.css"), "html");
		// `none` 语义上是「连用户缩放也不许」，`auto` 就是我们要关掉的那件事本身
		assert.doesNotMatch(html, /text-size-adjust:\s*(none|auto)/);
	});

	it("全站没有第二处写法把它改回去", () => {
		const others = allDeclarations().filter((entry) => !/:\s*100%;/.test(entry.decl));
		assert.deepEqual(
			others.map((entry) => `${entry.file}: ${entry.decl}`),
			[],
			"其它地方不许再写 text-size-adjust 的别的值",
		);
	});

	it("声明挂在全局（html）上，不是某个组件里 —— 否则只治一半的块", () => {
		const html = declarationsFor(read("base.css"), "html");
		assert.match(html, /text-size-adjust/);
		const scoped = allDeclarations().filter((entry) => {
			const css = read(entry.file);
			// 出现在 `html, body` 之外的规则里 = 治不到全局
			return !/html,\s*\nbody\s*\{[\s\S]*?text-size-adjust/.test(css);
		});
		assert.deepEqual(
			scoped.map((entry) => entry.file),
			[],
			"text-size-adjust 只该出现在 html/body 这条全局规则里",
		);
	});
});
