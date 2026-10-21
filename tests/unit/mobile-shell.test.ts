/**
 * 「手机壳」（单栏）判定：手机 UA 或宽度 ≤400px。
 *
 * 两个都算单栏的原因：手机横屏能到 900px，只看宽度会把手机判成双栏；
 * 桌面上把窗口拖窄到 400 以内也该切单栏（和手机同一种形态）。
 */
import { describe, expect, it } from "vitest";
import { MOBILE_SHELL_MAX_WIDTH, isMobileShell, isPhoneUA } from "../../web/src/mobile-shell.ts";

const IPHONE =
	"Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1";
const ANDROID_PHONE =
	"Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Mobile Safari/537.36";
const ANDROID_TABLET =
	"Mozilla/5.0 (Linux; Android 13; SM-X700) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";
const MAC_CHROME =
	"Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/121.0.0.0 Safari/537.36";

describe("isPhoneUA", () => {
	it("手机 UA 认出来", () => {
		expect(isPhoneUA(IPHONE)).toBe(true);
		expect(isPhoneUA(ANDROID_PHONE)).toBe(true);
		expect(isPhoneUA("Mozilla/5.0 (Windows Phone 10.0; Android 6.0.1) Mobile/15E148")).toBe(true);
	});

	it("桌面 / 安卓平板 UA 不算手机", () => {
		expect(isPhoneUA(MAC_CHROME)).toBe(false);
		expect(isPhoneUA(ANDROID_TABLET)).toBe(false);
		expect(isPhoneUA("")).toBe(false);
	});
});

describe("isMobileShell", () => {
	it("手机：宽度多少都是单栏（横屏 900px 也是）", () => {
		expect(isMobileShell({ width: 430, userAgent: IPHONE })).toBe(true);
		expect(isMobileShell({ width: 900, userAgent: ANDROID_PHONE })).toBe(true);
	});

	it("桌面：只有窄到 400 以内才单栏", () => {
		expect(isMobileShell({ width: MOBILE_SHELL_MAX_WIDTH, userAgent: MAC_CHROME })).toBe(true);
		expect(isMobileShell({ width: MOBILE_SHELL_MAX_WIDTH + 1, userAgent: MAC_CHROME })).toBe(false);
	});

	it("安卓平板（UA 不算手机）走宽度判定", () => {
		expect(isMobileShell({ width: 800, userAgent: ANDROID_TABLET })).toBe(false);
		expect(isMobileShell({ width: 380, userAgent: ANDROID_TABLET })).toBe(true);
	});
});
