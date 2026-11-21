/**
 * 「这句话说完了吗」的启发式（`web/src/sentence-complete.ts`）。
 *
 * 这条判断直接决定「半句话会不会被提前发出去」：收尾标点判反了，要么永远不发（逗号没清掉），
 * 要么照旧切句子。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { looksUnfinished } from "../../web/src/sentence-complete.ts";

describe("looksUnfinished", () => {
	it("结尾是逗号/顿号/冒号 → 还没说完", () => {
		for (const text of ["诶，为什么你刚才，", "第一点、", "比如说：", "等一下——", "然后呢；"]) {
			assert.equal(looksUnfinished(text), true, text);
		}
	});

	it("结尾是句号/问号/叹号/文字 → 说完了", () => {
		// 注意最后一条：识别结果**没有**尾标点时这里判「说完了」—— 这是已知局限，
		// 只能靠静音阈值兜住，别把它当成"一定不会切句子"。
		for (const text of ["好了。", "行吗？", "太好了！", "就这样", "诶，为什么你刚才", ""]) {
			assert.equal(looksUnfinished(text), false, text);
		}
	});

	it("尾部空白不影响判断", () => {
		assert.equal(looksUnfinished(" 然后呢，  "), true);
		assert.equal(looksUnfinished(" 然后呢。  "), false);
	});
});
