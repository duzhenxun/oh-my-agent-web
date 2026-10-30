/**
 * 设置面板顶部那排标签：**拖动排序**，并且**排第一的那个就是下次点开设置默认显示的页**。
 *
 * 这个文件只管「顺序」这一件事，不碰 React 的指针事件（交互在 `components/SettingsTabStrip.tsx`）：
 *  - 槽位几何 → 目标下标（`dropSettingsIndex`）；
 *  - 下标 → 新顺序（`previewSettingsOrder` / `moveSettingsTab`）；
 *  - 存取（`readSettingsOrder` / `saveSettingsOrder` / `defaultSettingsTab`）；
 *  - 组件用的订阅钩子（`useSettingsTabOrder`）。
 *
 * 纯本机偏好：只写 localStorage（`agent-web.` 前缀），同页用自定义事件、跨标签页用 `storage` 事件同步；
 * 不进会话快照、不上服务端 —— 换个浏览器就是出厂顺序，不会出现「同步过来一页不相干的顺序」。
 *
 * 存坏 / 存旧也安全：清洗规则是「未知项丢掉、重复项只留第一个、缺的项按出厂顺序补回去」，
 * 所以以后往设置里加第八页，老用户不会被旧的七项顺序卡住看不见它。
 */
import { useCallback, useEffect, useState } from "react";
import { readStored, writeStored } from "./ui-prefs.ts";

/** 出厂顺序：界面在最左 —— 第一次打开设置看到的还是「界面」这页。 */
export const DEFAULT_SETTINGS_ORDER: readonly SettingsTabId[] = [
	"ui",
	"general",
	"appearance",
	"theme",
	"language",
	"shortcuts",
	"remote",
];

export type SettingsTabId = "ui" | "general" | "appearance" | "theme" | "language" | "shortcuts" | "remote";

const ORDER_KEY = "agent-web.settings-tab-order.v1";
/** 同页通知：拖完一处，别的订阅者（其它面板实例 / 下一次打开）立刻跟上 */
const SETTINGS_ORDER_EVENT = "agent-web:settings-tab-order";

const KNOWN_TABS: ReadonlySet<string> = new Set(DEFAULT_SETTINGS_ORDER);

/** 一个槽位（视口坐标）：拖动期间不重新量，所有阈值都拿这份快照算，避免越界后阈值跟着跑。 */
export type TabSlot = { left: number; width: number };

export function normalizeSettingsOrder(value: unknown): SettingsTabId[] {
	const input = Array.isArray(value) ? value : [];
	const kept: SettingsTabId[] = [];
	for (const item of input) {
		if (typeof item !== "string" || !KNOWN_TABS.has(item)) continue;
		if (kept.includes(item as SettingsTabId)) continue;
		kept.push(item as SettingsTabId);
	}
	for (const id of DEFAULT_SETTINGS_ORDER) if (!kept.includes(id)) kept.push(id);
	return kept;
}

export function parseSettingsOrder(raw: string | null): SettingsTabId[] {
	if (!raw) return [...DEFAULT_SETTINGS_ORDER];
	try {
		return normalizeSettingsOrder(JSON.parse(raw));
	} catch {
		return [...DEFAULT_SETTINGS_ORDER]; // 存了半截 JSON：当没存过，不要因此白屏
	}
}

function readSettingsOrder(): SettingsTabId[] {
	return parseSettingsOrder(readStored(ORDER_KEY));
}

/** 落盘前先清洗；返回真正写下去的那一份，调用方可以直接当新状态用。 */
function saveSettingsOrder(order: readonly SettingsTabId[]): SettingsTabId[] {
	const next = normalizeSettingsOrder(order);
	writeStored(ORDER_KEY, JSON.stringify(next));
	if (typeof window !== "undefined") {
		window.dispatchEvent(new CustomEvent<SettingsTabId[]>(SETTINGS_ORDER_EVENT, { detail: next }));
	}
	return next;
}

/** 打开设置时先显示哪一页 = 顺序里的第一个。 */
export function defaultSettingsTab(): SettingsTabId {
	return readSettingsOrder()[0] ?? DEFAULT_SETTINGS_ORDER[0];
}

function sameSettingsOrder(a: readonly SettingsTabId[], b: readonly SettingsTabId[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 把第 `fromIndex` 个挪到第 `toIndex` 个（越界自动夹住，不循环，拖到头就停）。 */
export function moveSettingsTab(order: readonly SettingsTabId[], fromIndex: number, toIndex: number): SettingsTabId[] {
	const from = Math.max(0, Math.min(fromIndex, order.length - 1));
	const to = Math.max(0, Math.min(toIndex, order.length - 1));
	if (from === to) return [...order];
	const next = [...order];
	const [moved] = next.splice(from, 1);
	if (moved) next.splice(to, 0, moved);
	return next;
}

/**
 * 拖动中：把某个标签插到第 `toIndex` 个位置后的完整顺序（`order` 里必须包含它）。
 * `toIndex` 是「移除它之后那份列表」里的下标，所以拖到原处不会有任何变化。
 */
export function previewSettingsOrder(
	order: readonly SettingsTabId[],
	dragged: SettingsTabId,
	toIndex: number,
): SettingsTabId[] {
	const rest = order.filter((id) => id !== dragged);
	const index = Math.max(0, Math.min(Math.round(toIndex), rest.length));
	const next = [...rest];
	next.splice(index, 0, dragged);
	return next;
}

/**
 * 「拖到哪儿了」→ 目标下标：数一数有多少个**其它**标签的中心落在拖动项中心左边。
 *
 * 比的是拖动开始时量下的原始槽位，不是当前让位后的位置 —— 否则邻居一让位阈值也动，
 * 指针停在边界上就会来回抖，标签跟着跳。
 */
export function dropSettingsIndex(
	order: readonly SettingsTabId[],
	dragged: SettingsTabId,
	draggedCenterX: number,
	slots: readonly TabSlot[],
): number {
	const fromIndex = order.indexOf(dragged);
	let index = 0;
	for (let i = 0; i < order.length; i += 1) {
		if (i === fromIndex) continue;
		const slot = slots[i];
		if (!slot) continue;
		if (draggedCenterX > slot.left + slot.width / 2) index += 1;
	}
	return index;
}

/**
 * 每个标签在「预览顺序」里该落在哪个槽位上（返回 `id → 视口左缘`）。
 *
 * 拖动期间真实 DOM 顺序不动，兄弟靠 transform 让位；松手时真顺序一次性换成预览顺序、
 * 同时撤掉 transform —— 两者位置完全一致，所以看不到「松手跳一下」。纯计算放这里方便钉死行为。
 */
export function previewSlotLefts(
	order: readonly SettingsTabId[],
	preview: readonly SettingsTabId[],
	slots: readonly TabSlot[],
): Map<SettingsTabId, number> {
	const result = new Map<SettingsTabId, number>();
	for (const id of order) {
		const position = preview.indexOf(id);
		const slot = slots[position];
		if (position < 0 || !slot) continue;
		result.set(id, slot.left);
	}
	return result;
}

/**
 * 当前顺序 + 改顺序的方法。改完会通知所有订阅者（同页事件 + 其它标签页的 storage 事件），
 * 所以「拖完关掉设置、再点开」拿到的就是新顺序，不用刷新页面。
 */
export function useSettingsTabOrder(): [SettingsTabId[], (next: readonly SettingsTabId[]) => void] {
	const [order, setOrder] = useState<SettingsTabId[]>(() => readSettingsOrder());

	useEffect(() => {
		const adopt = (value: unknown) => {
			const next = normalizeSettingsOrder(value);
			setOrder((current) => (sameSettingsOrder(current, next) ? current : next));
		};
		const onLocal = (event: Event) => adopt((event as CustomEvent<SettingsTabId[]>).detail);
		const onStorage = (event: StorageEvent) => {
			// key 为 null = 别的页面调了 localStorage.clear()
			if (event.key === null || event.key === ORDER_KEY) adopt(parseSettingsOrder(event.newValue));
		};
		window.addEventListener(SETTINGS_ORDER_EVENT, onLocal);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(SETTINGS_ORDER_EVENT, onLocal);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const update = useCallback((value: readonly SettingsTabId[]) => {
		const next = saveSettingsOrder(value);
		setOrder((current) => (sameSettingsOrder(current, next) ? current : next));
	}, []);

	return [order, update];
}
