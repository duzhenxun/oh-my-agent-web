/**
 * 「粘底」滚动：内容长高就跟着到底部，但**用户往上翻时不抢**。
 *
 * 为什么不能只在「消息条数变化」时滚（这是最早的做法，用户反馈仍然要手动往下拖）：
 *   - 流式正文走 message_delta 增量，快照不推（ADR-0004 §3）→ 条数不变，effect 不触发；
 *   - markdown 是渲染后才算出最终高度的（代码块、表格、图片加载），滚早了不够到底；
 *   所以这里用 ResizeObserver 盯**内容高度**，只要还粘着底就继续跟。
 *
 * 为什么「跟着跟着就不跟了」（用户第三次反馈：正在回复时经常不自动到底）：
 *   靠 scrollTop 的**位置**去猜「是不是人滚的」永远有漏：容器高度一变（输入框长高、
 *   「想想」建议行 / 子代理条出现、状态栏换行）浏览器会自己调整 scrollTop 保持画面，
 *   浏览器滚动锚定（overflow-anchor）也会替我们改 scrollTop —— 这两类都不是人滚的，
 *   但一旦距离超过 80px 就会被当成「用户往上翻了」→ stuck=false → 再也不跟。
 *   现在改成看**输入事件**：滚轮 / 触摸 / 方向键 / 按住滚动条才算用户接管；
 *   其余 scroll 事件一律当作「我们自己的跳」，把 scrollTop 记到名下继续追。
 *   scroll 事件是**下一帧**才派发的（scroll steps），而流式内容可能在那之前又长高了几百像素
 *   （一次工具卡出现、一个代码块排版完成都能一口吃掉 >80px）。老实现只在 scroll 回调里看
 *   「离底多远」，于是把自己刚滚出去的那一跳误判成「用户往上翻了」→ stuck=false → 之后
 *   再也不跟，直到用户点「回到底部」。所以还记账「我们自己把 scrollTop 写到了哪儿」：
 *   scrollTop 仍停在那个位置 = 这一跳不是人滚的，继续粘底。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { STICK_THRESHOLD_PX } from "./scroll-math.ts";

export { isNearBottom, STICK_THRESHOLD_PX } from "./scroll-math.ts";

type StickToBottom = {
	/** callback ref：泛到 HTMLElement，工具卡里的 <pre> 输出框也要用 */
	ref: React.RefCallback<HTMLElement>;
	/** false = 用户往上翻了，此时新内容不抢滚动，并显示「回到底部」 */
	stuck: boolean;
	toBottom: () => void;
};

/** scrollTop 与「我们自己滚到的位置」差多少像素以内算同一跳（浏览器会夹紧到整数像素） */
const SELF_SCROLL_EPSILON_PX = 2;

/**
 * 用户输入事件之后多久内发生的滚动算「人滚的」。
 * 滚轮一格格地来（每次都有新事件），所以这个窗口只需要盖住「事件 → 下一帧 scroll」那一点延迟。
 */
const USER_INTENT_MS = 500;

/** 这些键会改滚动位置：按下就当用户接管（不然键盘翻页也会被当成自动跟随） */
const SCROLL_KEYS = new Set(["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "]);

/**
 * @param signal 变化 = 内容可能有更新（消息条数 / 末条正文长度 / 流式文本）
 * @param resetKey 会话标识：换了会话就重新「粘底」——否则在 A 里往上翻过之后，
 *                 切到 B 会带着「用户想往上翻」的状态，新内容不再自动跟随。
 * @param active 只有为真时才自动追。工具卡里的输出框用它：跑着的时候跟着进度往下走，
 *               跑完就别动 —— 展开一条旧记录是想从头读，不是直接跳到尾巴。
 */
export function useStickToBottom(signal: string, resetKey?: string | null, active = true): StickToBottom {
	const elementRef = useRef<HTMLElement | null>(null);
	/** 放进 ref 才不牵动 pin 的身份：pin 一变，callback ref 就会重挂（每帧拆装监听） */
	const activeRef = useRef(active);
	activeRef.current = active;
	const stuckRef = useRef(true);
	const [stuck, setStuck] = useState(true);
	const lastKey = useRef(resetKey);
	/** 上一次「我们自己」把 scrollTop 写到的位置；-1 = 没有（或已被用户接管） */
	const selfScrollTop = useRef(-1);
	const rafRef = useRef(0);
	/** 挂在这个节点上的监听/观察的收尾函数（换节点时先跑一遍，避免泄漏） */
	const disposeRef = useRef<(() => void) | null>(null);

	/** 贴底：把 scrollTop 追到 scrollHeight（只有还粘着底时才动） */
	const pin = useCallback(() => {
		const element = elementRef.current;
		if (!element || !stuckRef.current || !activeRef.current) return;
		element.scrollTo({ top: element.scrollHeight });
		// 记夹紧后的真实值（scrollHeight 含内边距、不一定落在能滚到的位置）
		selfScrollTop.current = element.scrollTop;
	}, []);

	/** 一帧里长高超过阈值：下一帧再追一次，别停在半路上 */
	const followNextFrame = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			pin();
		});
	}, [pin]);

	// 节点挂上/摘下：scroll 监听 + 内容高度观察都在这里挂，跟着节点走（面板开合会换节点）
	const setElement = useCallback(
		(node: HTMLElement | null) => {
			elementRef.current = node;
			disposeRef.current?.();
			disposeRef.current = null;
			if (!node) return;

			// 用户「接管」的几个入口：滚轮 / 触摸 / 方向键 / 按住滚动条或内容（拖选也能滚）。
			// 只认这些：位置本身不可靠（见文件头）。
			let userIntentUntil = 0;
			/** 手指按住滚动条拖动时不发滚轮 / 触摸事件：按住期间一律算「人在滚」 */
			let pointerDown = false;
			const markUserIntent = () => {
				userIntentUntil = performance.now() + USER_INTENT_MS;
			};
			const onPointerDown = () => {
				pointerDown = true;
				markUserIntent();
			};
			const releasePointer = () => {
				pointerDown = false;
				markUserIntent();
			};
			const onKeyDown = (event: KeyboardEvent) => {
				if (SCROLL_KEYS.has(event.key)) markUserIntent();
			};
			node.addEventListener("wheel", markUserIntent, { passive: true });
			node.addEventListener("touchstart", markUserIntent, { passive: true });
			node.addEventListener("touchmove", markUserIntent, { passive: true });
			node.addEventListener("keydown", onKeyDown);
			node.addEventListener("pointerdown", onPointerDown, { passive: true });
			window.addEventListener("pointerup", releasePointer);
			window.addEventListener("pointercancel", releasePointer);

			const onScroll = () => {
				const element = elementRef.current;
				if (!element) return;
				const distance = element.scrollHeight - element.scrollTop - element.clientHeight;
				// 这一跳是我们自己滚出去的、或纯粹是浏览器在替我们平衡布局（容器变矮 / 滚动锚定）
				// → 不算用户上翻，继续跟
				const bySelf =
					(!pointerDown && performance.now() > userIntentUntil) ||
					Math.abs(element.scrollTop - selfScrollTop.current) <= SELF_SCROLL_EPSILON_PX;
				if (stuckRef.current && bySelf) {
					selfScrollTop.current = element.scrollTop;
					if (distance > 1) followNextFrame();
					return;
				}
				const next = distance <= STICK_THRESHOLD_PX;
				if (!next) selfScrollTop.current = -1; // 用户接管了，之后的滚动都是他的
				if (next === stuckRef.current) return;
				stuckRef.current = next;
				setStuck(next);
			};
			node.addEventListener("scroll", onScroll, { passive: true });

			// 盯内容第一个子元素的高度：流式、markdown 后置布局、工具卡出现都会让它变高。
			// 用 MutationObserver 跟住「内容根节点被换掉」（空会话 hero ↔ 消息列表）。
			let observed: Element | null = null;
			const observer = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => pin());
			// 容器自己的尺寸也要盯：输入框长高、建议行 / 子代理条出现都会把可视区变矮，
			// 内容一点没动、但「离底多远」变了 —— 不重新贴一次就会差出一大截。
			observer?.observe(node);
			const syncContent = () => {
				const next = node.firstElementChild;
				if (next === observed) return;
				if (observed) observer?.unobserve(observed);
				observed = next;
				if (observed) observer?.observe(observed);
			};
			const list = typeof MutationObserver === "undefined" ? null : new MutationObserver(syncContent);
			list?.observe(node, { childList: true });
			syncContent();
			// 刚挂上就追一次：展开一条「在跑」的工具卡时，直接落在当下进度上，别从开头看
			pin();

			disposeRef.current = () => {
				cancelAnimationFrame(rafRef.current);
				rafRef.current = 0;
				node.removeEventListener("scroll", onScroll);
				node.removeEventListener("wheel", markUserIntent);
				node.removeEventListener("touchstart", markUserIntent);
				node.removeEventListener("touchmove", markUserIntent);
				node.removeEventListener("keydown", onKeyDown);
				node.removeEventListener("pointerdown", onPointerDown);
				window.removeEventListener("pointerup", releasePointer);
				window.removeEventListener("pointercancel", releasePointer);
				list?.disconnect();
				observer?.disconnect();
			};
		},
		[pin, followNextFrame],
	);

	// 换会话：重新贴底（并立刻滚一次，别等下一次内容变化）
	useEffect(() => {
		if (lastKey.current === resetKey) return;
		lastKey.current = resetKey;
		stuckRef.current = true;
		setStuck(true);
		pin();
	}, [resetKey, pin]);

	// 内容更新（条数 / 末条正文 / 流式文本）→ 立刻追一次，别等 ResizeObserver 那一帧
	useEffect(() => {
		pin();
	}, [signal, pin]);

	// 卸载时收尾
	useEffect(() => () => disposeRef.current?.(), []);

	const toBottom = useCallback(() => {
		const element = elementRef.current;
		if (!element) return;
		stuckRef.current = true;
		setStuck(true);
		element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
		selfScrollTop.current = element.scrollTop;
	}, []);

	return { ref: setElement, stuck, toBottom };
}
