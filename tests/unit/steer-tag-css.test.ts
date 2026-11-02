/**
 * 「已插队」标签要是**亮**的（用户 2026-11-02：「已插队 这个 tab 的颜色亮一些，现在有点暗」）。
 *
 * 现场：`.sent-tag-steer` 原来把它自己的 `--steer` 色当文字、再用 12% 透明当底 ——
 * 浅色主题那张米色底（`#f6efe3`）上压着橄榄黄（`#b28200`）的字，实测对比只有 ~3:1，
 * 看着发灰发暗。改成「亮黄实底 + 同色系深字」后对比 ≈7:1，整块也亮起来了。
 *
 * 这三条钉住的就是那个形状：底和字必须来自一对专门的 token，不许再退回「透明淡底 + 本色字」。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const read = (path: string) => readFileSync(new URL(`../../web/src/styles/${path}`, import.meta.url), "utf8");

function rule(css: string, selector: string): string {
	const start = css.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = css.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return css.slice(start, end);
}

describe("已插队标签的配色", () => {
	const base = read("base.css");
	const sentQueue = read("sent-queue.css");
	const tag = rule(sentQueue, ".sent-tag-steer");

	it("底与字是一对专门的 token（由 --steer 派生，六套主题不用各写一份）", () => {
		assert.match(base, /--steer-fill:\s*color-mix\(in srgb, var\(--steer\)/);
		assert.match(base, /--steer-ink:\s*color-mix\(in srgb, var\(--steer\)/);
	});

	it("标签用亮底 + 深字，不再把 --steer 本色当字色", () => {
		assert.match(tag, /background:\s*var\(--steer-fill\)/);
		assert.match(tag, /color:\s*var\(--steer-ink\)/);
		assert.doesNotMatch(tag, /color:\s*var\(--steer\)\s*;/, "字的颜色不能再直接是 --steer（那是深色，看着发暗）");
	});

	it("底不能是「透明淡色」——那正是发灰的根源", () => {
		assert.doesNotMatch(tag, /background:\s*color-mix\([^;]*transparent\)/);
	});
});
