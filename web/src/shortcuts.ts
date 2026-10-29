/**
 * 可自定义快捷键（设置 → 快捷键）。
 *
 * 三条约定，改之前先看：
 *  1. **组合键存规范字符串**（`"Mod+Shift+K"`）。`Mod` = 这台机器的**主修饰键**：
 *     macOS 只认 ⌘，其它平台只认 Ctrl（早期 `⌘⇧F` 那种「ctrlKey || metaKey」的写法已经收紧）；
 *     为什么不两边都认：macOS 上 `Ctrl+K` 是文本框里「删到行尾」的正经按键，
 *     抢它等于把编辑习惯弄坏；而 `⌘K` 在这边本来就是空的。
 *     同一条绑定两个平台都能用 —— 各按各的主修饰键，展示也跟着换（⌘K / Ctrl+K）。
 *  2. **必须带修饰键**（`Mod` 或 `Alt` 至少一个）。不收裸字母 —— 否则在输入框里打 `k`
 *     就能开一条新会话，比没有快捷键糟糕得多。
 *  3. 存**整张表**（JSON：`actionId → combo | null`）。`null` = 用户明确「不设置」；
 *     键缺失 = 从没配过 → 回落到默认值。这样以后新增动作，老数据不用迁移也能拿到默认键。
 *
 * 与主题 / 聊天显示同一套纪律：纯本机偏好、`localStorage`、`agent-web.` 前缀、
 * 不进快照、不上云；同页变更用 CustomEvent 广播（跨页听 `storage`）。
 */

export type ShortcutId =
	| "newChat"
	| "newProject"
	| "tempChat"
	| "settings"
	| "openRight"
	| "closeRight"
	| "toggleLeft"
	| "files"
	| "terminal"
	| "contentSearch"
	| "cheatSheet";

export type ShortcutDefinition = {
	id: ShortcutId;
	label: string;
	labelEn: string;
	/** 一句「这个动作到底干什么」；有坑的地方（比如 macOS 的 ⌘M）写在这里 */
	hint?: string;
	hintEn?: string;
	/** 出厂默认；`null` = 出厂不绑 */
	defaultCombo: string | null;
};

/**
 * 动作用一张表描述（顺序 = 设置面板里的行顺序）。
 *
 * 默认键的取法：`Mod+字母` 给「最常用、最想顺手」的两个（新会话 / 新项目，用户点名要的），
 * 其余面板类动作统一用 `Mod+Alt+字母` —— 这一档在浏览器里几乎没人占，也不容易和
 * macOS 的系统菜单撞（⌘M/⌘W/⌘T/⌘L 这些都是系统或浏览器先吃掉的）。
 */
export const SHORTCUT_DEFS: readonly ShortcutDefinition[] = [
	{
		id: "newChat",
		label: "新会话",
		labelEn: "New session",
		hint: "换掉左边这条主对话，会落盘",
		hintEn: "Replaces the main chat on the left; it is saved",
		defaultCombo: "Mod+K",
	},
	{
		id: "newProject",
		label: "新项目",
		labelEn: "New project",
		hint: "打开目录选择器；macOS 上 ⌘M 会被系统「最小化」抢走，建议改成 ⌘⇧M",
		hintEn: "Opens the directory picker; on macOS ⌘M is taken by Window ▸ Minimize — use ⌘⇧M instead",
		defaultCombo: "Mod+M",
	},
	{
		id: "tempChat",
		label: "临时会话",
		labelEn: "Temp session",
		hint: "在右侧另开一条不落盘的聊天",
		hintEn: "Opens an unsaved chat on the right",
		defaultCombo: "Mod+Shift+K",
	},
	{
		id: "settings",
		label: "设置",
		labelEn: "Settings",
		defaultCombo: "Mod+Alt+S",
	},
	{
		id: "openRight",
		label: "打开右侧边栏",
		labelEn: "Open right panel",
		defaultCombo: "Mod+Alt+O",
	},
	{
		id: "closeRight",
		label: "收起右侧边栏",
		labelEn: "Close right panel",
		defaultCombo: "Mod+Alt+W",
	},
	{
		id: "toggleLeft",
		label: "收起 / 展开左侧栏",
		labelEn: "Toggle left sidebar",
		defaultCombo: "Mod+Alt+L",
	},
	{
		id: "files",
		label: "文件管理",
		labelEn: "Files",
		hint: "打开左侧文件树（收起状态会自动展开）",
		hintEn: "Opens the file tree on the left (expands the sidebar if collapsed)",
		defaultCombo: "Mod+Alt+F",
	},
	{
		id: "terminal",
		label: "新建终端",
		labelEn: "New terminal",
		defaultCombo: "Mod+Alt+T",
	},
	{
		id: "contentSearch",
		label: "搜索文件内容",
		labelEn: "Search file contents",
		hint: "全文搜索浮层（改键后文件管理里那句提示也会跟着变）",
		hintEn: "Full-text search overlay; the hint in the file manager follows this binding",
		defaultCombo: "Mod+Shift+F",
	},
	{
		id: "cheatSheet",
		label: "快捷键速查表",
		labelEn: "Shortcut cheat sheet",
		hint: "浮层列出当前所有绑定（就是这份表）；再按一次关掉",
		hintEn: "Shows every binding as an overlay; press again to close",
		defaultCombo: "Mod+Slash",
	},
];

export type ShortcutMap = Record<ShortcutId, string | null>;

export const SHORTCUTS_KEY = "agent-web.shortcuts";
const SHORTCUTS_EVENT = "agent-web:shortcuts";

/** 解析后的组合键：`key` 是 token（`K` / `Comma` / `ArrowLeft`…），不是打字结果 */
export type ParsedCombo = { mod: boolean; shift: boolean; alt: boolean; key: string };

/** 允许当主键的命名键（跟 `event.code` 一致，避免 Shift 把 `,` 变成 `<` 这种歧义） */
const CODE_KEYS = new Set([
	"Enter",
	"Space",
	"ArrowUp",
	"ArrowDown",
	"ArrowLeft",
	"ArrowRight",
	"Comma",
	"Period",
	"Slash",
	"Backquote",
	"Minus",
	"Equal",
	"BracketLeft",
	"BracketRight",
	"Semicolon",
	"Quote",
	"Backslash",
]);

/** 纯修饰键：录制时按下它们不算「按完了」，继续等 */
const MODIFIER_KEYS = new Set(["Meta", "Control", "Shift", "Alt", "AltGraph", "CapsLock", "Dead"]);

/**
 * 浏览器 / 系统**先吃掉**的组合：页面的 `preventDefault()` 拦不住，绑上去等于没绑。
 * 这些在设置面板里直接拒绝，而不是让用户绑完发现不生效。
 */
const RESERVED_COMBOS = new Set([
	"Mod+T",
	"Mod+Shift+T",
	"Mod+W",
	"Mod+Shift+W",
	"Mod+N",
	"Mod+Shift+N",
	"Mod+R",
	"Mod+Shift+R",
	"Mod+Q",
	"Mod+L",
	"Mod+P",
	"Mod+Shift+P",
	"Mod+Shift+J",
	"Mod+Shift+I",
	"Mod+Alt+I",
]);

/** 单个字符键的大小写照规范走大写；命名键原样 */
function keyTokenOf(event: { key: string; code?: string }): string | null {
	const code = event.code ?? "";
	const letter = /^Key([A-Z])$/.exec(code);
	if (letter?.[1]) return letter[1];
	const digit = /^Digit([0-9])$/.exec(code);
	if (digit?.[1]) return digit[1];
	const fn = /^F([1-9]|1[0-2])$/.exec(code);
	if (fn?.[0]) return fn[0];
	if (CODE_KEYS.has(code)) return code;
	// 没有 `code`（老浏览器 / 测试手写的事件）：退回到 `event.key`
	if (/^[a-zA-Z0-9]$/.test(event.key)) return event.key.toUpperCase();
	if (event.key === " " || event.key === "Spacebar") return "Space";
	if (MODIFIER_KEYS.has(event.key)) return null;
	return CODE_KEYS.has(event.key) ? event.key : null;
}

/** 解析规范字符串；不认识 / 缺修饰键 / 键名不认识 → null */
export function parseCombo(combo: string | null | undefined): ParsedCombo | null {
	if (!combo) return null;
	const parts = combo.split("+");
	if (parts.length < 2) return null;
	const key = parts[parts.length - 1] ?? "";
	if (key === "") return null;
	const parsed: ParsedCombo = { mod: false, shift: false, alt: false, key };
	for (const part of parts.slice(0, -1)) {
		if (part === "Mod") parsed.mod = true;
		else if (part === "Shift") parsed.shift = true;
		else if (part === "Alt") parsed.alt = true;
		else return null; // 不认识的修饰键：整条作废，别猜
	}
	// 约定 2：必须带 Mod 或 Alt（Shift 单独不算）
	if (!parsed.mod && !parsed.alt) return null;
	const known = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-2])$/.test(key) || CODE_KEYS.has(key);
	return known ? parsed : null;
}

/** 把解析结果拼回规范字符串（顺序固定：Mod → Shift → Alt → key） */
export function comboOf(parsed: ParsedCombo): string {
	const parts: string[] = [];
	if (parsed.mod) parts.push("Mod");
	if (parsed.shift) parts.push("Shift");
	if (parsed.alt) parts.push("Alt");
	parts.push(parsed.key);
	return parts.join("+");
}

/** 归一化（同一组合只有一种写法）；非法 → null */
export function normalizeCombo(combo: string | null | undefined): string | null {
	const parsed = parseCombo(combo);
	return parsed ? comboOf(parsed) : null;
}

/**
 * 键盘事件 → 规范组合键。
 *
 * 返回 null 的三种情况：正在按修饰键（还没按完）、没有修饰键（裸键不绑）、
 * 键名不在白名单（Tab / Escape / 功能键以外的东西）。
 *
 * `mac` 只是为了让测试能两边都跑；实际调用一律用当前平台。
 */
export function comboFromEvent(
	event: {
		key: string;
		code?: string;
		metaKey?: boolean;
		ctrlKey?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
	},
	mac = isMacPlatform(),
): string | null {
	const key = keyTokenOf(event);
	if (!key) return null;
	// 主修饰键只认该平台那一个（见文件头第 1 条）
	const mod = mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
	if (!mod && !event.altKey) return null;
	return comboOf({ mod, shift: Boolean(event.shiftKey), alt: Boolean(event.altKey), key });
}

/** 事件 → 命中的动作（没有就是 null）；派发器只需要这一个函数 */
export function shortcutFor(
	map: ShortcutMap,
	event: {
		key: string;
		code?: string;
		metaKey?: boolean;
		ctrlKey?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
	},
	mac = isMacPlatform(),
): ShortcutId | null {
	const combo = comboFromEvent(event, mac);
	if (!combo) return null;
	for (const def of SHORTCUT_DEFS) {
		if (map[def.id] === combo) return def.id;
	}
	return null;
}

export function isReservedCombo(combo: string | null | undefined): boolean {
	const normalized = normalizeCombo(combo);
	return normalized !== null && RESERVED_COMBOS.has(normalized);
}

/** 默认整表（按定义顺序去重：重复的后来者让位，变成「不设置」） */
export function defaultShortcuts(): ShortcutMap {
	const map = {} as ShortcutMap;
	for (const def of SHORTCUT_DEFS) map[def.id] = normalizeCombo(def.defaultCombo);
	return dedupeShortcuts(map);
}

/**
 * 同一条组合只留给**表里排在最前**的那个动作，后来的置空。
 *
 * 为什么要在读的时候也去一次重：老数据可能被手改过，或者两个动作的默认值将来撞了 ——
 * 与其两处同时触发（用户按一下开两个面板），不如只留一个。
 */
export function dedupeShortcuts(map: ShortcutMap): ShortcutMap {
	const used = new Set<string>();
	const next = {} as ShortcutMap;
	for (const def of SHORTCUT_DEFS) {
		const combo = normalizeCombo(map[def.id]);
		if (!combo || used.has(combo)) {
			next[def.id] = null;
			continue;
		}
		used.add(combo);
		next[def.id] = combo;
	}
	return next;
}

/** 读存储：坏 JSON / 坏值一律回落默认，绝不抛错（隐私模式下 localStorage 也可能 throw） */
export function readShortcuts(raw: string | null): ShortcutMap {
	let parsed: unknown = null;
	try {
		parsed = raw ? JSON.parse(raw) : null;
	} catch {
		parsed = null;
	}
	const stored = parsed && typeof parsed === "object" ? (parsed as Record<string, unknown>) : {};
	const map = {} as ShortcutMap;
	for (const def of SHORTCUT_DEFS) {
		if (!(def.id in stored)) {
			// 没配过（含以后新加的动作）→ 用默认键
			map[def.id] = normalizeCombo(def.defaultCombo);
			continue;
		}
		const value = stored[def.id];
		// 坏值（不合法字符串 / 不是字符串 / 不是 null）→ 回落默认；只有明确的 null 才算「不设置」
		const parsed = value === null ? null : normalizeCombo(typeof value === "string" ? value : null);
		map[def.id] = value === null ? null : (parsed ?? normalizeCombo(def.defaultCombo));
	}
	return dedupeShortcuts(map);
}

export function storedShortcuts(): ShortcutMap {
	if (typeof localStorage === "undefined") return defaultShortcuts();
	try {
		return readShortcuts(localStorage.getItem(SHORTCUTS_KEY));
	} catch {
		return defaultShortcuts(); // 隐私模式禁 localStorage：用默认值，不抛错
	}
}

/** 写存储 + 同页广播（跨页另有 `storage` 事件，见 `subscribeShortcuts`） */
export function writeShortcuts(map: ShortcutMap): void {
	const clean = dedupeShortcuts(map);
	try {
		localStorage.setItem(SHORTCUTS_KEY, JSON.stringify(clean));
	} catch {
		// 隐私模式 / 存储被禁：只在本页生效
	}
	window.dispatchEvent(new CustomEvent<ShortcutMap>(SHORTCUTS_EVENT, { detail: clean }));
}

export function subscribeShortcuts(handler: () => void): () => void {
	const onLocal = (): void => handler();
	const onStorage = (event: StorageEvent): void => {
		if (event.key === SHORTCUTS_KEY) handler();
	};
	window.addEventListener(SHORTCUTS_EVENT, onLocal);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(SHORTCUTS_EVENT, onLocal);
		window.removeEventListener("storage", onStorage);
	};
}

/** 这条组合键被哪个动作占着（`except` = 问「别人有没有占」时传自己） */
export function findConflict(
	map: ShortcutMap,
	combo: string | null | undefined,
	except?: ShortcutId,
): ShortcutId | null {
	const normalized = normalizeCombo(combo);
	if (!normalized) return null;
	for (const def of SHORTCUT_DEFS) {
		if (def.id === except) continue;
		if (map[def.id] === normalized) return def.id;
	}
	return null;
}

export function shortcutLabel(id: ShortcutId): { zh: string; en: string } {
	const def = SHORTCUT_DEFS.find((item) => item.id === id);
	return { zh: def?.label ?? id, en: def?.labelEn ?? id };
}

export function isMacPlatform(): boolean {
	if (typeof navigator === "undefined") return false;
	const ua = navigator as Navigator & { userAgentData?: { platform?: string } };
	const platform = ua.userAgentData?.platform ?? navigator.platform ?? "";
	return /mac|iphone|ipad|ipod/i.test(platform);
}

/** 键名 → 展示文案（mac 用符号，其它平台用英文长名） */
const KEY_LABELS: Record<string, [string, string]> = {
	Enter: ["⏎", "Enter"],
	Space: ["Space", "Space"],
	ArrowUp: ["↑", "↑"],
	ArrowDown: ["↓", "↓"],
	ArrowLeft: ["←", "←"],
	ArrowRight: ["→", "→"],
	Comma: [",", ","],
	Period: [".", "."],
	Slash: ["/", "/"],
	Backquote: ["`", "`"],
	Minus: ["-", "-"],
	Equal: ["=", "="],
	BracketLeft: ["[", "["],
	BracketRight: ["]", "]"],
	Semicolon: [";", ";"],
	Quote: ["'", "'"],
	Backslash: ["\\", "\\"],
};

/**
 * 展示用文案：mac 上 `⌘⇧K`，其它平台 `Ctrl+Shift+K`。
 * 未设置 / 非法 → 空字符串，调用方自己写「未设置」。
 */
export function formatCombo(combo: string | null | undefined, mac = isMacPlatform()): string {
	const parsed = parseCombo(combo);
	if (!parsed) return "";
	const parts: string[] = [];
	if (parsed.mod) parts.push(mac ? "⌘" : "Ctrl");
	if (parsed.shift) parts.push(mac ? "⇧" : "Shift");
	if (parsed.alt) parts.push(mac ? "⌥" : "Alt");
	const label = KEY_LABELS[parsed.key];
	parts.push(label ? label[mac ? 0 : 1] : parsed.key);
	return mac ? parts.join("") : parts.join("+");
}
