/**
 * 媒体 Range 解析（`server/files/file-service.ts` 的 `parseRange`）。
 *
 * 这块是纯函数，但踩过两个坑，都属于「返回值看起来正常、用起来炸」：
 *   - 空文件 + 后缀写法 `bytes=-5` → `{ start: 0, end: -1 }`，路由拿它去
 *     `createReadStream({ start, end })`，Node 会**同步**抛 ERR_OUT_OF_RANGE，
 *     而那时响应头已经发出去了，连接被直接掐断；
 *   - `bytes=999999-` 超出文件长度要按 RFC 回 416，现在退化成「当整文件发」，
 *     至少不能算出越界区间。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { parseRange } from "../../server/files/file-service.js";

test("没有 Range 头 / 语法不对 → null（按整文件发）", () => {
	assert.equal(parseRange(undefined, 100), null);
	assert.equal(parseRange("bytes=abc", 100), null);
	assert.equal(parseRange("bytes=-", 100), null);
});

test("正常区间", () => {
	assert.deepEqual(parseRange("bytes=0-9", 100), { start: 0, end: 9 });
	assert.deepEqual(parseRange("bytes=10-", 100), { start: 10, end: 99 });
	assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
});

test("起点超过文件长度（没给终点）→ null，不能算出 start > end", () => {
	assert.equal(parseRange("bytes=999999-", 100), null);
});

test("起点超过长度但显式给了终点 → 夹到最后一段（拖动到大偏移时够用，不报错）", () => {
	assert.deepEqual(parseRange("bytes=999999-1000000", 100), { start: 99, end: 99 });
});

test("倒序区间 → null", () => {
	assert.equal(parseRange("bytes=50-10", 100), null);
});

test("空文件：任何 Range 都退回整文件（end 不能是 -1）", () => {
	// 这就是那个 bug：以前返回 { start: 0, end: -1 }，createReadStream 直接抛错
	assert.equal(parseRange("bytes=-5", 0), null);
	assert.equal(parseRange("bytes=0-", 0), null);
	assert.equal(parseRange("bytes=0-0", 0), null);
});
