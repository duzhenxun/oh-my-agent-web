/**
 * 对话区滚动：**粘底**（内容长高跟着走）+ **锚点**（发出的消息顶到上方）。
 *
 * 锚点这一半是用户 2026-10-30 照 codex 提的：「消息发出后把上面的文案一块往上顶，快到顶，
 * 回复就在屏幕中上方出现」—— 贴底时回答是从最下面往上长，视线得一直盯着底边。
 * 实现见 `anchorTo()` 与 `anchorTopRef`（自动滚动不低于锚点：短回答停在锚点、长了才跟底）。
 *
 * 下面讲的是粘底那一半：内容长高就跟着到底部，但**用户往上翻时不抢**。
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
	/**
	 * 把某条消息**顶到视口上方**（用户 2026-10-30，照 codex）：
	 * 发出消息后它自己往上顶，回答从屏幕中上部往下长，而不是永远贴着底边挤。
	 */
	anchorTo: (node: HTMLElement | null) => void;
	/**
	 * 锚定期需要在内容末尾补出多少像素的「回答区」（见 `anchorTopRef` 的说明）。
	 * 调用方把它渲染成滚动容器**内部**末尾的一个空 div —— 注意不能拿容器的 padding 顶替：
	 * 给滚动容器加 padding-bottom 会同时撑大 clientHeight，两者一抵消，可滚动空间一点没多。
	 */
	pad: number;
};

/** scrollTop 与「我们自己滚到的位置」差多少像素以内算同一跳（浏览器会夹紧到整数像素） */
const SELF_SCROLL_EPSILON_PX = 2;

/**
 * 锚点落地后核对几帧。
 *
 * 为什么需要：`scrollTo({top: 锚点})` 不一定真能滚到那儿 —— 那一刻内容还不够高时浏览器会把
 * scrollTop 夹回最大值（就是底部），而后面没人复查。表现就是「点一下按钮把消息发出去，文字还贴在底边」
 * （用户 2026-10-30：「不像我手动回车那样发到上面去」）。只核几帧，多了就是跟用户抢滚动。
 */
const ANCHOR_VERIFY_FRAMES = 6;

/** 锚点顶部留出的呼吸：消息不贴着窗框，看着才像「顶上去了」而不是「被裁掉」 */
const ANCHOR_GAP_PX = 18;

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
	/**
	 * 锚点目标：`anchorTo()` 之后**锁定**的 scrollTop（= 那条消息的顶边离容器顶边的距离）。
	 *
	 * 两个坑，这里一起兜住（用户 2026-10-30：「刚发出时还是跳底了」）：
	 *   1. **滚不上去**：消息刚发出去时它就在内容末尾，下面没有任何东西 —— 浏览器最大只能滚到
	 *      `scrollHeight - clientHeight`，硬写一个更大的 scrollTop 会被夹回去（看起来就是「跳底」）。
	 *      解法是在**内容末尾**塞一段「回答区」占位（`pad`，由调用方渲染成空 div）：
	 *      给滚动容器加 padding-bottom 不算数 —— clientHeight 会跟着一起变大，可滚动空间没多一像素。
	 *   2. **短回答被拽回底**：贴底逻辑每帧都往 `scrollHeight` 滚，把刚顶上去的消息又拉下来。
	 *      所以锚定期间**死守锚点**（不是 `max(锚点, 内容底)` —— 长会话里后者永远等于内容底，
	 *      等于没锚）；等回答高过一屏、新字要跑出屏幕了，才撤锚交回「跟随底部」。
	 */
	const anchorTopRef = useRef<number | null>(null);
	/** 自校正记的帧数与挂着的 rAF（见 verifyAnchor） */
	const verifyFramesRef = useRef(0);
	const verifyRafRef = useRef(0);
	const rafRef = useRef(0);
	/** 挂在这个节点上的监听/观察的收尾函数（换节点时先跑一遍，避免泄漏） */
	const disposeRef = useRef<(() => void) | null>(null);

	/** 当前渲染出去的占位高度（跟着 state 走：改了要重渲染，滚动才会真的够到锚点） */
	const padRef = useRef(0);
	const [pad, setPad] = useState(0);

	/**
	 * 让锚点目标「够得着」：算出现在还差多少像素，交给调用方渲染成末尾占位。
	 * 返回 true = 补白变了（要先渲染再滚，这一帧别急着 scrollTo）。
	 */
	const applyPad = useCallback((element: HTMLElement): boolean => {
		const anchor = anchorTopRef.current;
		// scrollHeight 里已经含当前占位，减掉它才是「真实内容」的高度
		const maxWithoutPad = Math.max(0, element.scrollHeight - padRef.current - element.clientHeight);
		// 按 16px 量化：流式期间正文每帧都长几个像素，不量化就会每帧 setState（整页 App 重渲染）；
		// 量化只会让占位「略多」，滚动目标仍是锚点，看不出来
		const raw = anchor === null ? 0 : Math.max(0, anchor - maxWithoutPad);
		const needed = raw === 0 ? 0 : Math.ceil(raw / 16) * 16;
		if (needed === padRef.current) return false;
		padRef.current = needed;
		setPad(needed);
		return true;
	}, []);

	/** 撤掉锚点（以及它占出来的回答区）：用户接管 / 换会话 / 主动回到底部时都要跑 */
	const clearAnchor = useCallback(() => {
		anchorTopRef.current = null;
		verifyFramesRef.current = 0;
		if (verifyRafRef.current) {
			cancelAnimationFrame(verifyRafRef.current);
			verifyRafRef.current = 0;
		}
		if (padRef.current !== 0) {
			padRef.current = 0;
			setPad(0);
		}
	}, []);

	/**
	 * 自动滚动。两种模式：
	 *
	 *   **锚定**（发出消息之后）：只要「锚点之下」的内容还没超过一屏，就**死守锚点不动** ——
	 *   回答从屏幕中上部往下长，跟读一页文档一样。
	 *   一旦内容高过一屏（新字已经跑到屏幕外了），就把锚点撤掉、交回「跟随底部」。
	 *
	 *   **跟随**（默认）：一直贴到底部。
	 *
	 * 之前的写法是 `max(锚点, 内容底)`，那是错的：长会话里「内容底」永远远大于锚点，
	 * 于是每帧都被拽回底部（用户 2026-10-30：「不要因为页面把你挤在下面，你就在下面放」）。
	 */
	const pin = useCallback(() => {
		const element = elementRef.current;
		if (!element || !stuckRef.current || !activeRef.current) return;
		const anchor = anchorTopRef.current;
		if (anchor !== null) {
			// 扣掉占位才是「真实内容」高度：占位是我们自己撑出来的，不该算进「回答有多长」
			const contentHeight = element.scrollHeight - padRef.current;
			const belowViewport = contentHeight - (anchor + element.clientHeight);
			if (belowViewport <= 0) {
				if (applyPad(element)) return; // 占位刚变过：先把 DOM 更新完，下一轮再滚
				element.scrollTo({ top: anchor });
				selfScrollTop.current = element.scrollTop;
				return;
			}
			// 回答已经超过一屏：锚点使命结束，接下来跟着底部走
			clearAnchor();
		}
		const bottom = Math.max(0, element.scrollHeight - padRef.current - element.clientHeight);
		element.scrollTo({ top: bottom });
		selfScrollTop.current = element.scrollTop;
	}, [applyPad, clearAnchor]);

	/** 一帧里长高超过阈值：下一帧再追一次，别停在半路上 */
	const followNextFrame = useCallback(() => {
		if (rafRef.current) return;
		rafRef.current = requestAnimationFrame(() => {
			rafRef.current = 0;
			pin();
		});
	}, [pin]);

	/**
	 * 锚点落地后的自校正（见 ANCHOR_VERIFY_FRAMES）：隔一帧核对 scrollTop，没对上就再滚一次。
	 * 对上了 / 锚点撤了 / 补白刚变过（等 pad effect 那一轮）就停，不无限重试。
	 */
	const verifyAnchor = useCallback(() => {
		verifyRafRef.current = 0;
		const element = elementRef.current;
		const anchor = anchorTopRef.current;
		if (!element || anchor === null) {
			verifyFramesRef.current = 0;
			return;
		}
		if (Math.abs(element.scrollTop - anchor) <= SELF_SCROLL_EPSILON_PX) {
			verifyFramesRef.current = 0;
			return;
		}
		if (verifyFramesRef.current >= ANCHOR_VERIFY_FRAMES) {
			verifyFramesRef.current = 0;
			return;
		}
		verifyFramesRef.current += 1;
		if (applyPad(element)) return; // 补白刚变：等 pad effect 那一轮再滚
		element.scrollTo({ top: anchor });
		selfScrollTop.current = element.scrollTop;
		verifyRafRef.current = requestAnimationFrame(verifyAnchor);
	}, [applyPad]);

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
				// 用户接管了：之后的滚动都是他的，锚点也别再当下限（否则他往上翻还会被拽回锚点）
				if (!next) {
					selfScrollTop.current = -1;
					clearAnchor();
				}
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
				if (verifyRafRef.current) cancelAnimationFrame(verifyRafRef.current);
				verifyRafRef.current = 0;
				verifyFramesRef.current = 0;
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
		clearAnchor();
		pin();
	}, [resetKey, pin, clearAnchor]);

	// 内容更新（条数 / 末条正文 / 流式文本）→ 立刻追一次，别等 ResizeObserver 那一帧
	useEffect(() => {
		pin();
	}, [signal, pin]);

	// 占位刚渲染出来 / 收缩：这次滚动必须等 DOM 更新完（否则高度还是旧的，滚不到锚点）
	useEffect(() => {
		pin();
	}, [pad, pin]);

	// 卸载时收尾
	useEffect(() => () => disposeRef.current?.(), []);

	const toBottom = useCallback(() => {
		const element = elementRef.current;
		if (!element) return;
		stuckRef.current = true;
		anchorTopRef.current = null;
		setStuck(true);
		element.scrollTo({ top: element.scrollHeight, behavior: "auto" });
		selfScrollTop.current = element.scrollTop;
	}, [clearAnchor]);

	/**
	 * 把一条消息顶到视口上方（见类型里那段说明）。
	 *
	 * 步骤：撤掉旧补白 → 量出这条消息的顶边 → 记成目标 → 交给 `pin()` 去补回答区并滚过去。
	 * **不做 clamp**：目标可能超出当前能滚到的范围（消息就在内容末尾），那正是要靠补白解决的，
	 * 这里先 clamp 就等于自己把它压回底部（用户 2026-10-30 看到的「跳底」）。
	 */
	const anchorTo = useCallback(
		(node: HTMLElement | null) => {
			const element = elementRef.current;
			if (!element || !node) return;
			// 量「消息顶边离容器顶边多远」。末尾占位在内容之后，不影响这条消息的坐标，
			// 所以不用先把它撤掉再量（代价是可能多一次重渲染，但少一次画面闪动）。
			const offset = node.getBoundingClientRect().top - element.getBoundingClientRect().top + element.scrollTop;
			anchorTopRef.current = Math.max(0, offset - ANCHOR_GAP_PX);
			stuckRef.current = true;
			setStuck(true);
			// 补白变了就先等渲染（applyPad 返回 true），滚动交给下面那个 pad effect
			if (!applyPad(element)) pin();
			// 滚过去了也未必真到位（见 ANCHOR_VERIFY_FRAMES）：下一帧起核对几帧
			verifyFramesRef.current = 0;
			if (verifyRafRef.current) cancelAnimationFrame(verifyRafRef.current);
			verifyRafRef.current = requestAnimationFrame(verifyAnchor);
		},
		[applyPad, pin, verifyAnchor],
	);

	return { ref: setElement, stuck, toBottom, anchorTo, pad };
}
