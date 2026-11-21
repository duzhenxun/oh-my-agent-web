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
	| "toggleRight"
	| "projects"
	| "toggleLeft"
	| "files"
	| "terminal"
	| "contentSearch"
	| "toggleMic"
	| "pauseSpeech"
	| "stopSpeech"
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
 * 默认键的取法（2026-11-04 更新）：**这套默认值就是用户实际在用的那一套**，
 * 用户原话：「改成默认也用这个，恢复时用现在的这些」。所以设置里点「恢复默认」
 * 回到的就是截图里那套：
 *
 *   新会话 ⌘⌥N / 新项目 ⌘⌥X / 临时会话 ⌘⌥H / 设置 ⌘, /
 *   右侧栏 ⌘⌥O / 左侧栏 ⌘⌥L / 项目管理 ⌘⌥P / 文件管理 ⌘⌥F /
 *   终端 ⌃` / 搜索 ⌘⇧F / 速查表 ⌘/
 *
 * 两条通用规矩没变：`Mod+字母` 只给最顺手的，其余面板类动作统一用 `Mod+Alt+字母` ——
 * 这一档在浏览器里几乎没人占，也不容易和 macOS 的系统菜单撞
 * （⌘M/⌘W/⌘T/⌘L 这些都被系统或浏览器先吃掉）。改默认值时**顺手改 `tests/unit/shortcuts.test.ts`
 * 里那份「默认键」断言**，那里是故意的二次确认。
 */
export const SHORTCUT_DEFS: readonly ShortcutDefinition[] = [
	{
		id: "newChat",
		label: "新会话",
		labelEn: "New session",
		hint: "换掉左边这条主对话，会落盘",
		hintEn: "Replaces the main chat on the left; it is saved",
		defaultCombo: "Mod+Alt+N",
	},
	{
		id: "newProject",
		label: "新项目",
		labelEn: "New project",
		hint: "打开目录选择器；macOS 上 ⌘M 会被系统「最小化」抢走，所以默认避开 ⌘M",
		hintEn: "Opens the directory picker; ⌘M is taken by Window ▸ Minimize on macOS, so it is avoided",
		defaultCombo: "Mod+Alt+X",
	},
	{
		id: "tempChat",
		label: "临时会话",
		labelEn: "Temp session",
		hint: "在右侧另开一条不落盘的聊天",
		hintEn: "Opens an unsaved chat on the right",
		defaultCombo: "Mod+Alt+H",
	},
	{
		id: "settings",
		label: "设置",
		labelEn: "Settings",
		defaultCombo: "Mod+Comma",
	},
	/*
	 * 右侧边栏就用**一个**动作（2026-11-04 用户：「合并成一个」）。
	 * 以前分成「打开」「收起」两条，结果是同一個面板占两个键、两份文案，
	 * 实际用起来只会记得“左侧边栏是切换、右边却要分两个键”。
	 * 旧数据里的 `openRight` / `closeRight` 会在 `readShortcuts` 里迁到这条（见 `LEGACY_IDS`）。
	 *
	 * 摆放位置（用户 2026-11-04）：**紧贴在「收起 / 展开左侧栏」上方**，两条一上一下对看；
	 * 文案也跟它对齐成「收起 / 展开…栏」（原来单写「右侧边栏」看不出是一个开关）。
	 */
	{
		id: "toggleRight",
		label: "收起 / 展开右侧栏",
		labelEn: "Toggle right panel",
		hint: "同一个键开 / 关：关着就打开，开着就收起",
		hintEn: "Opens and closes with the same key",
		defaultCombo: "Mod+Alt+O",
	},
	{
		id: "toggleLeft",
		label: "收起 / 展开左侧栏",
		labelEn: "Toggle left sidebar",
		defaultCombo: "Mod+Alt+L",
	},
	/*
	 * 「项目管理」紧贴在「文件管理」上方（用户 2026-11-04：「跟文件管理上下靠着」）：
	 * 这两个都是**左栏里的一轤**（管理哪几个项目 / 看哪个文件树），而上面两条是「整栏收起 / 展开」——
	 * 两种粒度分开排，看的时候不用在一排里找。
	 */
	{
		id: "projects",
		label: "项目管理",
		labelEn: "Projects",
		hint: "侧栏里「项目管理」那一栏的开关；侧栏收着时会先展开",
		hintEn: "Toggles the Projects section in the sidebar; expands the sidebar if it was collapsed",
		defaultCombo: "Mod+Alt+P",
	},
	{
		id: "files",
		label: "文件管理",
		labelEn: "Files",
		hint: "同一个键开 / 关：树开着就收起；侧栏收着时会先展开",
		hintEn: "Opens and closes with the same key; expands the sidebar if it was collapsed",
		defaultCombo: "Mod+Alt+F",
	},
	{
		id: "terminal",
		label: "切换终端",
		labelEn: "Toggle terminal",
		hint: "Ctrl+` —— 显示 / 隐藏对话框下面的终端（隐藏时进程不断）；mac ⌘` 会被系统「切换窗口」先吃掉，所以用 ⌃",
		hintEn:
			"Ctrl+` — shows / hides the terminal under the chat (shells keep running while hidden); on macOS ⌘` is taken by “cycle windows”, hence ⌃",
		defaultCombo: "Ctrl+Backquote",
	},
	{
		id: "contentSearch",
		label: "搜索文件内容",
		labelEn: "Search file contents",
		hint: "全文搜索浮层（改键后文件管理里那句提示也会跟着变）",
		hintEn: "Full-text search overlay; the hint in the file manager follows this binding",
		defaultCombo: "Mod+Shift+F",
	},
	/*
	 * 「开麦 / 关麦」放在两条朗读动作上面（2026-11-21 用户：「这个麦打开与关闭也设置一下快捷键」）：
	 * 三条都是语音那一档，读起来就是一串「说 / 念 / 停」。
	 *
	 * 默认 `Mod+Alt+M` 而不是 `Mod+Shift+M`：后者在 Windows/Linux 的 Chrome 里是「切换用户」
	 * （Ctrl+Shift+M），绑上去等于没绑 —— 这条在 `RESERVED_COMBOS` 里也没法表达（它是浏览器
	 * 内部命令），所以直接选这一档：`Mod+Alt+字母` 在浏览器里几乎没人占。
	 */
	{
		id: "toggleMic",
		label: "开始 / 停止语音输入",
		labelEn: "Start / stop voice input",
		hint: "按一下开、一直听着，再按一下关；也可以按住不放说一句短的，松手就停（设置里能录右⌘ / 右⌥）",
		hintEn:
			"Tap to keep listening, tap again to stop; or hold and release to say one short thing (right ⌘ / right ⌥ work too)",
		defaultCombo: "Mod+Alt+M",
	},
	{
		id: "pauseSpeech",
		label: "暂停 / 继续朗读",
		labelEn: "Pause / resume reading",
		hint: "冻住正在念的这句，再按一次从原地接着念（不会跳过后面的内容）；朗读中浮条上也有这颗按钮",
		hintEn:
			"Freezes the current sentence; press again to continue from the same spot (nothing later gets skipped). Also a button on the floating bar",
		defaultCombo: "Mod+Shift+P",
	},
	{
		id: "stopSpeech",
		label: "停止朗读",
		labelEn: "Stop reading aloud",
		hint: "停掉正在念的这句；这一轮剩下的文字也不再自动念（朗读中底部也会出现一颗按钮）",
		hintEn: "Stops the current sentence; the rest of this turn stays silent (a button also appears while reading)",
		defaultCombo: "Mod+Alt+S",
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
export type ParsedCombo = {
	mod: boolean;
	ctrl: boolean;
	shift: boolean;
	alt: boolean;
	/**
	 * 主修饰键是不是**右边**那个（右 ⌘ / 右 Ctrl）。
	 *
	 * 为什么要有它（用户 2026-11-21：「可分左右 command option 键」）：系统菜单级的快捷键
	 * 左右不分，但页面的 keydown 会告诉你是哪一边（`event.code` = `MetaRight`）；
	 * 想拿右边那颗当「专门开麦」的键就得自己分开记。
	 * 注意：**`RightMod` 为假不等于「必须是左边」**，它表示「哪边都行」（见 `combosMatch`）。
	 */
	modRight: boolean;
	/** `Alt` 是不是右边那个（右 ⌥ / 右 Alt） */
	altRight: boolean;
	key: string;
};

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
 *
 * `Mod+Shift+P` 特意**不在**这一列：它是「暂停 / 继续朗读」的默认键（用户 2026-11-21 指定）。
 * Chrome / Edge 上没人占这个组合（打印是 `Mod+P`）；Safari 会抢去当「页面设置」、
 * Firefox 会抢去当「新建隐私窗口」—— 在那两个浏览器里按不出来（要改键），这里不为它们让步。
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

/**
 * 事件 → 主键 token（`M` / `Comma` / `Backquote`…），**修饰键返回 null**。
 *
 * 为什么要单独导出：「按住说话」要在 keyup 上判断「松的是不是那颗主键」。
 * 用户松手往往先松开 ⌘/⌥ 再松开 M（尤其满键盘一起放开时），那时 `shortcutFor` 已经匹配
 * 不到原组合了 —— 拿 token 比就不会漏。
 */
export function keyTokenOfEvent(event: { key: string; code?: string }): string | null {
	return keyTokenOf(event);
}

/** 解析规范字符串；不认识 / 缺修饰键 / 键名不认识 → null */
export function parseCombo(combo: string | null | undefined): ParsedCombo | null {
	if (!combo) return null;
	const parts = combo.split("+");
	if (parts.length < 2) return null;
	const key = parts[parts.length - 1] ?? "";
	if (key === "") return null;
	const parsed: ParsedCombo = {
		mod: false,
		ctrl: false,
		shift: false,
		alt: false,
		modRight: false,
		altRight: false,
		key,
	};
	for (const part of parts.slice(0, -1)) {
		if (part === "Mod") parsed.mod = true;
		// 右 ⌘ / 右 ⌥：隐含「有主修饰键 / 有 Alt」，只是钉到右边那一个
		else if (part === "RightMod") {
			parsed.mod = true;
			parsed.modRight = true;
		} else if (part === "RightAlt") {
			parsed.alt = true;
			parsed.altRight = true;
		} else if (part === "Ctrl") parsed.ctrl = true;
		else if (part === "Shift") parsed.shift = true;
		else if (part === "Alt") parsed.alt = true;
		else return null; // 不认识的修饰键：整条作废，别猜
	}
	// 约定 2：必须带 Mod / Ctrl / Alt（Shift 单独不算）
	if (!parsed.mod && !parsed.ctrl && !parsed.alt) return null;
	const known = /^[A-Z0-9]$/.test(key) || /^F([1-9]|1[0-2])$/.test(key) || CODE_KEYS.has(key);
	return known ? parsed : null;
}

/** 把解析结果拼回规范字符串（顺序固定：Mod/RightMod → Ctrl → Shift → Alt/RightAlt → key） */
export function comboOf(parsed: ParsedCombo): string {
	const parts: string[] = [];
	if (parsed.mod) parts.push(parsed.modRight ? "RightMod" : "Mod");
	if (parsed.ctrl) parts.push("Ctrl");
	if (parsed.shift) parts.push("Shift");
	if (parsed.alt) parts.push(parsed.altRight ? "RightAlt" : "Alt");
	parts.push(parsed.key);
	return parts.join("+");
}

/**
 * 两条组合键是不是同一次按键（`binding` 里没写「右边」就是左右都行）。
 *
 * 为什么要这个而不是直接比字符串：`Mod+M` 与 `RightMod+M` 是两个写法，但前者包含后者 ——
 * 用户绑了 `⌘M` 以后，按右 ⌘+M 也应该能命中（系统菜单就是这么做的）。
 * 反过来，绑了「右 ⌘+M」就不该被左 ⌘+M 命中 —— 这正是「左右分开」的意义。
 */
export function combosMatch(binding: ParsedCombo | null, pressed: ParsedCombo | null): boolean {
	if (!binding || !pressed) return false;
	if (binding.key !== pressed.key) return false;
	if (binding.mod !== pressed.mod) return false;
	if (binding.ctrl !== pressed.ctrl) return false;
	if (binding.shift !== pressed.shift) return false;
	if (binding.alt !== pressed.alt) return false;
	// 只有绑定钉了「右边」时才看左右；没钉就是哪边都行
	if (binding.modRight && !pressed.modRight) return false;
	if (binding.altRight && !pressed.altRight) return false;
	return true;
}

/**
 * 按**平台**归一化一条存储值。
 *
 * 非 macOS 上 Ctrl 就是主修饰键本身（`Mod` 和 `Ctrl` 是同一个物理键），
 * 所以 `Ctrl+` → `Mod+``；macOS 上两者是两个不同的键（`⌃` / `⌘`），原样保留。
 * 两边都归一到一个写法后，“存什么”和“按什么”才能对上。
 */
export function platformCombo(combo: string | null | undefined, mac = isMacPlatform()): string | null {
	const parsed = parseCombo(combo);
	if (!parsed) return null;
	if (!mac && parsed.ctrl) return comboOf({ ...parsed, ctrl: false, mod: true });
	return comboOf(parsed);
}

/** 归一化（同一组合只有一种写法）；非法 → null */
export function normalizeCombo(combo: string | null | undefined): string | null {
	const parsed = parseCombo(combo);
	return parsed ? comboOf(parsed) : null;
}

/**
 * 左右修饰键的实时状态（`noteModifierKeys` 维护）。
 *
 * 为什么必须自己记：主键按住的那一刻，`keydown` 里只有 `metaKey: true`，
 * **看不出是左 ⌘ 还是右 ⌘** —— 左右只体现在**修饰键自己**的事件上（`code: "MetaRight"`）。
 * 所以要在修饰键的 keydown/keyup 时先记一笔，等主键到了再配对（否则「左右分开」根本做不到）。
 */
const rightDown = { mod: false, alt: false };

/** 每个键盘事件开头喂一次（重复喂是幂等的）；只关心四颗：左右 ⌘ / 左右 ⌥ */
export function noteModifierKeys(event: { code?: string; type?: string }, mac = isMacPlatform()): void {
	const down = event.type !== "keyup";
	// 只记**当前平台的主修饰键**：mac 上是右 ⌘，其它平台上是右 Ctrl（否则两边会互相污染）
	if (event.code === (mac ? "MetaRight" : "ControlRight")) rightDown.mod = down;
	else if (event.code === "AltRight") rightDown.alt = down;
}

/** 焦点丢了（⌘Tab / 锁屏）就清掉：否则下次按左 ⌘ 可能被当成右 ⌘（keyup 收不到） */
export function resetModifierSides(): void {
	rightDown.mod = false;
	rightDown.alt = false;
}

/**
 * 键盘事件 → 解析后的组合键（`comboFromEvent` / `shortcutFor` 共用这一份）。
 *
 * 返回 null 的三种情况：正在按修饰键（还没按完）、没有修饰键（裸键不绑）、
 * 键名不在白名单（Tab / Escape / 功能键以外的东西）。
 */
function parsedFromEvent(
	event: {
		key: string;
		code?: string;
		metaKey?: boolean;
		ctrlKey?: boolean;
		shiftKey?: boolean;
		altKey?: boolean;
	},
	mac: boolean,
	sides: { mod: boolean; alt: boolean } = rightDown,
): ParsedCombo | null {
	const key = keyTokenOf(event);
	if (!key) return null;
	// 主修饰键只认该平台那一个（见文件头第 1 条）
	const mod = mac ? Boolean(event.metaKey) : Boolean(event.ctrlKey);
	// 单独的 Ctrl 只在 macOS 上可表达（其它平台它已经就是 Mod）
	const ctrl = mac ? Boolean(event.ctrlKey) : false;
	const alt = Boolean(event.altKey);
	if (!mod && !ctrl && !alt) return null;
	/**
	 * macOS 上「单独的 ⌃ + 字母/数字」仍不认：`⌃K` 是文本框里「删到行尾」、`⌃A/⌃E` 是行首行尾，
	 * 抢它们等于把编辑习惯弄坏（文件头约定 1 的理由）。
	 * `⌃\``（用户要的「打开终端」）不在这个集合里 —— 它不是文本编辑键，所以放行。
	 */
	if (mac && ctrl && !mod && /^[A-Z0-9]$/.test(key)) return null;
	// 左右看「修饰键自己刚才有没有按下右边那颗」（见 `rightDown` 的说明）
	return { mod, modRight: mod && sides.mod, ctrl, shift: Boolean(event.shiftKey), alt, altRight: alt && sides.alt, key };
}

/**
 * 键盘事件 → 规范组合键。
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
	const parsed = parsedFromEvent(event, mac);
	return parsed ? comboOf(parsed) : null;
}

/** 存储值 → 按平台归一化后的解析结果（`Ctrl+` → `Mod+``） */
export function platformParsed(combo: string | null | undefined, mac = isMacPlatform()): ParsedCombo | null {
	const parsed = parseCombo(combo);
	if (!parsed) return null;
	if (!mac && parsed.ctrl) return { ...parsed, ctrl: false, mod: true, modRight: false };
	return parsed;
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
	const pressed = parsedFromEvent(event, mac);
	if (!pressed) return null;
	for (const def of SHORTCUT_DEFS) {
		if (combosMatch(platformParsed(map[def.id], mac), pressed)) return def.id;
	}
	return null;
}

export function isReservedCombo(combo: string | null | undefined): boolean {
	const parsed = parseCombo(combo);
	if (!parsed) return false;
	// 浏览器/系统抢键不分左右：右 ⌘+T 一样会被当成「开新标签」吃掉
	return RESERVED_COMBOS.has(comboOf({ ...parsed, modRight: false, altRight: false }));
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
	/** 已经用掉的组合（解析后的）：跟它「会同时命中」就算撞，见 `combosMatch` 的左右说明 */
	const used: ParsedCombo[] = [];
	const next = {} as ShortcutMap;
	for (const def of SHORTCUT_DEFS) {
		const combo = normalizeCombo(map[def.id]);
		const parsed = parseCombo(combo);
		const clash =
			parsed !== null && used.some((other) => combosMatch(other, parsed) || combosMatch(parsed, other));
		if (!combo || !parsed || clash) {
			next[def.id] = null;
			continue;
		}
		used.push(parsed);
		next[def.id] = combo;
	}
	return next;
}

/**
 * 合并 / 改名过的旧动作：旧 id → 新 id。
 *
 * 只在读存储时用：老数据里存的是旧 id，不迁的话用户的绑定会凭空丢掉（回落默认）。
 * 迁移规则很土：按新表里**新 id 缺失**才看旧 id，旧值原样拿来，还是走同一套归一化。
 */
const LEGACY_IDS: Partial<Record<ShortcutId, readonly string[]>> = {
	toggleRight: ["openRight", "closeRight"],
};

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
			// 没有新 id：先看有没有合并前的旧 id（有的话直接用它）
			const legacy = LEGACY_IDS[def.id]?.find((id) => typeof stored[id] === "string");
			if (legacy) {
				map[def.id] = normalizeCombo(stored[legacy] as string);
				continue;
			}
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

/* ---------------- 麦克风快捷键：轻按开关、长按说话 ---------------- */

/**
 * 麦克风那颗键的两种用法（用户 2026-11-21 给的参照：「按下开始和停止语音输入，或长按说一些简短的话」）：
 *
 *  - **轻按**：开麦后**一直听着**，再轻按一下才关（`toggle`，跟点浮条一致）；
 *  - **长按**：按住就一直听，松手就停（对讲机那种，适合“说一句短的”）。
 *
 * 为什么不再做一个「模式下拉」让用户在两种之间二选一：参照里的做法是**同一个键两种都行**，
 * 按住 350ms 就自动当长按处理。少一个设置项、也少一个“我到底选的是哪个”的记性负担。
 */
export const MIC_HOLD_DELAY_MS = 350;

/**
 * 这一下到底算什么（纯函数，测试直接调）：
 *
 *  - 已经在听 → `stop`（不管按了多久：在听的时候「按一下」就是关）；
 *  - 按够 `holdDelayMs` 还没松 → `startHold`（边说边听，松手停）；
 *  - 提前松了 → `start`（轻按：开麦，然后一直听着）。
 */
export type MicPressResult = "start" | "startHold" | "stop";
export function micPressResult(
	heldMs: number,
	listening: boolean,
	holdDelayMs: number = MIC_HOLD_DELAY_MS,
): MicPressResult {
	if (listening) return "stop";
	return heldMs >= holdDelayMs ? "startHold" : "start";
}

/** 这条组合键被哪个动作占着（`except` = 问「别人有没有占」时传自己） */
export function findConflict(
	map: ShortcutMap,
	combo: string | null | undefined,
	except?: ShortcutId,
	mac = isMacPlatform(),
): ShortcutId | null {
	const target = platformParsed(combo, mac);
	if (!target) return null;
	for (const def of SHORTCUT_DEFS) {
		if (def.id === except) continue;
		const other = platformParsed(map[def.id], mac);
		/**
		 * 双向比：把「⌘M」换成「右 ⌘M」也算撞车 —— 按一下右 ⌘+M 两个都会响。
		 * 只单向比（存的那个包含新录的这个）会漏掉这一半。
		 */
		if (combosMatch(other, target) || combosMatch(target, other)) return def.id;
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
	/* macOS 用符号且按系统顺序（⌃⌥⇧⌘）；其它平台只有 Ctrl 一个修饰键名，
	 * `Mod` 和 `Ctrl` 重复时就只写一次。 */
	if (mac) {
		/* 顺序保持原样（⌘⇧⌥），只把新加的 ⌃ 放在最前：系统里通常写作 ⌃⌥⇧⌘，
		 * 但这一栏原有的展示习惯是 ⌘ 开头，不为一个新修饰键重排全部文案。
		 * 钉了右边的那两个写成「右⌘ / 右⌥」（跟设置面板里录出来的一模一样），
		 * 一眼能看出「这颗键只在右边那颗上生效」。 */
		if (parsed.ctrl) parts.push("⌃");
		if (parsed.mod) parts.push(parsed.modRight ? "右⌘" : "⌘");
		if (parsed.shift) parts.push("⇧");
		if (parsed.alt) parts.push(parsed.altRight ? "右⌥" : "⌥");
	} else {
		parts.push(parsed.modRight ? "RightCtrl" : "Ctrl");
		if (parsed.shift) parts.push("Shift");
		if (parsed.alt) parts.push(parsed.altRight ? "RightAlt" : "Alt");
	}
	const label = KEY_LABELS[parsed.key];
	parts.push(label ? label[mac ? 0 : 1] : parsed.key);
	return mac ? parts.join("") : parts.join("+");
}
