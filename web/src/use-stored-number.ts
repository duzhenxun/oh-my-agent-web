import { useEffect, useState } from "react";
import { clampPrefNumber, onNumberPrefChange, readStoredNumber, writeStoredNumber } from "./ui-prefs.ts";

/**
 * 数字界面偏好 + 同步（同页/跨标签页都会更新，见 ui-prefs.ts 的 `onNumberPrefChange`）。
 *
 * 读写都夹在 `[min, max]` 里：用户手改 localStorage、或者输入框里粘进一个 `99999`，
 * 侧栏都不会因此变成一整页滚动条。
 */
export function useStoredNumber(
	key: string,
	fallback: number,
	min: number,
	max: number,
): [number, (value: number) => void] {
	const [value, setValue] = useState<number>(() => readStoredNumber(key, fallback, min, max));
	useEffect(
		() => onNumberPrefChange(key, (next) => setValue(clampPrefNumber(next, fallback, min, max))),
		[key, fallback, min, max],
	);
	return [value, (next: number) => writeStoredNumber(key, clampPrefNumber(next, fallback, min, max))];
}
