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
	MIC_HOLD_DELAY_MS,
	comboFromEvent,
	dedupeShortcuts,
	defaultShortcuts,
	findConflict,
	combosMatch,
	formatCombo,
	isLoneModifierEvent,
	isReservedCombo,
	loneModifierShortcut,
	micPressResult,
	normalizeCombo,
	noteModifierKeys,
	parseCombo,
	platformCombo,
	readShortcuts,
	resetModifierSides,
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

	it("macOS 上单独的 ⌃ + 非字母键可用（⌃` 开终端），字母/数字仍不认", () => {
		assert.equal(comboFromEvent(key({ key: "`", code: "Backquote", ctrl: true }), true), "Ctrl+Backquote");
		assert.equal(comboFromEvent(key({ key: "1", code: "Digit1", ctrl: true }), true), null);
		assert.equal(comboFromEvent(key({ key: "1", code: "Digit1", ctrl: true }), false), "Mod+1");
	});

	it("Ctrl+` 在 mac 上真的能命中终端，⌘` 不会（避免跟系统「切换窗口」打抢）", () => {
		const map = { ...defaultShortcuts(), terminal: "Ctrl+Backquote" };
		const backquote = { key: "`", code: "Backquote" };
		assert.equal(shortcutFor(map, key({ ...backquote, ctrl: true }), true), "terminal");
		assert.equal(shortcutFor(map, key({ ...backquote, meta: true }), true), null);
	});

	it("非 mac 上 Ctrl 就是 Mod：两种写法指向同一个键，都能命中", () => {
		const map = { ...defaultShortcuts(), terminal: "Ctrl+Backquote" };
		assert.equal(platformCombo("Ctrl+Backquote", false), "Mod+Backquote");
		assert.equal(shortcutFor(map, key({ key: "`", code: "Backquote", ctrl: true }), false), "terminal");
		assert.equal(formatCombo("Ctrl+Backquote", false), "Ctrl+`");
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

	it("功能键与方向键可以绑（功能键单独按也算一条）", () => {
		assert.equal(comboFromEvent(key({ key: "F5", code: "F5" }), false), "F5"); // 裸功能键 = 单键绑定
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
		assert.equal(formatCombo("Ctrl+Backquote", true), "⌃`");
		assert.equal(formatCombo("Ctrl+Backquote", false), "Ctrl+`");
	});

	it("未设置 / 坏值展示成空串（由调用方写「未设置」）", () => {
		assert.equal(formatCombo(null, true), "");
		assert.equal(formatCombo("garbage", true), "");
	});
});

describe("默认表", () => {
	it("默认值 = 用户实际在用的那一套（2026-11-24 按他的设置定）", () => {
		const defaults = defaultShortcuts();
		assert.equal(defaults.newChat, "Alt+N");
		assert.equal(defaults.newProject, "Alt+M");
		assert.equal(defaults.tempChat, null);
		assert.equal(defaults.settings, "Mod+Comma");
		assert.equal(defaults.toggleRight, "Alt+R");
		assert.equal(defaults.toggleLeft, "Alt+L");
		assert.equal(defaults.projects, "Alt+X");
		assert.equal(defaults.files, "Alt+F");
		assert.equal(defaults.canvas, "Alt+B");
		assert.equal(defaults.terminal, "Ctrl+Backquote");
		assert.equal(defaults.contentSearch, "Shift+Alt+F");
		assert.equal(defaults.toggleMic, "RightMod");
		assert.equal(defaults.pauseSpeech, "Alt+P");
		assert.equal(defaults.stopSpeech, "Mod+Alt+S");
		assert.equal(defaults.cheatSheet, "Mod+Slash");
		// 对话操作（2026-11-24 加）：发送 / 排队 / 插队 / 停止
		// 排队默认不绑键：回合进行中裸 Enter 本来就是排队
		assert.equal(defaults.sendMessage, "Mod+Enter");
		assert.equal(defaults.queueMessage, null);
		assert.equal(defaults.steerMessage, "Alt+Enter");
		assert.equal(defaults.stopTurn, "Alt+S");
	});

	it("每条都有分组（设置面板按它分类），且四条对话操作在同一组", () => {
		for (const def of SHORTCUT_DEFS) {
			assert.ok(def.group, `${def.id} 缺 group`);
		}
		const chat = SHORTCUT_DEFS.filter((def) => def.group === "chat").map((def) => def.id);
		assert.deepEqual(chat, ["sendMessage", "queueMessage", "steerMessage", "stopTurn"]);
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
		// 用户在用的那一套：改默认值就得来这里确认一下
		assert.equal(defaultShortcuts().newChat, "Alt+N");
		assert.equal(defaultShortcuts().newProject, "Alt+M");
	});
});

describe("去重与冲突", () => {
	it("同一组合只留给表里靠前的动作，后来的置空", () => {
		const map = defaultShortcuts();
		map.tempChat = map.newChat; // 跟 newChat 撞了（默认 Alt+N）
		const clean = dedupeShortcuts(map);
		assert.equal(clean.newChat, "Alt+N");
		assert.equal(clean.tempChat, null);
	});

	it("浏览器保留键认得出（设置里要当场拒绝，不能让人绑完发现不生效）", () => {
		assert.equal(isReservedCombo("Mod+T"), true);
		assert.equal(isReservedCombo("Mod+W"), true);
		assert.equal(isReservedCombo("Mod+K"), false);
	});

	it("shortcutFor：事件 → 命中的动作（派发器只用它）", () => {
		const map = defaultShortcuts();
		assert.equal(shortcutFor(map, key({ key: "n", code: "KeyN", alt: true }), true), "newChat");
		assert.equal(shortcutFor(map, key({ key: "m", code: "KeyM", alt: true }), true), "newProject");
		assert.equal(shortcutFor(map, key({ key: "r", code: "KeyR", alt: true }), true), "toggleRight");
		// 未设置的动作永远命中不了
		assert.equal(shortcutFor({ ...map, newChat: null }, key({ key: "n", code: "KeyN", alt: true }), true), null);
	});

	it("findConflict 能报出「这条组合被谁占了」，且能排除自己", () => {
		const map = defaultShortcuts();
		assert.equal(findConflict(map, "Alt+N"), "newChat");
		assert.equal(findConflict(map, "Mod+Alt+N", "newChat"), null);
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

	it("合并前的旧 id（openRight / closeRight）能迁到新的 toggleRight", () => {
		// 用户曾把「打开」改成 ⌘⇧O：合并后这个绑定不能凭空丢掉
		const map = readShortcuts(JSON.stringify({ openRight: "Mod+Shift+O", closeRight: "Mod+Alt+W" }));
		assert.equal(map.toggleRight, "Mod+Shift+O");
		// 新 id 已经存在时不再看旧值（新值优先）
		const explicit = readShortcuts(JSON.stringify({ toggleRight: "Mod+Alt+J", openRight: "Mod+Shift+O" }));
		assert.equal(explicit.toggleRight, "Mod+Alt+J");
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
		assert.equal(rows.find((row) => row.id === "newChat")?.combo, "⌥N");
		assert.equal(rows.find((row) => row.id === "cheatSheet")?.combo, "⌘/");
	});

	it("Windows 文案用长名", () => {
		const rows = sheetRows(defaultShortcuts(), false);
		assert.equal(rows.find((row) => row.id === "newChat")?.combo, "Alt+N");
	});

	it("未绑定的动作照样列出来（显示成 null，由界面画「未设置」）", () => {
		const map = { ...defaultShortcuts(), terminal: null };
		const rows = sheetRows(map, true);
		assert.equal(rows.find((row) => row.id === "terminal")?.combo, null);
	});
});

describe("麦克风快捷键：轻按开关、长按说话", () => {
	it("提前松手 = 轻按（开麦后一直听着）", () => {
		assert.equal(micPressResult(80, false), "start");
		assert.equal(micPressResult(MIC_HOLD_DELAY_MS - 1, false), "start");
	});

	it("按够了阈值 = 长按（边说边听，松手时再停）", () => {
		assert.equal(micPressResult(MIC_HOLD_DELAY_MS, false), "startHold");
		assert.equal(micPressResult(MIC_HOLD_DELAY_MS + 500, false), "startHold");
	});

	it("已经在听的时候，按多久都是「关」", () => {
		assert.equal(micPressResult(50, true), "stop");
		assert.equal(micPressResult(5000, true), "stop");
	});

	it("阈值取一个「够短、又不会误判轻按」的数", () => {
		assert.ok(MIC_HOLD_DELAY_MS >= 200 && MIC_HOLD_DELAY_MS <= 600, "350ms 那一档");
	});
});

describe("左右修饰键（右 ⌘ / 右 ⌥）", () => {
	/** 每个用例自己从「什么都没按」开始，免得相互影响 */
	function fresh(): void {
		resetModifierSides();
	}

	it("按住右 ⌘ 再按 M → RightMod+M；松开右 ⌘ 后又回到 Mod+M", () => {
		fresh();
		noteModifierKeys({ code: "MetaRight", type: "keydown" }, true);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", meta: true }), true), "RightMod+M");
		noteModifierKeys({ code: "MetaRight", type: "keyup" }, true);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", meta: true }), true), "Mod+M");
	});

	it("右 ⌥ 同理；右 ⌘ + 右 ⌥ 也能同时钉住", () => {
		fresh();
		noteModifierKeys({ code: "AltRight", type: "keydown" }, true);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", alt: true }), true), "RightAlt+M");
		noteModifierKeys({ code: "MetaRight", type: "keydown" }, true);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", meta: true, alt: true }), true), "RightMod+RightAlt+M");
	});

	it("非 mac 上「右 ⌘」不算主修饰键，右 Ctrl 才算", () => {
		fresh();
		noteModifierKeys({ code: "MetaRight", type: "keydown" }, false);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", ctrl: true }), false), "Mod+M");
		noteModifierKeys({ code: "ControlRight", type: "keydown" }, false);
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", ctrl: true }), false), "RightMod+M");
	});

	it("焦点丢了要清状态（否则下次左 ⌘ 会被当成右 ⌘）", () => {
		fresh();
		noteModifierKeys({ code: "MetaRight", type: "keydown" }, true);
		resetModifierSides();
		assert.equal(comboFromEvent(key({ key: "m", code: "KeyM", meta: true }), true), "Mod+M");
	});

	it("展示文案：mac 上写成「右⌘」「右⌥」", () => {
		assert.equal(formatCombo("RightMod+M", true), "右⌘M");
		assert.equal(formatCombo("Mod+RightAlt+M", true), "⌘右⌥M");
		assert.equal(formatCombo("RightMod+RightAlt+M", true), "右⌘右⌥M");
		assert.equal(formatCombo("RightMod+M", false), "RightCtrl+M");
	});

	it("钉了右边的绑定只认右边；没钉的左右都行", () => {
		const both = parseCombo("Mod+M");
		const onlyRight = parseCombo("RightMod+M");
		assert.equal(combosMatch(both, parseCombo("Mod+M")), true);
		assert.equal(combosMatch(both, onlyRight), true);
		assert.equal(combosMatch(onlyRight, parseCombo("Mod+M")), false);
		assert.equal(combosMatch(onlyRight, onlyRight), true);
	});

	it("绑成「右 ⌘ + 右 ⌥ + M」就再也吃不到左 ⌘ + ⌥ + M", () => {
		fresh();
		const map = { ...defaultShortcuts(), toggleMic: "RightMod+RightAlt+M" };
		const press = key({ key: "m", code: "KeyM", meta: true, alt: true });
		resetModifierSides();
		assert.equal(shortcutFor(map, press, true), null);
		noteModifierKeys({ code: "MetaRight", type: "keydown" }, true);
		noteModifierKeys({ code: "AltRight", type: "keydown" }, true);
		assert.equal(shortcutFor(map, press, true), "toggleMic");
	});

	it("撞车判断：⌘M 与「右 ⌘M」算同一个键（双向）", () => {
		fresh();
		assert.equal(findConflict({ ...defaultShortcuts(), newChat: "Mod+M" }, "RightMod+M"), "newChat");
		assert.equal(findConflict({ ...defaultShortcuts(), newChat: "RightMod+M" }, "Mod+M"), "newChat");
	});

	it("去重也认左右重叠", () => {
		const map = defaultShortcuts();
		map.newChat = "Mod+M";
		map.newProject = "RightMod+M";
		const clean = dedupeShortcuts(map);
		assert.equal(clean.newChat, "Mod+M");
		assert.equal(clean.newProject, null);
	});

	it("浏览器抢键不分左右：右 ⌘+T 一样被吃掉", () => {
		assert.equal(isReservedCombo("RightMod+T"), true);
		assert.equal(isReservedCombo("RightMod+M"), false);
	});
});

describe("单键：单独的修饰键 / 功能键", () => {
	it("功能键可以单独绑；裸字母、数字、标点仍然不行", () => {
		assert.equal(normalizeCombo("F5"), "F5");
		assert.equal(parseCombo("F5")?.key, "F5");
		// 裸字母 / 数字 / 标点：在输入框里打字就会触发动作，一律拒收
		for (const bare of ["K", "5", "Comma", "Space", "Escape"]) {
			assert.equal(parseCombo(bare), null, bare);
		}
	});

	it("裸功能键能派发；裸字母仍然产生不了组合", () => {
		const map: ShortcutMap = { ...defaultShortcuts(), newChat: "F5" };
		assert.equal(shortcutFor(map, key({ key: "F5", code: "F5" })), "newChat");
		assert.equal(shortcutFor(map, key({ key: "k", code: "KeyK" })), null);
	});

	it("右 ⌘ / 右 ⌥ / ⌃ 可以单独成键，且左右分得开", () => {
		assert.equal(normalizeCombo("RightMod"), "RightMod");
		assert.equal(normalizeCombo("RightAlt"), "RightAlt");
		assert.equal(normalizeCombo("Ctrl"), "Ctrl");
		const map: ShortcutMap = { ...defaultShortcuts(), toggleMic: "RightMod" };
		assert.equal(loneModifierShortcut(map, { key: "Meta", code: "MetaRight" }), "toggleMic");
		// 左 ⌘ 不算「右 ⌘」
		assert.equal(loneModifierShortcut(map, { key: "Meta", code: "MetaLeft" }), null);
		// 带主键的绑定不会被「单按修饰键」命中
		const withKey: ShortcutMap = { ...defaultShortcuts(), toggleMic: "RightMod+L" };
		assert.equal(loneModifierShortcut(withKey, { key: "Meta", code: "MetaRight" }), null);
	});

	it("主键按下时不会被当成「单按修饰键」", () => {
		const map: ShortcutMap = { ...defaultShortcuts(), toggleMic: "RightMod" };
		assert.equal(loneModifierShortcut(map, { key: "k", code: "KeyK" }), null);
		// Shift 不参与单键（大写字母 / 选文字都会按它）
		assert.equal(isLoneModifierEvent({ key: "Shift", code: "ShiftLeft" }), false);
		assert.equal(normalizeCombo("Shift"), null);
	});

	it("展示：单键只写那颗键", () => {
		assert.equal(formatCombo("RightMod", true), "右⌘");
		assert.equal(formatCombo("RightAlt", true), "右⌥");
		assert.equal(formatCombo("Mod", true), "⌘");
		assert.equal(formatCombo("Ctrl", true), "⌃");
		assert.equal(formatCombo("F5", true), "F5");
		// 非 mac：Mod 就是 Ctrl，单按显示成 Ctrl
		assert.equal(formatCombo("Mod", false), "Ctrl");
	});

	it("存储里能留住单键；「⌘」和「右⌘」互斥（只会留一个）", () => {
		assert.equal(readShortcuts(JSON.stringify({ toggleMic: "RightMod" })).toggleMic, "RightMod");
		const map = defaultShortcuts();
		map.toggleMic = "Mod";
		map.pauseSpeech = "RightMod";
		const clean = dedupeShortcuts(map);
		assert.equal(clean.toggleMic, "Mod");
		assert.equal(clean.pauseSpeech, null);
	});
});
