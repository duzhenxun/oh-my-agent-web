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
 *
 * `fallback` 可以是单个布尔（整组一个默认），也可以是 `(item) => boolean` —— 后者给
 * 「同一组里默认值不一样」的表用（顶栏：只有模型 / 技能 / 语音 / MCP 默认勾上）。
 */
export function usePrefFlags<T extends string>(
	items: readonly T[],
	keyOf: (item: T) => string,
	fallback: boolean | ((item: T) => boolean) = true,
): [Record<T, boolean>, (item: T, value: boolean) => void] {
	const defaultOf = (item: T): boolean => (typeof fallback === "function" ? fallback(item) : fallback);
	const [values, setValues] = useState<Record<T, boolean>>(
		() => Object.fromEntries(items.map((item) => [item, readStoredBool(keyOf(item), defaultOf(item))])) as Record<T, boolean>,
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
	}, [items, keyOf]);
	return [values, (item, value) => writeStoredBool(keyOf(item), value)];
}
