/**
 * 语音设置的**变更广播**（`web/src/tts.ts` 的 `saveTtsSettings` / `onTtsSettingsChange`）。
 *
 * 为什么要它：消息尾注里那套朗读控件要跟着「设置 → 语音播报 → 启用语音播报」显隐
 * （用户 2026-11-24：「语音设置中没有启动的话，就默认不需要显示这个」），
 * 而语音设置存在本机 `localStorage`、没有服务端快照可订阅 —— 只能靠这个事件。
 *
 * 钉住：存完会广播（同页立刻生效）、取消订阅之后不再回调、坏环境（没有 window）不抛。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { DEFAULT_TTS_SETTINGS, loadTtsSettings, onTtsSettingsChange, saveTtsSettings } from "../../web/src/tts.ts";

const savedWindow = Object.getOwnPropertyDescriptor(globalThis, "window");
const savedStorage = Object.getOwnPropertyDescriptor(globalThis, "localStorage");

/** 装一套假的 window（EventTarget）+ localStorage（Map） */
function stubBrowser(): Map<string, string> {
	const store = new Map<string, string>();
	Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: new EventTarget() });
	Object.defineProperty(globalThis, "localStorage", {
		configurable: true,
		writable: true,
		value: {
			getItem: (key: string) => store.get(key) ?? null,
			setItem: (key: string, value: string) => void store.set(key, value),
			removeItem: (key: string) => void store.delete(key),
		},
	});
	return store;
}

afterEach(() => {
	if (savedWindow) Object.defineProperty(globalThis, "window", savedWindow);
	else Reflect.deleteProperty(globalThis, "window");
	if (savedStorage) Object.defineProperty(globalThis, "localStorage", savedStorage);
	else Reflect.deleteProperty(globalThis, "localStorage");
});

describe("语音设置变更广播", () => {
	it("save 之后订阅者立刻拿到新值（勾掉「启用语音播报」= 界面当场撤掉朗读控件）", () => {
		const store = stubBrowser();
		const seen: boolean[] = [];
		const off = onTtsSettingsChange((settings) => seen.push(settings.enabled));

		saveTtsSettings({ ...DEFAULT_TTS_SETTINGS, enabled: false });

		assert.deepEqual(seen, [false]);
		assert.equal(loadTtsSettings().enabled, false); // 也确实落盘了
		assert.ok(store.has("agent-web.voice.tts"));
		off();
	});

	it("取消订阅之后不再回调", () => {
		stubBrowser();
		let calls = 0;
		const off = onTtsSettingsChange(() => (calls += 1));
		off();
		saveTtsSettings({ ...DEFAULT_TTS_SETTINGS, enabled: true });
		assert.equal(calls, 0);
	});

	it("没有 window（SSR / 单测环境）时不抛，设置照样存在本机", () => {
		Reflect.deleteProperty(globalThis, "window");
		const store = stubBrowser();
		Reflect.deleteProperty(globalThis, "window"); // store 那份 window 也拿掉：只剩 localStorage
		assert.doesNotThrow(() => saveTtsSettings({ ...DEFAULT_TTS_SETTINGS, readReplies: true }));
		assert.equal(JSON.parse(store.get("agent-web.voice.tts") ?? "{}").readReplies, true);
	});
});
