import { useEffect, useRef } from "react";
import { COMPOSER_ITEM_KEY, hasStoredPref, writeStoredBool } from "./ui-prefs.ts";

/** 「快捷指令」显隐在本机偏好里的 key（和设置面板里那个勾选框同一个） */
const QUICK_KEY = COMPOSER_ITEM_KEY("quick");

/**
 * 一次性迁移：把服务端的 `quickPhrasesEnabled` 抄成本机偏好。
 *
 * 这个开关以前存在服务端（多设备一致），现在跟「模板 / 想想」一样存 localStorage，
 * 于是手机和桌面可以各设各的。但升级上来的人本机还没有这个 key，直接读默认值 `true`
 * 会让「桌面上明明关过」的人又看见那一行 —— 所以首次读到快照时先抄一份旧值过来。
 *
 * 抄完就断干净：之后改手机还是改桌面，都只影响改的那台设备。
 *
 * 写入用 ref 挡住：`writeStoredBool` 会派发事件、触发重渲染，而快照推送时
 * `serverEnabled` 还会再变，不挡住就会反复写盘。
 *
 * `serverEnabled === undefined`（还没拿到快照）时不动手，等真实值到了再判断。
 */
export function useSeedQuickFromServer(serverEnabled: boolean | undefined): void {
	const done = useRef(false);
	useEffect(() => {
		if (done.current || serverEnabled === undefined) return;
		done.current = true;
		if (hasStoredPref(QUICK_KEY)) return; // 本机自己选过：用户的话优先，不动
		writeStoredBool(QUICK_KEY, serverEnabled);
	}, [serverEnabled]);
}
