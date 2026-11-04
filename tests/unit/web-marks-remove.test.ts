/**
 * 对话框里删掉一条网页注释 → 页面上的编号框也要删（`web-marks.ts` 的 `removeMarkAt`）。
 *
 * 锁三件事：
 *   1. 只删同一页 + 同一选择器的那一处，别的页、别的处不动；
 *   2. 删掉中间一号，其余的号**不重排**（3 号还是 3 号）；
 *   3. 删掉之后再标一处，号接着最大号排（不会复用刚删掉的号以外的错号）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { addWebMark, nextNumberFor, removeMarkAt, type PageMark } from "../../web/src/web-marks.ts";

const page = "https://example.com/a";
const other = "https://example.com/b";

function seed(): PageMark[] {
	let marks: PageMark[] = [];
	marks = addWebMark(marks, { url: page, selector: "#one", comment: "a" }, 1);
	marks = addWebMark(marks, { url: page, selector: "#two", comment: "b" }, 2);
	marks = addWebMark(marks, { url: page, selector: "#three", comment: "c" }, 3);
	marks = addWebMark(marks, { url: other, selector: "#two", comment: "x" }, 4);
	return marks;
}

describe("删除一处网页标记", () => {
	it("只删同一页 + 同一选择器那一处", () => {
		const next = removeMarkAt(seed(), page, "#two");
		assert.equal(next.length, 3);
		assert.ok(!next.some((mark) => mark.url === page && mark.selector === "#two"));
		// 另一页上同名选择器的那一处不能被误删
		assert.ok(next.some((mark) => mark.url === other && mark.selector === "#two"));
	});

	it("中间的号删了，其余的号不重排", () => {
		const next = removeMarkAt(seed(), page, "#two");
		const numbers = next.filter((mark) => mark.url === page).map((mark) => mark.number);
		assert.deepEqual(numbers, [1, 3]);
	});

	it("删掉的是最大号时，下一个号接在剩下的最大号后面", () => {
		const next = removeMarkAt(seed(), page, "#three");
		assert.equal(nextNumberFor(next, page), 3);
	});

	it("删一个不存在的位置是空操作", () => {
		const before = seed();
		assert.deepEqual(removeMarkAt(before, page, "#nope"), before);
	});
});
