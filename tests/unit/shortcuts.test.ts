/**
 * 快捷键表：解析 / 归一化 / 匹配 / 存储清洗 / 冲突检测（`web/src/shortcuts.ts`）。
 *
 * 为什么值得单测：这张表决定「按一下会发生什么」，写错一个字符就是**静默失效**
 * （按了没反应，或者更糟：在输入框里打字母就开了新会话）。这里把三条约定钉死：
 * 必须带修饰键、同一组合只留给一个动作、存坏值 / 老数据一律回落默认。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	SHORTCUT_DEFS,
	comboFromEvent,
	dedupeShortcuts,
	defaultShortcuts,
	findConflict,
	formatCombo,
	isReservedCombo,
	normalizeCombo,
	parseCombo,
	readShortcuts,
	shortcutFor,
} from "../../web/src/shortcuts.ts";
import { sheetRows } from "../../web/src/shortcut-sheet.ts";
import type { ShortcutMap } from "../../web/src/shortcuts.ts";

/** 造一个键盘事件（只需要我们读的那几个字段） */
function key(init: { key: string; code?: string; meta?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean }) {
	return {
		key: init.key,
		code: init.code,
		metaKey: Boolean(init.meta),
		ctrlKey: Boolean(init.ctrl),
		shiftKey: Boolean(init.shift),
		altKey: Boolean(init.alt),
	};
}

/**
 * 「这条绑定会不会被这个按键命中」。
 *
 * 以前 `shortcuts.ts` 里有一个 `matchesCombo`；现在匹配的唯一事实源是
 * `comboFromEvent`（事件 → 组合串）+ 表比对（`shortcutFor`），所以这里按同一语义拼出来。
 */
function hits(combo: string | null | undefined, event: ReturnType<typeof key>, mac = true): boolean {
	const fromEvent = comboFromEvent(event, mac);
	const expected = normalizeCombo(combo);
	return fromEvent !== null && expected !== null && fromEvent === expected;
}

describe("组合键解析与归一化", () => {
	it("macOS 只认 ⌘、其它平台只认 Ctrl，两边都归一成 Mod+K", () => {
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK", meta: true }), true), "Mod+K");
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK", ctrl: true }), false), "Mod+K");
	});

	it("macOS 上的 Ctrl+K 不被抢（那是文本框里「删到行尾」）", () => {
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK", ctrl: true }), true), null);
		assert.equal(hits("Mod+K", key({ key: "k", code: "KeyK", ctrl: true }), true), false);
	});

	it("Windows 上的 Win 键不算 Mod（只认 Ctrl）", () => {
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK", meta: true }), false), null);
	});

	it("修饰键顺序不同也归一成同一个字符串", () => {
		assert.equal(normalizeCombo("Shift+Mod+K"), "Mod+Shift+K");
		assert.equal(normalizeCombo("Alt+Mod+Shift+K"), "Mod+Shift+Alt+K");
	});

	it("裸键一律不收（否则在输入框里打字就会触发动作）", () => {
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK" })), null);
		assert.equal(comboFromEvent(key({ key: "k", code: "KeyK", shift: true })), null);
		assert.equal(parseCombo("K"), null);
		assert.equal(parseCombo("Shift+K"), null);
	});

	it("只按修饰键不算按完（录制时要继续等）", () => {
		assert.equal(comboFromEvent(key({ key: "Meta", code: "MetaLeft", meta: true })), null);
		assert.equal(comboFromEvent(key({ key: "Shift", code: "ShiftLeft", shift: true, meta: true })), null);
	});

	it("标点用 code 认，Shift 不会把逗号变成小于号", () => {
		assert.equal(comboFromEvent(key({ key: "<", code: "Comma", meta: true, shift: true })), "Mod+Shift+Comma");
		assert.equal(comboFromEvent(key({ key: ",", code: "Comma", meta: true })), "Mod+Comma");
	});

	it("不认识的键（Tab / Escape / 没白名单的）不收", () => {
		assert.equal(comboFromEvent(key({ key: "Tab", code: "Tab", meta: true })), null);
		assert.equal(comboFromEvent(key({ key: "Escape", code: "Escape", meta: true })), null);
	});

	it("功能键与方向键可以绑", () => {
		assert.equal(comboFromEvent(key({ key: "F5", code: "F5" }), false), null); // 无修饰键 → 不收
		assert.equal(comboFromEvent(key({ key: "F5", code: "F5", meta: true }), true), "Mod+F5");
		assert.equal(comboFromEvent(key({ key: "ArrowRight", code: "ArrowRight", ctrl: true }), false), "Mod+ArrowRight");
	});

	it("老的坏值（未知修饰键 / 未知主键）解析成 null，不猜", () => {
		assert.equal(parseCombo("Hyper+K"), null);
		assert.equal(parseCombo("Mod+Whatever"), null);
		assert.equal(parseCombo(""), null);
		assert.equal(parseCombo(null), null);
	});
});

describe("匹配", () => {
	it("同一条绑定，两个平台各按各的主修饰键都能命中", () => {
		assert.equal(hits("Mod+K", key({ key: "k", code: "KeyK", meta: true }), true), true);
		assert.equal(hits("Mod+K", key({ key: "k", code: "KeyK", ctrl: true }), false), true);
	});

	it("多按 / 少按修饰键都不算命中", () => {
		assert.equal(hits("Mod+K", key({ key: "k", code: "KeyK", meta: true, shift: true })), false);
		assert.equal(hits("Mod+Shift+K", key({ key: "k", code: "KeyK", meta: true })), false);
		assert.equal(hits("Mod+Alt+K", key({ key: "k", code: "KeyK", meta: true })), false);
	});

	it("未设置（null）永远不命中", () => {
		assert.equal(hits(null, key({ key: "k", code: "KeyK", meta: true })), false);
	});

	it("派发器只认表里的那一条（`shortcutFor`）", () => {
		const map = { ...defaultShortcuts(), newChat: "Mod+K" } as ShortcutMap;
		assert.equal(shortcutFor(map, key({ key: "k", code: "KeyK", meta: true }), true), "newChat");
		// 没绑的键不该顺手开一个新会话
		assert.equal(shortcutFor(map, key({ key: "j", code: "KeyJ", meta: true }), true), null);
	});
});

describe("展示文案", () => {
	it("mac 用符号、其它平台用长名", () => {
		assert.equal(formatCombo("Mod+Shift+K", true), "⌘⇧K");
		assert.equal(formatCombo("Mod+Shift+K", false), "Ctrl+Shift+K");
		assert.equal(formatCombo("Mod+Alt+O", true), "⌘⌥O");
		assert.equal(formatCombo("Mod+Alt+O", false), "Ctrl+Alt+O");
	});

	it("未设置 / 坏值展示成空串（由调用方写「未设置」）", () => {
		assert.equal(formatCombo(null, true), "");
		assert.equal(formatCombo("garbage", true), "");
	});
});

describe("默认表", () => {
	it("用户点名要的两个：新会话 Mod+K、新项目 Mod+M", () => {
		const defaults = defaultShortcuts();
		assert.equal(defaults.newChat, "Mod+K");
		assert.equal(defaults.newProject, "Mod+M");
	});

	it("默认值互不重复，且没有任何一条是「裸键」或浏览器保留键", () => {
		const defaults = defaultShortcuts();
		const combos = Object.values(defaults).filter((combo): combo is string => combo !== null);
		assert.equal(new Set(combos).size, combos.length, "默认键不该自己撞自己");
		for (const combo of combos) {
			assert.ok(parseCombo(combo), `${combo} 必须带修饰键、键名在白名单里`);
			assert.equal(isReservedCombo(combo), false, `${combo} 是浏览器保留键，绑了也收不到`);
		}
	});

	it("测试里那份「默认键」常量与实际默认值一致", () => {
		// 这两个是用户点名要的，写在断言里当锁（改默认值就得来这里确认一下）
		assert.equal(defaultShortcuts().newChat, "Mod+K");
		assert.equal(defaultShortcuts().newProject, "Mod+M");
	});
});

describe("去重与冲突", () => {
	it("同一组合只留给表里靠前的动作，后来的置空", () => {
		const map = defaultShortcuts();
		map.tempChat = "Mod+K"; // 跟 newChat 撞了
		const clean = dedupeShortcuts(map);
		assert.equal(clean.newChat, "Mod+K");
		assert.equal(clean.tempChat, null);
	});

	it("浏览器保留键认得出（设置里要当场拒绝，不能让人绑完发现不生效）", () => {
		assert.equal(isReservedCombo("Mod+T"), true);
		assert.equal(isReservedCombo("Mod+W"), true);
		assert.equal(isReservedCombo("Mod+K"), false);
	});

	it("shortcutFor：事件 → 命中的动作（派发器只用它）", () => {
		const map = defaultShortcuts();
		assert.equal(shortcutFor(map, key({ key: "k", code: "KeyK", meta: true }), true), "newChat");
		assert.equal(shortcutFor(map, key({ key: "m", code: "KeyM", meta: true }), true), "newProject");
		assert.equal(shortcutFor(map, key({ key: "o", code: "KeyO", ctrl: true, alt: true }), false), "openRight");
		// 未设置的动作永远命中不了
		assert.equal(shortcutFor({ ...map, newChat: null }, key({ key: "k", code: "KeyK", meta: true }), true), null);
	});

	it("findConflict 能报出「这条组合被谁占了」，且能排除自己", () => {
		const map = defaultShortcuts();
		assert.equal(findConflict(map, "Mod+K"), "newChat");
		assert.equal(findConflict(map, "Mod+K", "newChat"), null);
		assert.equal(findConflict(map, "Mod+F9"), null);
	});
});

describe("存储清洗", () => {
	it("没配过 / 坏 JSON → 整表回落默认", () => {
		assert.deepEqual(readShortcuts(null), defaultShortcuts());
		assert.deepEqual(readShortcuts("bad json"), defaultShortcuts());
		assert.deepEqual(readShortcuts("[]"), defaultShortcuts());
	});

	it("明确的 null = 用户就是要空着，不能被默认键覆盖", () => {
		const map = readShortcuts(JSON.stringify({ newChat: null }));
		assert.equal(map.newChat, null);
		// 没写到的项仍旧拿默认值（以后新增动作不需要迁移）
		assert.equal(map.settings, defaultShortcuts().settings);
	});

	it("坏值回落该项的默认；未知动作被丢掉", () => {
		const map = readShortcuts(JSON.stringify({ newChat: "K", newProject: 42, bogus: "Mod+B" }));
		assert.equal(map.newChat, defaultShortcuts().newChat);
		assert.equal(map.newProject, defaultShortcuts().newProject);
		assert.equal(Object.hasOwn(map, "bogus"), false);
	});

	it("读回来的表也是去重过的（手改 localStorage 撞键不会两处一起响）", () => {
		const map = readShortcuts(JSON.stringify({ newChat: "Mod+K", newProject: "Mod+K", tempChat: "Mod+K" }));
		assert.equal(map.newChat, "Mod+K");
		assert.equal(map.newProject, null);
		assert.equal(map.tempChat, null);
	});

	it("每个动作都在表里有定义（防止新增动作忘了写 def）", () => {
		const map = defaultShortcuts();
		for (const def of SHORTCUT_DEFS) assert.ok(def.id in map, `${def.id} 缺行`);
	});
});

describe("速查表（浮层）", () => {
	it("按定义表顺序列全，组合键已格式化成给人看的文案", () => {
		const rows = sheetRows(defaultShortcuts(), true);
		assert.equal(rows.length, SHORTCUT_DEFS.length);
		assert.deepEqual(
			rows.map((row) => row.id),
			SHORTCUT_DEFS.map((def) => def.id),
			"顺序要跟设置面板一致",
		);
		assert.equal(rows.find((row) => row.id === "newChat")?.combo, "⌘K");
		assert.equal(rows.find((row) => row.id === "cheatSheet")?.combo, "⌘/");
	});

	it("Windows 文案用长名", () => {
		const rows = sheetRows(defaultShortcuts(), false);
		assert.equal(rows.find((row) => row.id === "newChat")?.combo, "Ctrl+K");
	});

	it("未绑定的动作照样列出来（显示成 null，由界面画「未设置」）", () => {
		const map = { ...defaultShortcuts(), terminal: null };
		const rows = sheetRows(map, true);
		assert.equal(rows.find((row) => row.id === "terminal")?.combo, null);
	});
});
