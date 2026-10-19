/**
 * 「粘底」滚动：内容长高就跟着到底部，但**用户往上翻时不抢**。
 *
 * 为什么不能只在「消息条数变化」时滚（这是之前的做法，用户反馈仍然要手动往下拖）：
 *   - 流式正文走 message_delta 增量，快照不推（ADR-0004 §3）→ 条数不变，effect 不触发；
 *   - markdown 是渲染后才算出最终高度的（代码块、表格、图片加载），滚早了不够到底；
 *   所以这里用 ResizeObserver 盯**内容高度**，只要还粘着底就继续跟。
 */
import { useEffect, useRef, useState } from "react";
import { isNearBottom } from "./scroll-math.ts";

export { isNearBottom, STICK_THRESHOLD_PX } from "./scroll-math.ts";

export type StickToBottom = {
	ref: React.RefObject<HTMLDivElement | null>;
	/** false = 用户往上翻了，此时新内容不抢滚动，并显示「回到底部」 */
	stuck: boolean;
	toBottom: () => void;
};

/** `signal` 变化 = 内容可能有更新（消息条数 / 末条正文长度 / 流式文本） */
export function useStickToBottom(signal: string): StickToBottom {
	const ref = useRef<HTMLDivElement>(null);
	const stuckRef = useRef(true);
	const [stuck, setStuck] = useState(true);

	// 用户手动滚动 → 记录他是不是还贴着底
	useEffect(() => {
		const element = ref.current;
		if (!element) return;
		const onScroll = () => {
			const next = isNearBottom(element.scrollHeight, element.scrollTop, element.clientHeight);
			stuckRef.current = next;
			setStuck(next);
		};
		element.addEventListener("scroll", onScroll, { passive: true });
		return () => element.removeEventListener("scroll", onScroll);
	}, []);

	// 内容高度变化 → 只要还粘着底就继续跟（覆盖 streaming 与 markdown 后置布局）
	useEffect(() => {
		const element = ref.current;
		const content = element?.firstElementChild;
		if (!element || !content) return;
		const pin = () => {
			if (stuckRef.current) element.scrollTo({ top: element.scrollHeight });
		};
		const observer = new ResizeObserver(pin);
		observer.observe(content);
		pin();
		return () => observer.disconnect();
	}, [signal]);

	const toBottom = () => {
		const element = ref.current;
		if (!element) return;
		stuckRef.current = true;
		setStuck(true);
		element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
	};

	return { ref, stuck, toBottom };
}
