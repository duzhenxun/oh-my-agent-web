import { useEffect, useState } from "react";
import { onPrefChange, readStoredBool, writeStoredBool } from "./ui-prefs.ts";

/**
 * 一组布尔界面偏好的读写 + 同步（设置面板里的勾选框和真正用它渲染的地方共用这一份）。
 *
 * 一次订阅整组 key，而不是每项一个 hook：设置面板里要一次渲染整排勾选框，
 * 拆成 N 个 hook 反而要多写 N 次；这里用 `onPrefChange` 的「只回调同名 key」特性逐项更新。
 *
 * `items` / `keyOf` 必须是**模块级常量**（不要每次渲染现造数组或箭头函数），
 * 否则订阅会在每次渲染时重建。
 */
export function usePrefFlags<T extends string>(
	items: readonly T[],
	keyOf: (item: T) => string,
	fallback = true,
): [Record<T, boolean>, (item: T, value: boolean) => void] {
	const [values, setValues] = useState<Record<T, boolean>>(
		() => Object.fromEntries(items.map((item) => [item, readStoredBool(keyOf(item), fallback)])) as Record<T, boolean>,
	);
	useEffect(() => {
		const offs = items.map((item) =>
			onPrefChange(keyOf(item), (value) =>
				setValues((current) => (current[item] === value ? current : { ...current, [item]: value })),
			),
		);
		return () => {
			for (const off of offs) off();
		};
	}, [items, keyOf, fallback]);
	return [values, (item, value) => writeStoredBool(keyOf(item), value)];
}
