/**
 * 一次性清理旧的本机界面偏好（`web/src/pref-reset.ts`）。
 *
 * 钉住三件事（用户 2026-11-24：「清空旧配置让默认生效」）：
 *   1. 我们重新定过默认值的那几组（顶栏 / 底部 / 对话窗口 / 底部顺序 / 外观尺寸）会被清掉，
 *      于是各处读到「没存过」→ 走新默认；
 *   2. **别的一律不动**：主题、语言、侧栏宽度这些跟这次默认值无关的选择必须留着；
 *   3. 只跑一次（留了标记），之后用户再改的设置不会被下一次启动又抹掉。
 */
import assert from "node:assert/strict";
import { afterEach, beforeEach, describe, it } from "node:test";
import { resetLegacyPrefsOnce } from "../../web/src/pref-reset.ts";

/** 一个够用的假 localStorage（key(i) / length 都要，清理逻辑靠它枚举） */
function fakeStorage(seed: Record<string, string>): Map<string, string> {
	const store = new Map(Object.entries(seed));
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			get length() {
				return store.size;
			},
			key: (index: number) => [...store.keys()][index] ?? null,
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		},
	});
	return store;
}

const saved = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
beforeEach(() => {
	/* 每条用例自己装一份假货 */
});
afterEach(() => {
	if (saved) Object.defineProperty(globalThis, "localStorage", saved);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("清理旧偏好", () => {
	it("顶栏 / 底部 / 对话窗口 / 顺序 / 外观尺寸都被清掉", () => {
		const store = fakeStorage({
			"agent-web.appbar.models": "0",
			"agent-web.appbar.show-label": "0",
			"agent-web.statusbar.running": "1",
			"agent-web.statusbar-order.v1": '["settings"]',
			"agent-web.composer.quick": "1",
			"agent-web.chat-width": "0",
			"agent-web.chat-font.v2": "18",
			"agent-web.appbar-scale.v2": "75",
			"agent-web.statusbar.": "1", // 前缀命中（哪怕是个怪 key）
		});
		resetLegacyPrefsOnce();
		for (const key of [...store.keys()]) {
			assert.equal(key.startsWith("agent-web.appbar."), false, `${key} 应该被清掉`);
		}
		assert.equal(store.has("agent-web.statusbar.running"), false);
		assert.equal(store.has("agent-web.statusbar-order.v1"), false);
		assert.equal(store.has("agent-web.composer.quick"), false);
		assert.equal(store.has("agent-web.chat-width"), false);
		assert.equal(store.has("agent-web.chat-font.v2"), false);
		assert.equal(store.has("agent-web.appbar-scale.v2"), false);
	});

	it("主题 / 语言 / 栏宽 / 会话折叠这些无关的选择留着", () => {
		const kept = {
			"agent-web.theme": "ink",
			"agent-web.language": "en",
			"agent-web.sidebar.width": "280",
			"agent-web.chat.processAutoCollapse": "1",
		};
		const store = fakeStorage({ ...kept, "agent-web.chat-width": "0" });
		resetLegacyPrefsOnce();
		for (const [key, value] of Object.entries(kept)) assert.equal(store.get(key), value, `${key} 不该被清`);
	});

	it("只跑一次：清完留标记，之后再存的设置不会被下一次启动抹掉", () => {
		const store = fakeStorage({ "agent-web.chat-width": "0" });
		resetLegacyPrefsOnce();
		assert.equal(store.get("agent-web.prefs-reset.v1"), "1");

		// 用户之后又调了顶栏（这次是「他自己选的」）
		store.set("agent-web.appbar.voice", "1");
		resetLegacyPrefsOnce();
		assert.equal(store.get("agent-web.appbar.voice"), "1", "标记在，第二次不该再清");
	});
});
