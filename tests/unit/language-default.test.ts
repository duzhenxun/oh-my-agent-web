/**
 * 首次进入的语言（`web/src/language.ts`）：**跟浏览器首选语言走**，用户手动切过之后只认存的值。
 *
 * 钉住的三件事（用户 2026-11-02 的要求）：
 *   1. 没存过值 + 中文浏览器 → 中文（`zh` / `zh-CN` / `zh-TW` / `zh-Hans` 都算）；
 *   2. 没存过值 + 别的语言（或认不出浏览器）→ 英文（**英文是默认**）；
 *   3. 存过值 → **永远用存的值**，浏览器怎么设都不影响。
 *
 * 为什么这条要单独测：`readLanguage()` 被 `main.tsx`（决定要不要先下载英文词条表）
 * 和 `tNow()`（每一处非组件取词）调用，判错一边就会「首屏中文再整页跳一遍」或者反过来。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { detectLanguage, LANGUAGE_KEY, readLanguage } from "../../web/src/language.ts";

const navDescriptor = Object.getOwnPropertyDescriptor(globalThis, "navigator");
const storageDescriptor = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** Node 里没有 localStorage：给一个只读 getItem 的假货（writeLanguage 不在这条测试里） */
function stubStorage(value: string | null): void {
	Object.defineProperty(globalThis, "localStorage", {
		value: { getItem: (key: string) => (key === LANGUAGE_KEY ? value : null) },
		configurable: true,
		writable: true,
	});
}

/** 临时换掉 navigator.languages / language 跑一段 */
function withBrowser(languages: string[], run: () => void): void {
	Object.defineProperty(globalThis, "navigator", {
		value: { languages, language: languages[0] },
		configurable: true,
		writable: true,
	});
	try {
		run();
	} finally {
		if (navDescriptor) Object.defineProperty(globalThis, "navigator", navDescriptor);
	}
}

afterEach(() => {
	if (navDescriptor) Object.defineProperty(globalThis, "navigator", navDescriptor);
	if (storageDescriptor) Object.defineProperty(globalThis, "localStorage", storageDescriptor);
});

describe("首次进入的语言", () => {
	it("中文浏览器（各种 zh 变体）→ 中文", () => {
		for (const tag of ["zh", "zh-CN", "zh-TW", "zh-Hans", "zh-Hant-HK"]) {
			withBrowser([tag, "en-US"], () => {
				stubStorage(null);
				assert.equal(detectLanguage(), "zh", `${tag} 应该是中文`);
				assert.equal(readLanguage(), "zh", `${tag} 且没存过值 → 中文`);
			});
		}
	});

	it("非中文浏览器 → 英文", () => {
		for (const tag of ["en-US", "en", "ja-JP", "de-DE", "fr"]) {
			withBrowser([tag], () => {
				stubStorage(null);
				assert.equal(detectLanguage(), "en", `${tag} 应该是英文`);
				assert.equal(readLanguage(), "en", `${tag} 且没存过值 → 英文`);
			});
		}
	});

	it("只看首选语言：第二个是中文也不算（浏览器本身不是中文的）", () => {
		withBrowser(["en-US", "zh-CN"], () => {
			stubStorage(null);
			assert.equal(detectLanguage(), "en");
		});
	});

	it("存过值就只认存的值（用户手动设置优先）", () => {
		withBrowser(["en-US"], () => {
			stubStorage("zh");
			assert.equal(readLanguage(), "zh", "英文浏览器 + 手动选过中文 → 中文");
		});
		withBrowser(["zh-CN"], () => {
			stubStorage("en");
			assert.equal(readLanguage(), "en", "中文浏览器 + 手动选过英文 → 英文");
		});
	});

	it("存储里是脏值（旧版本 / 手改）→ 回到浏览器判断，别把用户锁死在中文", () => {
		withBrowser(["en-GB"], () => {
			stubStorage("cn");
			assert.equal(readLanguage(), "en");
		});
	});

	it("拿不到浏览器语言（测试 / 老浏览器）→ 英文兵底", () => {
		Object.defineProperty(globalThis, "navigator", { value: {}, configurable: true, writable: true });
		stubStorage(null);
		assert.equal(detectLanguage(), "en");
	});

	it("隐私模式下 localStorage 读不了也不抛错", () => {
		withBrowser(["en-US"], () => {
			Object.defineProperty(globalThis, "localStorage", {
				get() {
					throw new Error("SecurityError");
				},
				configurable: true,
			});
			assert.equal(readLanguage(), "en");
		});
	});
});
