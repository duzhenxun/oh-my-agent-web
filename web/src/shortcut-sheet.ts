/**
 * 快捷键速查表浮层（模块级 store，同 `image-viewer.ts` / `toast.ts` 的做法）。
 *
 * 为什么要有：快捷键能改之后，「我到底绑了什么」就成了一个必须**随时能查**的事实 ——
 * 让用户钻进「设置 → 快捷键」翻一遍太绕，而按错键又找不到原因时最需要它。
 *
 * 为什么放在 App 之外：开它的入口有两处（全局快捷键、设置面板里那颗按钮），
 * 两处都不在同一个组件树位置；存成模块级状态，`components/ShortcutSheet.tsx` 在 App 里挂一次即可。
 */
import { useSyncExternalStore } from "react";
import {
	SHORTCUT_DEFS,
	formatCombo,
	isMacPlatform,
	normalizeCombo,
	type ShortcutId,
	type ShortcutMap,
} from "./shortcuts.ts";

let open = false;
const listeners = new Set<() => void>();

function emit(): void {
	for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => {
		listeners.delete(listener);
	};
}

export function openShortcutSheet(): void {
	if (open) return;
	open = true;
	emit();
}

export function closeShortcutSheet(): void {
	if (!open) return;
	open = false;
	emit();
}

/** ⌘/ 再按一次就关掉（跟大多数「帮助 / 速查」浮层的习惯一致） */
export function toggleShortcutSheet(): void {
	if (open) closeShortcutSheet();
	else openShortcutSheet();
}

export function useShortcutSheetOpen(): boolean {
	return useSyncExternalStore(subscribe, () => open);
}

/** 速查表的一行（`combo` 已经是**给人看**的文案，未绑定是 null） */
type SheetRow = {
	id: ShortcutId;
	label: string;
	labelEn: string;
	combo: string | null;
};

/**
 * 纯函数：把当前键表整理成「按定义表顺序」的行。
 *
 * 顺序照 `SHORTCUT_DEFS`（= 设置面板里的顺序）：速查表和设置面板读起来应该一样，
 * 用户在两边找同一个动作时不该换位置。未绑定的也**照样列出来**（显示「未设置」），
 * 否则「我记得有这个动作，怎么不在表里」又会变成一个谜。
 */
export function sheetRows(map: ShortcutMap, mac = isMacPlatform()): SheetRow[] {
	return SHORTCUT_DEFS.map((def) => {
		const combo = normalizeCombo(map[def.id]);
		return {
			id: def.id,
			label: def.label,
			labelEn: def.labelEn,
			combo: combo ? formatCombo(combo, mac) : null,
		};
	});
}
