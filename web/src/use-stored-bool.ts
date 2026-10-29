import { useEffect, useState } from "react";
import { onPrefChange, readStoredBool, writeStoredBool } from "./ui-prefs.ts";

/** 布尔界面偏好 + 同步（同页/跨标签页都会更新，见 ui-prefs.ts） */
export function useStoredBool(key: string, fallback: boolean): [boolean, (value: boolean) => void] {
	const [value, setValue] = useState<boolean>(() => readStoredBool(key, fallback));
	useEffect(() => onPrefChange(key, setValue), [key]);
	return [value, (next: boolean) => writeStoredBool(key, next)];
}
