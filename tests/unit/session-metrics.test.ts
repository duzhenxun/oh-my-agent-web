/**
 * 会话信息的派生指标：活跃时长格式、缓存命中率（纯函数）。
 */
import { describe, expect, it } from "vitest";
import { cacheHitRate, formatPercent, formatSpan } from "../../web/src/session-metrics.ts";

describe("formatSpan", () => {
	it("按大小选单位", () => {
		expect(formatSpan(30_000)).toBe("<1m");
		expect(formatSpan(5 * 60_000)).toBe("5m");
		expect(formatSpan(3 * 3600_000 + 12 * 60_000)).toBe("3h 12m");
		expect(formatSpan(2 * 86400_000 + 5 * 3600_000)).toBe("2d 5h");
	});

	it("非法/零值给 — 而不是 NaN", () => {
		expect(formatSpan(0)).toBe("—");
		expect(formatSpan(Number.NaN)).toBe("—");
	});
});

describe("cacheHitRate", () => {
	it("算比例；分母为 0 返回 null", () => {
		expect(cacheHitRate(1000, 3000)).toBeCloseTo(0.75);
		expect(cacheHitRate(0, 0)).toBeNull();
	});

	it("格式化：null 显示 —，其余一位小数", () => {
		expect(formatPercent(null)).toBe("—");
		expect(formatPercent(0.896)).toBe("89.6%");
	});
});
