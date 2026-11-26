/**
 * 画布「缩略态」的门槛与几何（用户 2026-11-26：「缩小到 0.4 时才只显示标题；
 * 显示标题时外面的线位置也要跟着调；0.4 以上保持原来卡片」）。
 *
 * 这条约束有两半，缺一个就出 bug：
 *   1. **门槛**：`FAR_K = 0.4`，而且是连线/预览共用的同一个常量（写死 0.7 的地方会各走各的）；
 *   2. **几何**：缩略时卡片矮了，连线端点必须换成 `FAR_NODE_HEIGHT`，
 *      且 CSS 里那张卡的高度必须**正好等于**这个常量（写 min-height 就会被内容撑高 1~2px，
 *      线看着就是「挂歪了」）。
 *
 * 所以这里读源码把两半焊在一起：以后谁改了一边没改另一边，这里先红。
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";

const view = readFileSync(new URL("../../web/src/components/CanvasView.tsx", import.meta.url), "utf8");
const css = readFileSync(new URL("../../web/src/styles/canvas.css", import.meta.url), "utf8");

function rule(source: string, selector: string): string {
	const start = source.indexOf(`\n${selector} {`);
	assert.notEqual(start, -1, `找不到 CSS 规则：${selector}`);
	const end = source.indexOf("\n}", start);
	assert.notEqual(end, -1, `规则没有结束：${selector}`);
	return source.slice(start, end);
}

describe("画布缩略态（≤0.4 只留标题）", () => {
	it("门槛是 0.4，连线不要另写一个数", () => {
		assert.match(view, /const FAR_K = 0\.4;/);
		assert.match(view, /classList\.toggle\("is-far", isFar\)/);
		// 悬停预览的开关跟着门槛走，不要写死 0.7（那样 0.4~0.7 会既显示完整卡片又弹预览）
		assert.match(view, /k >= FAR_K/);
		assert.doesNotMatch(view, /k >= 0\.7/);
	});

	it("连线端点用缩略高度，而不是量出来的完整卡片高度", () => {
		const farHeight = /const FAR_NODE_HEIGHT = (\d+);/.exec(view)?.[1];
		assert.ok(farHeight !== undefined, "找不到 FAR_NODE_HEIGHT");
		assert.match(view, /far \? FAR_NODE_HEIGHT : \(heights\[node\.id\] \?\? 84\)/);
		// 跨门槛要重渲染一次，否则 useMemo 里的连线永远吃旧高度
		assert.match(view, /\[doc, level, heights, far, posOf\]/);
	});

	it("CSS 里缩略卡的高度正好等于那个常量（不是 min-height）", () => {
		const farHeight = /const FAR_NODE_HEIGHT = (\d+);/.exec(view)?.[1];
		const block = rule(css, ".canvas-view.is-far .canvas-node");
		assert.match(block, new RegExp(`\\n\\theight: ${farHeight}px;`));
		assert.doesNotMatch(block, /min-height/, "被内容撑高就比连线端点高，线会歪");
		assert.match(block, /overflow: hidden/, "固定高度 + 长标题，必须裁掉溢出");
	});
});
