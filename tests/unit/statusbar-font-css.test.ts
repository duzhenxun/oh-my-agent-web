/**
 * 底部状态栏**只能有一个字号基准**（`--statusbar-font-size`）。
 *
 * 用户 2026-10-29：「为什么这边有的字大有的字小，有时候都一样？」
 * 根因：`.statusbar` 写死 `font-size: 12px`，而栏里的「放行 / 引擎 / 模型 / 强度」用
 * `calc(var(--chat-ui-font-size) * 0.79…)` —— 同一行两套刻度。改「聊天字号」时一半字跟着变、
 * 一半不动（14px 时 11.1 vs 12、18px 时 14.3 vs 12、恰好在 18 附近两者接近 = 「有时候都一样」）。
 *
 * 所以这里钉两条：基准本身存在且被 `.statusbar` 消费；栏内文字一律写 `em`，
 * 不许再出现「自己算 `--chat-ui-font-size`」或写死 px。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (name: string) => readFileSync(new URL(`../../web/src/styles/${name}`, import.meta.url), "utf8");
const base = read("base.css");
const appbar = read("app-bar.css");
const statusbar = read("statusbar.css");
const enginePicker = read("engine-picker.css");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = css.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return css.slice(start, end);
}

describe("状态栏字号基准", () => {
	it("base.css 定义 `--statusbar-font-size`（带 clamp：栏高只有 24px）", () => {
		assert.match(base, /--statusbar-font-size:\s*clamp\(/);
	});

	it("`.statusbar` 用这个基准，而不是写死 px", () => {
		const body = rule(appbar, ".statusbar");
		assert.match(body, /font-size:\s*var\(--statusbar-font-size/);
		assert.doesNotMatch(body, /font-size:\s*\d+px/);
	});
});

describe("栏内文字一律 em（相对基准）", () => {
	const selectors = [
		".status-toggle",
		".status-toggle-icon",
		".statusbar .tool-chip",
		".statusbar .thinking-value",
		".statusbar .model-caret",
		".status-context",
	];
	it("不再各自 `calc(--chat-ui-font-size * k)`", () => {
		for (const selector of selectors) {
			assert.doesNotMatch(rule(statusbar, selector), /--chat-ui-font-size/, selector);
		}
	});

	it("也不写死 px", () => {
		for (const selector of selectors) {
			const body = rule(statusbar, selector);
			const hardcoded = /font-size:[^;]*?\d+(?:\.\d+)?px/.exec(body);
			assert.equal(hardcoded, null, `${selector} 写死了 px：${hardcoded?.[0] ?? ""}`);
		}
	});

	it("状态栏里那颗引擎胶囊同样吃基准（`1em`）", () => {
		assert.match(rule(enginePicker, ".engine-picker-in-statusbar .engine-picker-btn"), /font-size:\s*1em/);
	});
});
