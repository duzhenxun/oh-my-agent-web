/**
 * 底部状态栏项目顺序：纯前端偏好，存 localStorage，不进服务端快照。
 *
 * 清洗规则和设置页标签顺序一致：丢掉未知项、去重、补回新增项，避免旧版本或手改值把状态栏弄空。
 */
import { useEffect, useState } from "react";
import { readStored, writeStored, STATUSBAR_TOGGLES, type StatusbarToggle } from "./ui-prefs.ts";

export const DEFAULT_STATUSBAR_ORDER: readonly StatusbarToggle[] = [...STATUSBAR_TOGGLES];
const STATUSBAR_ORDER_KEY = "agent-web.statusbar-order.v1";
const STATUSBAR_ORDER_EVENT = "agent-web:statusbar-order";
const KNOWN_ITEMS: ReadonlySet<string> = new Set(DEFAULT_STATUSBAR_ORDER);

export function normalizeStatusbarOrder(value: unknown): StatusbarToggle[] {
	const input = Array.isArray(value) ? value : [];
	const kept: StatusbarToggle[] = [];
	for (const item of input) {
		if (typeof item !== "string" || !KNOWN_ITEMS.has(item)) continue;
		if (kept.includes(item as StatusbarToggle)) continue;
		kept.push(item as StatusbarToggle);
	}
	for (const item of DEFAULT_STATUSBAR_ORDER) if (!kept.includes(item)) kept.push(item);
	return kept;
}

function readStatusbarOrder(): StatusbarToggle[] {
	const raw = readStored(STATUSBAR_ORDER_KEY);
	if (!raw) return [...DEFAULT_STATUSBAR_ORDER];
	try {
		return normalizeStatusbarOrder(JSON.parse(raw));
	} catch {
		return [...DEFAULT_STATUSBAR_ORDER];
	}
}

function sameOrder(a: readonly StatusbarToggle[], b: readonly StatusbarToggle[]): boolean {
	return a.length === b.length && a.every((item, index) => item === b[index]);
}

export function saveStatusbarOrder(order: readonly StatusbarToggle[]): StatusbarToggle[] {
	const next = normalizeStatusbarOrder(order);
	writeStored(STATUSBAR_ORDER_KEY, JSON.stringify(next));
	window.dispatchEvent(new CustomEvent<StatusbarToggle[]>(STATUSBAR_ORDER_EVENT, { detail: next }));
	return next;
}

export function moveStatusbarItem(
	order: readonly StatusbarToggle[],
	fromIndex: number,
	toIndex: number,
): StatusbarToggle[] {
	const from = Math.max(0, Math.min(fromIndex, order.length - 1));
	const to = Math.max(0, Math.min(toIndex, order.length - 1));
	if (from === to) return [...order];
	const next = [...order];
	const [moved] = next.splice(from, 1);
	if (moved) next.splice(to, 0, moved);
	return next;
}

export function useStatusbarOrder(): [StatusbarToggle[], (next: readonly StatusbarToggle[]) => void] {
	const [order, setOrder] = useState<StatusbarToggle[]>(() => readStatusbarOrder());

	useEffect(() => {
		const adopt = (value: unknown) => {
			const next = normalizeStatusbarOrder(value);
			setOrder((current) => (sameOrder(current, next) ? current : next));
		};
		const onLocal = (event: Event) => adopt((event as CustomEvent<StatusbarToggle[]>).detail);
		const onStorage = (event: StorageEvent) => {
			if (event.key === null || event.key === STATUSBAR_ORDER_KEY) {
				if (event.key === null) adopt(null);
				else {
					try {
						adopt(event.newValue ? JSON.parse(event.newValue) : null);
					} catch {
						adopt(null);
					}
				}
			}
		};
		window.addEventListener(STATUSBAR_ORDER_EVENT, onLocal);
		window.addEventListener("storage", onStorage);
		return () => {
			window.removeEventListener(STATUSBAR_ORDER_EVENT, onLocal);
			window.removeEventListener("storage", onStorage);
		};
	}, []);

	return [order, (next) => setOrder(saveStatusbarOrder(next))];
}
