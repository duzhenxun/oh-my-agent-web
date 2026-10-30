/**
 * 界面偏好（纯前端、存 localStorage、不进服务端快照）。
 *
 * 判据：**只影响这台机器上怎么显示**、而且希望**立刻生效**的东西放这里 ——
 * 侧栏宽度 / 弹窗尺寸 / 主题 / 对话区的默认展开状态都是这一类；
 * 需要多设备一致、或服务端要拿去做事（快捷短语、想想条数）的，才走 `set_settings`。
 *
 * 通知机制：写的时候派发一个自定义事件，同页的所有订阅者（包括设置面板里的开关自己）
 * 一起更新；跨标签页靠 `storage` 事件。
 */
const PREF_EVENT = "agent-web:pref";

/** 「思考块默认展开」：新消息的思考块一出现就是展开的 */
export const THINKING_OPEN_KEY = "agent-web.chat.thinkingOpen";

/**
 * 分栏的两块哪边是对话：`"left"`（默认，对话在左、工作区在右）或 `"right"`（对调）。
 * 值只存这两个字符串；读到别的就当默认（用户手改 localStorage 也不会搞出怪布局）。
 */
export const SPLIT_CHAT_SIDE_KEY = "agent-web.split.chatSide";

/** 「工具卡默认展开」：工具调用的参数/输出一出现就是展开的 */
export const TOOL_OPEN_KEY = "agent-web.chat.toolOpen";

/**
 * 「标注」：在对话里选中一段文字后浮出来的那颗小工具栏（添加到会话 / 标注 / 在临时会话中提问）。
 *
 * 默认开（这是这套 UI 的一个招牌动作）；关掉之后正文里选字就只是选字，不再弹东西 ——
 * 手机上误触、或只想老老实实复制一句话的时候，那颗浮层确实碍事。
 * 纯本机偏好（跟 `THINKING_OPEN_KEY` 同一类）：手机不想弹不代表桌面不想弹。
 * 已经标好的东西不受影响 —— 关掉的只是「弹不弹」，不是「已存在的标注画不画」。
 */
export const SELECTION_TOOLBAR_KEY = "agent-web.chat.selectionToolbar";

/** 「文件预览自动换行」：长行折行显示（默认开 —— 面板本来就窄，横着滚看不见后半行） */
export const WRAP_KEY = "agent-web.preview.wrap";

/**
 * 右侧终端（xterm）的字号：默认 **14px**（跟聊天正文同一档），范围 8–24。
 *
 * 为什么要能调：原来写死 12px（当时只求“能放下就行”），但它在大屏上偏小、
 * 小屏上又占地方（用户 2026-10-30：「右侧终端文字有时太小，如何调整字体大小」→ 默认改 14px）。
 * 用的是浏览器字号那一套习惯：**⌘/Ctrl + 滚轮**在面板上调、⌘/Ctrl + `=` / `-` 键盘调，
 * 设置 → 外观里也有一根滑杆（三处入口写的是同一个 key，改哪边都同步）。
 * 纯本机偏好，手机 / 桌面各记各的（终端面板本身只在桌面上常用）。
 */
/** 代码预览的字号（⌘/Ctrl + `+` / `-` 在预览里调；默认 15 = 原来 CSS 里那个值） */
export const PREVIEW_FONT_KEY = "agent-web.preview.fontSize";
export const PREVIEW_FONT_DEFAULT = 15;
export const PREVIEW_FONT_MIN = 10;
export const PREVIEW_FONT_MAX = 32;

/** 临时聊天面板的缩放百分比（⌘/Ctrl + `+` / `-`，CSS `zoom`） */
export const SIDE_CHAT_ZOOM_KEY = "agent-web.sidechat.zoom";

/** 网页面板的缩放百分比（同上） */
export const WEB_ZOOM_KEY = "agent-web.web.zoom";

export const TERMINAL_FONT_KEY = "agent-web.terminal.fontSize";
export const TERMINAL_FONT_DEFAULT = 14;
export const TERMINAL_FONT_MIN = 8;
export const TERMINAL_FONT_MAX = 24;

/**
 * 顶栏那一排入口的显隐：**勾上才显示，默认全勾**（见设置里的「顶栏」tab）。
 * 覆盖七个面板入口：模型 / 技能 / 推送 / 语音 / 插件 / MCP / 子代理。
 *
 * 「设置」故意不在这张表里：它是唯一能把这些入口重新勾回来的地方，
 * 一旦允许把它藏掉，用户全取消勾选之后就再没有入口能回去了。
 * 引擎切换也不在：它在底部状态栏（跟审批模式并排），不属于顶栏这一排。
 */
export const APPBAR_ITEMS = ["models", "skills", "push", "voice", "plugins", "mcp", "agents"] as const;
type AppbarItem = (typeof APPBAR_ITEMS)[number];
export type AppbarToggle = AppbarItem;

/** 设置里那排勾选框的顺序：就是这七个面板入口 */
export const APPBAR_TOGGLES: AppbarToggle[] = [...APPBAR_ITEMS];

/** 一个入口一个 key：勾选框各自独立，改一个不会连带别人 */
const APPBAR_KEY_PREFIX = "agent-web.appbar.";
export const APPBAR_ITEM_KEY = (item: AppbarToggle): string => `${APPBAR_KEY_PREFIX}${item}`;

/**
 * 顶栏每个入口**长什么样**：文案 / 图标各一个开关（设置 → 界面 → 「顶栏文字与图标」）。
 * 勾上才显示，默认都勾。
 *
 * 只管顶栏那一排（`SidebarMenu` 的 `placement="appbar"`）：侧栏底部那排和弹窗 tab
 * 是给窄屏 / 收起态兜底的，字和图标都留着更好认。
 * 两个都不勾时仍然画图标 —— 一排看不见的按钮等于把入口弄丢了（跟上面「设置」不进表同一个理由）。
 */
export const APPBAR_PARTS = ["label", "icon"] as const;
export type AppbarPart = (typeof APPBAR_PARTS)[number];

export const APPBAR_PART_KEY = (part: AppbarPart): string => `agent-web.appbar.show-${part}`;

export const APPBAR_PART_LABEL: Record<AppbarPart, string> = {
	label: "显示文案",
	icon: "显示图标",
};

/** 勾选框上的名字（和顶栏按钮同一套叫法；SidebarMenu 里那份是弹窗 tab 用的，含「设置」） */
export const APPBAR_ITEM_LABEL: Record<AppbarToggle, string> = {
	models: "模型",
	skills: "技能",
	push: "推送",
	voice: "语音",
	plugins: "插件",
	mcp: "MCP",
	agents: "子代理",
};

/**
 * 顶栏那颗「临时会话」的显隐（设置 → 界面 → 顶栏里，跟着那七个面板入口排在一起）。
 *
 * 它**不进 `APPBAR_ITEMS`**：那份表装的是「打开哪个面板」的 key —— 要喂给 `PanelIcon`、
 * `menuItems`，还会进弹窗 tab 的排序；而这一颗是个**动作**（在右侧新开一条临时聊天，不开面板），
 * 混进去会让类型和那套「面板 key → 图标」的映射都对不上。
 * 所以它单独一个 key，用 `useStoredBool` 读写（跟 `THINKING_OPEN_KEY` 这些单开关同一套）。
 */
export const APPBAR_TEMPCHAT_KEY = "agent-web.appbar.tempchat";

/**
 * 「对话窗口」输入框上方那一排三块：模板库按钮、想想按钮、快捷指令。
 * 跟顶栏同一套判据：勾上才显示，默认全勾（见设置里的「界面 → 对话窗口」）。
 *
 * 「快捷指令」原来是服务端设置（`quickPhrasesEnabled`，多设备一致），后来并进这张表：
 * 手机上想不想要那一行、桌面上想不想要，本来就是两回事 —— 而真正该多设备一致的是
 * **短语内容**本身，它仍然在服务端 settings 里。
 * 服务端那个字段留着只为老客户端兼容和一次性迁移（见 `use-quick-seed.ts`）。
 */
export const COMPOSER_TOGGLES = ["templates", "think", "quick"] as const;
export type ComposerToggle = (typeof COMPOSER_TOGGLES)[number];

export const COMPOSER_ITEM_KEY = (item: ComposerToggle): string => `agent-web.composer.${item}`;

/** 勾选框上的名字（和输入框上方那颗按钮同一套叫法） */
export const COMPOSER_ITEM_LABEL: Record<ComposerToggle, string> = {
	templates: "模板",
	think: "想想",
	quick: "快捷指令",
};

/**
 * 「底部状态栏」里三块信息的显隐：排队 / 工作中 / 上下文用量。
 *
 * 审批模式与「顶部」开关**故意不在**可隐藏之列 —— 那是可操作的动作（放行/询问、收起顶栏），
 * 不是单纯的信息；藏掉一个操作入口比藏掉一块数字更容易让人找不到东西。
 */
export const STATUSBAR_TOGGLES = ["queued", "running", "context"] as const;
export type StatusbarToggle = (typeof STATUSBAR_TOGGLES)[number];

const STATUSBAR_KEY_PREFIX = "agent-web.statusbar.";
export const STATUSBAR_ITEM_KEY = (item: StatusbarToggle): string => `${STATUSBAR_KEY_PREFIX}${item}`;

export const STATUSBAR_ITEM_LABEL: Record<StatusbarToggle, string> = {
	queued: "排队",
	running: "工作中",
	context: "上下文用量",
};

/**
 * 「花费」（$）这一项的显隐：子代理卡片条 / 顶栏浮层 / 消息尾注上的那些金额。
 *
 * **默认值按设备给**（手机上默认不显示、桌面上默认显示），所以它不进上面那张
 * 「一个 group 全默认开」的表 —— 单个 key，默认值由 `use-show-cost.ts` 按当前是不是手机壳算。
 * 仍然是本机偏好：在手机上勾上只影响手机，桌面那份不受牵连。
 */
export const COST_KEY = "agent-web.usage.cost";

/**
 * 侧栏「每个项目默认显示几个会话」（其余折成一行「还有 N 个…」）。
 *
 * 默认 10：侧栏就那么点高，91 个会话全铺开会把下面的「文件管理」顶没。
 * 但「默认」不等于「硬编码」—— 用户 2026-10-29 要能在 设置 → 界面 → 侧栏 里改（不同人屏幕高度差很多）。
 * 仍然走本机偏好（localStorage）：它只决定这台机器上怎么看侧栏，不需要多设备一致，也不用保存。
 */
export const SESSIONS_PER_PROJECT_KEY = "agent-web.sidebar.sessionsPerProject";
export const SESSIONS_PER_PROJECT_DEFAULT = 10;
export const SESSIONS_PER_PROJECT_MIN = 1;
export const SESSIONS_PER_PROJECT_MAX = 50;

/**
 * 对话里图片的**最大宽度**（px，0 = 原尺寸不额外收）。
 *
 * 为什么要有：截图是按物理像素存的，光按设备像素比折回逻辑尺寸还不够 ——
 * 一张 976px 的截图折完还有 488px，在气泡里跟正文一样大，看着就是「太大了」。
 * 所以再压一道**可调上限**，默认 400：够看清结构，看不清就点开（图片查看器给的是原图）。
 *
 * 与 `image-display.ts` 的关系：那边负责「2x 截图不要显示成两倍大」，
 * 这边负责「别占满整条气泡」—— 两者取小的那个当上限。
 */
export const CHAT_IMAGE_WIDTH_KEY = "agent-web.chat.imageMaxWidth";
export const CHAT_IMAGE_WIDTH_DEFAULT = 400;

/**
 * 本机偏好的**安全读写**（字符串版）。
 *
 * 为什么要包一层：`localStorage` 在 Safari 无痕、禁用站点数据、iframe 跨站、配额满时会直接抛
 * SecurityError / QuotaExceededError。裸读裸写出现在首帧或 effect 里，就是**整页白屏**；
 * 栏宽/顶栏这种纯观感的状态不值得为它冒这个风险。
 */
export function readStored(key: string): string | null {
	try {
		return localStorage.getItem(key);
	} catch {
		return null; // 读不了就当没存过
	}
}

export function writeStored(key: string, value: string): void {
	try {
		localStorage.setItem(key, value);
	} catch {
		// 存不下就只在本页生效
	}
}

export function readStoredBool(key: string, fallback: boolean): boolean {
	try {
		const raw = localStorage.getItem(key);
		if (raw === "1") return true;
		if (raw === "0") return false;
		return fallback;
	} catch {
		return fallback; // 隐私模式禁 localStorage：用默认值，不抛错
	}
}

/**
 * 这个偏好在这台设备上有没有被写过。
 *
 * 用来区分「用户明确选了 false」和「还没选过、只是拿到默认值」—— 只有后者才该被一次性迁移改写。
 */
export function hasStoredPref(key: string): boolean {
	try {
		return localStorage.getItem(key) !== null;
	} catch {
		return true; // 隐私模式读不了：当成「已有值」，别反复迁移
	}
}

export function writeStoredBool(key: string, value: boolean): void {
	try {
		localStorage.setItem(key, value ? "1" : "0");
	} catch {
		// 存不下就只在本页生效
	}
	window.dispatchEvent(new CustomEvent<{ key: string; value: boolean }>(PREF_EVENT, { detail: { key, value } }));
}

/** 订阅某个偏好的变化（只回调同名 key，别的偏好改动不会吵到它） */
export function onPrefChange(key: string, callback: (value: boolean) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<{ key: string; value: boolean }>).detail;
		if (detail?.key === key) callback(detail.value);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== key) return;
		callback(readStoredBool(key, false));
	};
	window.addEventListener(PREF_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(PREF_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}

/* ------------------------------------------------------------------------- */
/* 数字型偏好（目前只有「每个项目显示几个会话」）                                  */
/* ------------------------------------------------------------------------- */

/**
 * 数字偏好单独一个事件。
 *
 * 为什么不复用上面那个 `PREF_EVENT`：它的 `detail.value` 是布尔，同一套事件里混两种类型，
 * 监听方拿到的值会惄惄变味（数字 10 当成 `true`，于是「显示 1 条」和「显示 10 条」看起来一样）。
 */
const PREF_NUMBER_EVENT = "agent-web:pref-number";

/** 纯函数：把读到的/输进来的数字夹到合法区间（非法值退回默认值） */
export function clampPrefNumber(value: unknown, fallback: number, min: number, max: number): number {
	// 空串 / null 来自「输入框被清空」，不是「用户想要 0 条」—— 退默认值更符合直觉
	if (value === null || value === undefined || value === "") return fallback;
	const parsed = typeof value === "number" ? value : Number(value);
	if (!Number.isFinite(parsed)) return fallback;
	return Math.min(max, Math.max(min, Math.round(parsed)));
}

export function readStoredNumber(key: string, fallback: number, min: number, max: number): number {
	const raw = readStored(key);
	if (raw === null || raw.trim() === "") return fallback;
	return clampPrefNumber(raw, fallback, min, max);
}

export function writeStoredNumber(key: string, value: number): void {
	writeStored(key, String(value));
	try {
		window.dispatchEvent(
			new CustomEvent<{ key: string; value: number }>(PREF_NUMBER_EVENT, { detail: { key, value } }),
		);
	} catch {
		// 没有 window（SSR / 测试）就算了，本页自己已经拿到新值
	}
}

/** 订阅数字偏好：同页靠自定义事件，跨标签页靠 `storage` */
export function onNumberPrefChange(key: string, callback: (value: number) => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<{ key: string; value: number }>).detail;
		if (detail?.key === key) callback(detail.value);
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key !== key) return;
		const raw = event.newValue === null ? "" : event.newValue;
		const value = Number(raw);
		if (Number.isFinite(value)) callback(value);
	};
	window.addEventListener(PREF_NUMBER_EVENT, onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(PREF_NUMBER_EVENT, onCustom);
		window.removeEventListener("storage", onStorage);
	};
}
