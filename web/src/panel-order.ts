/**
 * 工作台面板的排列顺序：弹窗 Tab 与顶栏入口共用这一份。
 *
 * 这是纯本机的界面偏好，和主题 / 弹窗尺寸一样存 localStorage；同页用自定义事件同步，
 * 跨浏览器标签页用 storage 事件同步。存坏数据时补齐缺失项、去掉未知项和重复项，
 * 以后新增面板也不会因为读过一份旧顺序而消失。
 */
import { useCallback, useEffect, useState } from "react";
import type { PanelIconName } from "./components/PanelIcon.tsx";
import { readStored, writeStored } from "./ui-prefs.ts";

export type PanelKey = PanelIconName;

const PANEL_ORDER_KEY = "agent-web.panel-order.v1";
const PANEL_ORDER_EVENT = "agent-web:panel-order";

/** 与旧版界面一致的初始顺序（语音在前，设置在最后）。 */
const DEFAULT_PANEL_ORDER: readonly PanelKey[] = [
	"voice",
	"skills",
	"push",
	"plugins",
	"mcp",
	"models",
	"agents",
	"settings",
];

const PANEL_KEYS = new Set<string>(DEFAULT_PANEL_ORDER);

/** 清洗持久化 / 外部传入的顺序；返回值永远恰好包含八个面板且各一次。 */
function normalizePanelOrder(value: unknown): PanelKey[] {
	const input = Array.isArray(value) ? value : [];
	const valid = input.filter(
		(key, index): key is PanelKey => typeof key === "string" && PANEL_KEYS.has(key) && input.indexOf(key) === index,
	);
	return [...valid, ...DEFAULT_PANEL_ORDER.filter((key) => !valid.includes(key))];
}

/** 读 localStorage 中的 JSON；空值 / 坏 JSON 都回落到默认顺序。 */
function readPanelOrder(raw: string | null): PanelKey[] {
	if (!raw) return [...DEFAULT_PANEL_ORDER];
	try {
		return normalizePanelOrder(JSON.parse(raw));
	} catch {
		return [...DEFAULT_PANEL_ORDER];
	}
}

export function samePanelOrder(a: readonly PanelKey[], b: readonly PanelKey[]): boolean {
	return a.length === b.length && a.every((key, index) => key === b[index]);
}

/** 把某个面板移到目标下标；拖动的目标下标以「移除拖动项之后」的列表计算。 */
export function movePanel(order: readonly PanelKey[], key: PanelKey, toIndex: number): PanelKey[] {
	const fromIndex = order.indexOf(key);
	if (fromIndex < 0) return [...order];
	const rest = order.filter((item) => item !== key);
	const index = Math.max(0, Math.min(Math.round(toIndex), rest.length));
	const next = [...rest];
	next.splice(index, 0, key);
	return next;
}

/** 弹窗和顶栏的共享顺序；任何地方调用 update，两处都会立即重排。 */
export function usePanelOrder(): [PanelKey[], (next: readonly PanelKey[]) => void] {
	const [order, setOrder] = useState<PanelKey[]>(() => readPanelOrder(readStored(PANEL_ORDER_KEY)));

	useEffect(() => {
		const apply = (value: unknown) => {
			const next = normalizePanelOrder(value);
			setOrder((current) => (samePanelOrder(current, next) ? current : next));
		};
		const onCustom = (event: Event) => apply((event as CustomEvent<PanelKey[]>).detail);
		const onStorage = (event: StorageEvent) => {
			if (event.key === PANEL_ORDER_KEY) apply(readPanelOrder(event.newValue));
		};
		window.addEventListener(PANEL_ORDER_EVENT, onCustom);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(PANEL_ORDER_EVENT, onCustom);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	const update = useCallback((value: readonly PanelKey[]) => {
		const next = normalizePanelOrder(value);
		setOrder((current) => (samePanelOrder(current, next) ? current : next));
		writeStored(PANEL_ORDER_KEY, JSON.stringify(next));
		window.dispatchEvent(new CustomEvent<PanelKey[]>(PANEL_ORDER_EVENT, { detail: next }));
	}, []);

	return [order, update];
}
