/**
 * 「第一下上膛、第二下才执行」的两步确认。
 *
 * 为什么不用 `window.confirm`：浏览器可以**整页屏蔽原生对话框**（Chrome 那个
 * 「阻止此页面创建更多对话框」勾上之后，`confirm` 永远返回 false）——
 * 那时危险按钮点下去一声不响、什么都不做，用户看到的就是「怎么删不掉啊？」
 * （2026-10-29 的原话，见 delete-session.ts 顶部注释）。
 *
 * 用法：`const armed = useArmed(); … onClick={() => armed.run(真的删)}`
 *  - 第一下：`armed` 变 true，按钮文案 / 底色换成「再点一次确认」；
 *  - 第二下（`ttlMs` 内）：执行；
 *  - 超过 `ttlMs` 没点：自己缩回去，免得挂在那儿等误触。
 *
 * 状态用 ref 再镜像一份 state：到底「上膛了没有」必须以 ref 为准 ——
 * 放进 `setState` 的 updater 里执行副作用会被 StrictMode 调两次（那就是删两次）。
 */
import { useCallback, useEffect, useRef, useState } from "react";

const ARMED_TTL_MS = 5000;

export function useArmed(ttlMs = ARMED_TTL_MS): { armed: boolean; run: (action: () => void) => void } {
	const [armed, setArmed] = useState(false);
	const armedRef = useRef(false);

	useEffect(() => {
		if (!armed) return;
		const timer = setTimeout(() => {
			armedRef.current = false;
			setArmed(false);
		}, ttlMs);
		return () => clearTimeout(timer);
	}, [armed, ttlMs]);

	const run = useCallback((action: () => void) => {
		if (armedRef.current) {
			armedRef.current = false;
			setArmed(false);
			action();
			return;
		}
		armedRef.current = true;
		setArmed(true);
	}, []);

	return { armed, run };
}
