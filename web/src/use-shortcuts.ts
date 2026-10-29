/**
 * 读快捷键表的 hook：本页改了就跟着变（`writeShortcuts` 会广播），别的标签页改也同步
 * （`storage` 事件）。纯逻辑全在 `shortcuts.ts`，这里只做「订阅 + 重读」。
 */
import { useCallback, useEffect, useState } from "react";
import { storedShortcuts, subscribeShortcuts, writeShortcuts, type ShortcutMap } from "./shortcuts.ts";

export function useShortcuts(): [ShortcutMap, (next: ShortcutMap) => void] {
	const [map, setMap] = useState<ShortcutMap>(() => storedShortcuts());
	useEffect(() => subscribeShortcuts(() => setMap(storedShortcuts())), []);
	const save = useCallback((next: ShortcutMap) => writeShortcuts(next), []);
	return [map, save];
}
