/**
 * 耗时那一行字（`formatDuration`）的档位契约。
 *
 * 用户 2026-11-02 报的是「耗时 123m3s 超过 60 分钟要显示小时」—— 一百多分钟写成分钟数，
 * 得自己在脑子里除 60 才知道是「两个多小时」，所以这一档必须有。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { formatDuration, formatElapsedSeconds } from "../../web/src/lib/duration-label.ts";

describe("formatDuration", () => {
	it("不到 1 秒给毫秒（工具卡那种一步几十毫秒）", () => {
		assert.equal(formatDuration(0), "0ms");
		assert.equal(formatDuration(840), "840ms");
		assert.equal(formatDuration(999), "999ms");
	});

	it("10 秒内保留一位小数，再长就给整秒", () => {
		assert.equal(formatDuration(1000), "1.0s");
		assert.equal(formatDuration(1400), "1.4s");
		assert.equal(formatDuration(9999), "10.0s");
		assert.equal(formatDuration(10_000), "10s");
		assert.equal(formatDuration(59_400), "59s");
	});

	it("1 分钟到 1 小时：`1m20s`，整分钟不带秒", () => {
		assert.equal(formatDuration(60_000), "1m");
		assert.equal(formatDuration(80_000), "1m20s");
		assert.equal(formatDuration(3_600_000 - 1000), "59m59s");
	});

	it("满 1 小时换成小时（就是用户报的那一条：123 分钟不该写成 123m3s）", () => {
		assert.equal(formatDuration(3_600_000), "1h00m");
		assert.equal(formatDuration(123 * 60_000 + 3000), "2h03m");
		assert.equal(formatDuration(3_900_000), "1h05m");
		assert.equal(formatDuration(24 * 3_600_000), "24h00m");
	});

	it("负数 / 非法值当 0（时钟回拨、缺时间戳都不该画出怪字）", () => {
		assert.equal(formatDuration(-5000), "0ms");
		assert.equal(formatDuration(Number.NaN), "0ms");
	});
});

describe("formatElapsedSeconds（走秒行：正在跑多久）", () => {
	it("1 小时内给整秒（每秒跳一格，不出小数）", () => {
		assert.equal(formatElapsedSeconds(0), "0s");
		assert.equal(formatElapsedSeconds(2), "2s");
		assert.equal(formatElapsedSeconds(42.7), "42s");
		assert.equal(formatElapsedSeconds(3599), "3599s");
	});

	it("过了 1 小时换成小时（`7203s` 跟 123m3s 是同一个毛病）", () => {
		assert.equal(formatElapsedSeconds(3600), "1h00m");
		assert.equal(formatElapsedSeconds(7383), "2h03m");
	});
});
