/**
 * 设置面板顶部那排标签（界面 / 对话 / 外观 / 主题 / 语言 / 快捷键）的**手动排序**。
 *
 * 用户 2026-10-29：「上面这些可以手动调位置。哪个在最左边第一个，到时点开设置时就显示它」。
 * 所以这里不只存顺序，**打开设置时的默认页 = 顺序里的第一项**（`SettingsPanel` 的初始 state）。
 *
 * 与弹窗 Tab 的顺序（`panel-order.ts`）是同一套纪律：纯本机偏好、localStorage、
 * `agent-web.` 前缀、同页自定义事件 + 跨标签页 `storage` 同步；不进快照、不上云。
 * 存坏数据时补齐缺失项、去掉未知项与重复项 —— 以后新增一个设置页也不会因为读过旧顺序而消失。
 */
import { useCallback, useEffect, useState } from "react";
import { readStored, writeStored } from "./ui-prefs.ts";

export type SettingsTabId = "general" | "appearance" | "theme" | "language" | "ui" | "shortcuts";

/** 出厂顺序：界面在最左，于是第一次打开设置显示的就是界面（跟拆 tab 之前一样）。 */
export const DEFAULT_SETTINGS_TAB_ORDER: readonly SettingsTabId[] = [
	"ui",
	"general",
	"appearance",
	"theme",
	"language",
	"shortcuts",
];

const SETTINGS_TAB_ORDER_KEY = "agent-web.settings-tab-order.v1";
const SETTINGS_TAB_ORDER_EVENT = "agent-web:settings-tab-order";

const TAB_IDS = new Set<string>(DEFAULT_SETTINGS_TAB_ORDER);

/** 清洗持久化 / 外部传入的顺序；返回值永远恰好包含全部设置页且各一次。 */
function normalizeTabOrder(value: unknown): SettingsTabId[] {
	const input = Array.isArray(value) ? value : [];
	const valid = input.filter(
		(id, index): id is SettingsTabId => typeof id === "string" && TAB_IDS.has(id) && input.indexOf(id) === index,
	);
	return [...valid, ...DEFAULT_SETTINGS_TAB_ORDER.filter((id) => !valid.includes(id))];
}

function readTabOrder(raw: string | null): SettingsTabId[] {
	if (!raw) return [...DEFAULT_SETTINGS_TAB_ORDER];
	try {
		return normalizeTabOrder(JSON.parse(raw));
	} catch {
		return [...DEFAULT_SETTINGS_TAB_ORDER];
	}
}

export function sameTabOrder(a: readonly SettingsTabId[], b: readonly SettingsTabId[]): boolean {
	return a.length === b.length && a.every((id, index) => id === b[index]);
}

/** 把某个标签移到目标下标；目标下标以「移除拖动项之后」的列表计算（与 panel-order 同一约定）。 */
export function moveSettingsTab(order: readonly SettingsTabId[], id: SettingsTabId, toIndex: number): SettingsTabId[] {
	const fromIndex = order.indexOf(id);
	if (fromIndex < 0) return [...order];
	const rest = order.filter((item) => item !== id);
	const index = Math.max(0, Math.min(Math.round(toIndex), rest.length));
	const next = [...rest];
	next.splice(index, 0, id);
	return next;
}

/** 当前顺序的第一项 —— 打开设置时先显示它。 */
export function firstSettingsTab(): SettingsTabId {
	return (readTabOrder(readStored(SETTINGS_TAB_ORDER_KEY))[0] ?? DEFAULT_SETTINGS_TAB_ORDER[0]) as SettingsTabId;
}

/** 设置页标签的共享顺序；任何一处排序（拖拽）都会通知所有订阅者。 */
export function useSettingsTabOrder(): [SettingsTabId[], (next: readonly SettingsTabId[]) => void] {
	const [order, setOrder] = useState<SettingsTabId[]>(() => readTabOrder(readStored(SETTINGS_TAB_ORDER_KEY)));

	useEffect(() => {
		const apply = (value: unknown) => {
			const next = normalizeTabOrder(value);
			setOrder((current) => (sameTabOrder(current, next) ? current : next));
		};
		const onCustom = (event: Event) => apply((event as CustomEvent<SettingsTabId[]>).detail);
		const onStorage = (event: StorageEvent) => {
			if (event.key === SETTINGS_TAB_ORDER_KEY) apply(readTabOrder(event.newValue));
		};
		window.addEventListener(SETTINGS_TAB_ORDER_EVENT, onCustom);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(SETTINGS_TAB_ORDER_EVENT, onCustom);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const update = useCallback((value: readonly SettingsTabId[]) => {
		const next = normalizeTabOrder(value);
		setOrder((current) => (sameTabOrder(current, next) ? current : next));
		writeStored(SETTINGS_TAB_ORDER_KEY, JSON.stringify(next));
		window.dispatchEvent(new CustomEvent<SettingsTabId[]>(SETTINGS_TAB_ORDER_EVENT, { detail: next }));
	}, []);

	return [order, update];
}
