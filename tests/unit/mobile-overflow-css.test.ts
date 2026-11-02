/**
 * 手机上不许横向跑版 / 左右晃（用户 2026-11-02：「手机版不要跑版，不要出现左右晃动的感觉」）。
 *
 * 现场：390px 宽的屏幕上，一张图的内联 `max-width: 400px` 把气泡撑出去，`.main` 于是冒出一条
 * 横向滚动条 —— 内容跟着一左一右地置。根因是**内联 max-width 盖掉了样式表里的 max-width: 100%**。
 *
 * 这里钉住三件事，防止有人把它们改回去：
 *   ① 图片的显示上限必须是 `min(用户设的上限, 100%)`（100% 那道永远在）；
 *   ② JS 不再直接把上限写成内联 max-width，而是当 CSS 变量传（`--md-img-cap`）；
 *   ③ 对话区（`.main` / 临时聊天的滚动层）自己不允许横向滚动 —— 兜住以后新出现的宽内容。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../web/src/${path}`, import.meta.url), "utf8");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = css.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return css.slice(start, end);
}

describe("手机窄屏不横向溢出", () => {
	const markdown = read("styles/markdown.css");
	const base = read("styles/base.css");
	const workPanel = read("styles/work-panel.css");
	const markdownTsx = read("components/Markdown.tsx");

	it("图片宽度上限 = min(设置的上限, 100%)，容器再窄也压得回来", () => {
		const image = rule(markdown, ".md-img");
		assert.match(image, /max-width:\s*min\(var\(--md-img-cap[^)]*\)\s*,\s*100%\)/);
	});

	it("JS 不写内联 max-width（会盖掉样式表里的 100%），只传 CSS 变量", () => {
		assert.doesNotMatch(markdownTsx, /\.style\.maxWidth\s*=/);
		assert.match(markdownTsx, /setProperty\("--md-img-cap"/);
	});

	it("对话区与临时聊天的滚动层都不横向滚动", () => {
		assert.match(rule(base, ".main"), /overflow-x:\s*hidden/);
		assert.match(rule(workPanel, ".work-chat-stream"), /overflow-x:\s*hidden/);
	});

	it("宽内容（代码块 / 表格 / mermaid）只在自己里面横滑，不把横滑链给上一层", () => {
		// 没有 overscroll-behavior-x: contain 时，手机上滑到尽头会触发 iOS 侧滑返回 / 安卓回弹
		const chat = read("styles/chat.css");
		for (const [css, selector] of [
			[chat, ".md pre"],
			[markdown, ".md table"],
			[markdown, ".mermaid-svg"],
		] as const) {
			const target = rule(css, selector);
			// `.md pre` / `.md table` 写的是 overflow-x，`.mermaid-svg` 是两轴的 overflow: auto
			assert.match(target, /overflow(-x)?:\s*auto/, `${selector} 要能自己横滑`);
			assert.match(target, /overscroll-behavior-x:\s*contain/, `${selector} 的横滑不能传给上一层`);
		}
	});
});
