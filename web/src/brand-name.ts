/**
 * 顶栏门面（logo + 它后面那串名字）的**本机**偏好：各自显示 / 隐藏、改名、换 logo（设置 → 外观）。
 *
 * 为什么放本机而不是 `set_settings`：这只是「这台机器的门面怎么显示」，
 * 和主题、聊天字号同一类判据（见 ui-prefs.ts 头注释）—— 换设备还要等一次服务端往返不值得。
 *
 * 为什么不直接改 `brand.ts` 的 `BRAND_NAME`：那是**产品**的名字（服务端登录框、升级命令
 * 都靠它），用户改的只是**界面上显示的那一串**；两件事混在一起，
 * 下次要改包名时会分不清哪一处是真名、哪一处是用户自己起的名字。
 *
 * 名字不只出现在顶栏：浏览器标签页、新会话抬头跟着它，**推送通知的标题**也是
 * （那一条在服务端拼，所以改名后要顺手同步到本机的订阅 —— 见 `schedulePushBrandSync`）。
 *
 * 默认值永远是 `BRAND_NAME`：留空 / 只填空格 → 回落到默认名，而不是显示一片空白。
 */
import { BRAND_NAME } from "./brand.ts";
import { onPrefChange, readStored, readStoredBool, writeStored, writeStoredBool } from "./ui-prefs.ts";
import { syncPushBrandName } from "./push.ts";

/** 用户起的名字（存**已清洗**的值；空串表示「没改过」） */
const BRAND_NAME_KEY = "agent-web.brand.name";
/** 顶栏要不要显示这串名字（默认显示） */
const BRAND_NAME_SHOW_KEY = "agent-web.brand.show";
/** 自定义 logo（存 data URL；空串 = 用产品自带的 /favicon.svg） */
export const BRAND_LOGO_KEY = "agent-web.brand.logo";
/** 顶栏要不要显示 logo（默认显示：它比名字还省地方，一般没人要关） */
const BRAND_LOGO_SHOW_KEY = "agent-web.brand.logo.show";
/**
 * 顶栏那串名字显示**什么**（用户 2026-11-24：「设置中可以设置，是显示品牌名，还是显示引擎名」）。
 *   - `brand`（默认）：产品名（老用户存过的自定义名仍然优先，不被这次改动作废）；
 *   - `engine`：当前引擎的名字（pi → PiAgent、codex → CodexAgent…，见 brand.ts 的 engineBrandName）。
 */
const BRAND_MODE_KEY = "agent-web.brand.mode";
export type BrandMode = "brand" | "engine";
/** 名字上限：顶栏是横向空间，超过这个长度只会被 CSS 截成省略号，不如直接拦在输入处 */
export const BRAND_NAME_MAX = 24;

/** 名字变了但 React 不知道 —— 同页靠这个事件通知（跨标签页另有 `storage`） */
const BRAND_NAME_EVENT = "agent-web:brand-name";
/** 与本模块相关的所有 key：任意一条变了都要叫醒订阅者（顶栏 / 设置面板重画） */
const BRAND_KEYS = [BRAND_NAME_KEY, BRAND_NAME_SHOW_KEY, BRAND_LOGO_KEY, BRAND_LOGO_SHOW_KEY, BRAND_MODE_KEY];

/** 去首尾空白、把连续空白折成一个空格、按上限截断（纯函数，好测） */
function sanitizeBrandName(raw: string | null | undefined): string {
	if (!raw) return "";
	return raw.replace(/\s+/g, " ").trim().slice(0, BRAND_NAME_MAX).trim();
}

/** 用户存下来的名字（没改过 = 空串）。设置面板的输入框用它，才不会被默认名冒充成「用户起的」 */
export function storedBrandName(): string {
	return sanitizeBrandName(readStored(BRAND_NAME_KEY));
}

/** 界面上该显示的名字：按设置里的模式选（品牌名 / 引擎名） */
export function currentBrandName(): string {
	if (currentBrandMode() === "engine") return defaultBrandName;
	return storedBrandName() || BRAND_NAME;
}

/** 顶栏显示什么：`brand` = 产品名（及老用户的自定义名），`engine` = 当前引擎名 */
export function currentBrandMode(): BrandMode {
	return readStored(BRAND_MODE_KEY) === "engine" ? "engine" : "brand";
}

/** 切换显示模式；变了才写 + 叫醒订阅者（顶栏 / 标签页标题 / 设置面板一起重画） */
export function setBrandMode(mode: BrandMode): void {
	if (mode === currentBrandMode()) return;
	writeStored(BRAND_MODE_KEY, mode);
	notifyBrandName();
}

/**
 * 「没自定义名字时」的默认名：跟随当前引擎（App 在引擎变化时调 `setDefaultBrandName`）。
 *
 * 为什么不直接写 `BRAND_NAME`：引擎（pi / codex / opencode / dsh / claude）是可切的，
 * 用户要知道「现在跟我说话的是谁」—— 用 pi 时顶栏就是 PiAgent。
 * 存起来的自定义名字仍然优先，引擎变化抢不走它。
 */
let defaultBrandName: string = BRAND_NAME;

/** 引擎变了（或首次拿到快照）：换默认名；与当前值相同时什么都不做（不白叫醒订阅者） */
export function setDefaultBrandName(name: string | null | undefined): void {
	const next = sanitizeBrandName(name) || BRAND_NAME;
	if (next === defaultBrandName) return;
	defaultBrandName = next;
	notifyBrandName();
}

/** 当前的默认名（测试与设置面板的 placeholder 用它） */
export function currentDefaultBrandName(): string {
	return defaultBrandName;
}

/** 防抖窗口：比一个正常人的打字间隔长一点，停在半路就只同步最后那一个名字 */
const PUSH_BRAND_SYNC_DELAY_MS = 800;
let pushBrandTimer: ReturnType<typeof setTimeout> | null = null;

/** 存名字（空串 = 恢复默认）；写进去的永远是清洗过的值 */
export function setBrandName(raw: string): void {
	const next = sanitizeBrandName(raw);
	// 值没变就不写（改名输入框每敲一下都会调进来；也避免白推一次同步）
	if (next === storedBrandName()) return;
	writeStored(BRAND_NAME_KEY, next);
	notifyBrandName();
	schedulePushBrandSync();
}

/**
 * 改了名，顺手把新名字告诉服务端（推送标题里要用它）。
 *
 * 为什么不在设置面板里直接请求，也不在 `useBrandName` 里发：
 *   - 输入框是**逐字生效**的，一次改名会触发很多次 —— 必须防抖；
 *   - `useBrandName` 被三四个组件同时用，放里面就是一模一样的请求发三遍；
 *   模块级定时器天然就是「一个页面一份」，正好对应「一台设备一条订阅」。
 */
function schedulePushBrandSync(): void {
	if (pushBrandTimer !== null) clearTimeout(pushBrandTimer);
	pushBrandTimer = setTimeout(() => {
		pushBrandTimer = null;
		// 发**用户存下来的名字**（而不是回落后的默认名）：恢复默认时发空串 = 清掉这条记录，
		// 以后产品真改了名，这台设备的通知标题还能跟着走。
		// 没订阅 / 不支持推送 / 请求失败都静默：改名不能因为推送不可用而报错
		void syncPushBrandName(storedBrandName());
	}, PUSH_BRAND_SYNC_DELAY_MS);
}

export function resetBrandName(): void {
	setBrandName("");
}

export function currentBrandShown(): boolean {
	return readStoredBool(BRAND_NAME_SHOW_KEY, true);
}

export function setBrandShown(value: boolean): void {
	writeStoredBool(BRAND_NAME_SHOW_KEY, value);
	// writeStoredBool 已经派发了 PREF_EVENT，但本模块的订阅者等的是自己的事件
	notifyBrandName();
}

/** 订阅「名字 / 显隐」的变化（只回调本组 key） */
export function onBrandNameChange(callback: () => void): () => void {
	const onCustom = (event: Event) => {
		const detail = (event as CustomEvent<{ key: string }>).detail;
		if (!detail?.key || BRAND_KEYS.includes(detail.key)) callback();
	};
	const onStorage = (event: StorageEvent) => {
		if (event.key === null || BRAND_KEYS.includes(event.key)) callback();
	};
	window.addEventListener(BRAND_NAME_EVENT, onCustom);
	// writeStoredBool 走的是 ui-prefs 的事件名，这里再挂一份，显隐开关也能叫醒订阅者
	window.addEventListener("agent-web:pref", onCustom);
	window.addEventListener("storage", onStorage);
	return () => {
		window.removeEventListener(BRAND_NAME_EVENT, onCustom);
		window.removeEventListener("agent-web:pref", onCustom);
		window.removeEventListener("storage", onStorage);
	};
}

function notifyBrandName(): void {
	window.dispatchEvent(new CustomEvent<{ key: string }>(BRAND_NAME_EVENT, { detail: { key: BRAND_NAME_KEY } }));
}

/** 自定义 logo（没换过 = 空串，调用方回落到产品自带的那个） */
export function currentBrandLogo(): string {
	return readStored(BRAND_LOGO_KEY) ?? "";
}

/** 换 logo（传空串 = 恢复产品自带那个）；存进去的必须是已经缩好的 data URL（见 brand-logo.ts） */
export function setBrandLogo(dataUrl: string | null | undefined): void {
	const next = (dataUrl ?? "").trim();
	if (next === (readStored(BRAND_LOGO_KEY) ?? "")) return;
	writeStored(BRAND_LOGO_KEY, next);
	notifyBrandName();
}

export function currentBrandLogoShown(): boolean {
	return readStoredBool(BRAND_LOGO_SHOW_KEY, true);
}

export function setBrandLogoShown(value: boolean): void {
	writeStoredBool(BRAND_LOGO_SHOW_KEY, value);
	notifyBrandName();
}

/** 显隐开关自己的订阅（设置面板的勾选框与顶栏共用） */
export function onBrandShownChange(callback: (value: boolean) => void): () => void {
	const offPref = onPrefChange(BRAND_NAME_SHOW_KEY, callback);
	const offStorage = onBrandNameChange(() => callback(currentBrandShown()));
	return () => {
		offPref();
		offStorage();
	};
}
