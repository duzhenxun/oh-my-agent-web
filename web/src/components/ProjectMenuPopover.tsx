/**
 * 项目 / 会话的菜单（浮窗）。
 *
 * 为什么要 portal + fixed：菜单原来直接放在 `details` 里，而侧栏列表是 `overflow: auto`，
 * 菜单一旦比剩余高度长就被**裁掉**（截图里那次只剩三项，下面被「文件管理」挡住）。
 * 现在用 portal 挂到 body、按锚点按钮（或右键位置）算坐标，并自动夹进视口，永远浮在最上层。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export type MenuPoint = { x: number; y: number };

/**
 * 鼠标**离开浮层**多久后自动收起（毫秒）。
 *
 * 用户 2026-10-29：「鼠标移走后，这个弹窗要消失 / 关闭」。给一点点缓冲：
 * 顺着边缘划出去、又马上划回来时不该闪一下就没（`mouseenter` 会取消这次收起）。
 * 只在**真有悬停能力**的设备上做（`(hover: hover)`）—— 触屏没有 mouseleave，
 * 那边仍然是「点外面 / Esc 收」，否则手指离开屏幕就会把菜单收掉。
 */
const LEAVE_CLOSE_MS = 400;

export function ProjectMenuPopover({
	anchor,
	point,
	className,
	style,
	align,
	closeOnLeave,
	onClose,
	children,
}: {
	/** 触发它的按钮（用来定位） */
	anchor?: HTMLElement | null;
	/** 右键位置（优先于 anchor）：菜单就从鼠标那儿弹出来 */
	point?: MenuPoint | null;
	/** 额外的样式类（会话菜单用 `.pi-menu` 的配色，定位仍走 `.proj-menu-floating`） */
	className?: string;
	/** 额外的内联样式（文件区那个下拉要按按钮宽度铺开，见 FilesRootSelect） */
	style?: React.CSSProperties;
	/**
	 * 水平对齐（只对 `anchor` 生效）：
	 *  - `end`（默认）= 浮层右边缘贴触发器右边缘，右键菜单/列表行那种「从右边长出来」的用它；
	 *  - `center` = **水平居中于触发器**，跟状态栏、顶栏、模型选择器那几套浮层同一套纪律
	 *    （见 `popover-anchor.ts`）；触发器是窄胶囊时，贴右边会让浮层整个往左支出去，
	 *    看着像「没对准我点的地方」。选 `center` 还会顺带画一小截**指向触发器的小尾巴**：
	 *    没有它时浮层像凭空浮在对话上，看不出是从哪个按钮长出来的（同 `.model-menu-arrow`）。
	 */
	align?: "end" | "center";
	/**
	 * 鼠标移出就收起（只给「行菜单」用：项目 / 会话那两个）。
	 * 表单类浮层（新建会话选项目、分支菜单）**别开**这个 —— 鼠标一歪就没了，填到一半很难受。
	 */
	closeOnLeave?: boolean;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	/** 「鼠标移出去了」的定时器（移回来就取消） */
	const leaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	/**
	 * `arrow` = 尾巴**中心**相对浮层左边缘的偏移；`below` = 浮层仍在触发器**下方**（那尾巴就挂在顶边）；
	 * `width`/`height` 是量下来的浮层尺寸（尾巴要自己算坐标，它**不住在浮层里**—— 见下面 portal 那段）。
	 */
	const [pos, setPos] = useState<{
		left: number;
		top: number;
		width: number;
		height: number;
		visible: boolean;
		arrow: number | null;
		below: boolean;
	}>({ left: 0, top: 0, width: 0, height: 0, visible: false, arrow: null, below: false });

	// 打开后量一次：右键就给鼠标位置，`center` 居中并从**上**长出来（同模型选择器），其余贴按钮右下
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		if (!point && !anchor) return;
		const size = box.getBoundingClientRect();
		const margin = 8;
		const GAP = 4;
		/**
		 * 锚点矩形：**只要有 anchor 就量**（不再跟 `point` 互斥）。
		 *  - 定位仍按老规矩：有 `point` 就从鼠标那儿长出来；否则用锚点（`align="center"` 居中、默认贴右下）；
		 *  - 小尾巴**总是**指着锚点 —— 这正是「一眼看出这张菜单是哪一行的」靠的东西，
		 *    所以即使用鼠标右键（`point`）打开，尾巴也指向那一行/那颗按钮
		 *    （用户 2026-10-29：「定位看不太清楚，弄个小气泡指到当前这个项目 / 这对话」）。
		 */
		const anchored = anchor ? (anchor as HTMLElement).getBoundingClientRect() : null;
		/** 浮层是否落在锚点**下方**（决定小尾巴挂顶边还是底边） */
		let below = true;
		// 两个都有兜底值：上面已经 return 过「既没有 point 也没有 anchor」，
		// 这里是给 TS 一个确定赋值（不是运行时真的会用到 0,0）
		let left = margin;
		let top = margin;
		if (point) {
			left = point.x;
			top = point.y;
		} else if (anchored && align === "center") {
			// **一律往上长**（跟模型选择器那颗一样）：这两颗胶囊就坐在工具行里，往下弹会盖住输入框。
			left = anchored.left + anchored.width / 2 - size.width / 2;
			top = anchored.top - size.height - GAP;
			below = false;
		} else if (anchored) {
			// 列表行 / 按钮：右边缘对齐、挂在它下面（右键弹窗也一样 —— 菜单针对的是「这一行」）
			left = anchored.right - size.width;
			top = anchored.bottom + GAP;
		}
		if (left + size.width > window.innerWidth - margin) left = window.innerWidth - size.width - margin;
		if (left < margin) left = margin;
		// 摆不下就翻到另一侧（顶栏那些按钮往下掉，尾部那些往上长，两边都得有退路）
		if (!below && anchored && top < margin) {
			top = anchored.bottom + GAP;
			below = true;
		} else if (below && top + size.height > window.innerHeight - margin) {
			top = point ? point.y - size.height : (anchored as DOMRect).top - size.height - GAP;
			below = false;
		}
		if (top < margin) top = margin;
		/**
		 * 小尾巴：**始终指着锚点（那一行 / 那颗按钮）的中心**。
		 *
		 * 浮层被夹进视口时左边缘挪了、锚点没动，所以按「锚点中心 - 浮层左边缘」现算；
		 * 再夹一下，不让它插进浮层的圆角里（跟 `popover-anchor.ts` 的 `ARROW_PAD` 同一个意思）。
		 */
		let arrow: number | null = null;
		if (anchored) {
			const pad = 14;
			const center = anchored.left + anchored.width / 2 - left;
			arrow = Math.min(Math.max(pad, center), Math.max(pad, size.width - pad));
			// 浮层在锚点上方还是下方：按两者的实际上下关系算（翻上去之后尾巴就挂底边）
			below = top >= anchored.top + anchored.height / 2;
		}
		setPos({ left, top, width: size.width, height: size.height, visible: true, arrow, below });
	}, [anchor, point, align]);

	useEffect(
		() => () => {
			if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
		},
		[],
	);

	// 点外面 / 按 Esc 关掉；滚动或窗口尺寸变化也关（否则菜单会飘在错的位置）
	useEffect(() => {
		const openedAt = performance.now();
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (boxRef.current?.contains(target) || anchor?.contains(target)) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		/**
		 * 滚了就关 —— 但**刚打开那一帧不算**。
		 * 有些操作会让页面在菜单弹出的同一帧里重排 / 重新粘底（比如「把对话换到另一侧」
		 * 会让消息区宽度突变、粘底逻辑跟着滚一下），那一拍收到的 scroll 不是用户滚的，
		 * 拿它关菜单就会变成「点了没反应」。200ms 之后再进来的才算。
		 */
		const GRACE_MS = 200;
		const onScroll = (event: Event) => {
			if (performance.now() - openedAt < GRACE_MS) return;
			/**
			 * **浮窗自己内部的滚动不算**：菜单是 fixed 定位的，清单在里面滚不会让它飘走。
			 * 以前一律 close，于是「项目多、想在清单里往下滚」= 菜单自己关掉，
			 * 用户只能一遍遍重开（这正是「往下滑感觉很麻烦」那次的病根）。
			 */
			const target = event.target;
			if (target instanceof Node && boxRef.current?.contains(target)) return;
			onClose();
		};
		document.addEventListener("mousedown", onDown);
		document.addEventListener("keydown", onKey);
		window.addEventListener("resize", onScroll);
		// capture：侧栏列表内部滚动也要关（否则菜单停在原处）
		window.addEventListener("scroll", onScroll, true);
		return () => {
			document.removeEventListener("mousedown", onDown);
			document.removeEventListener("keydown", onKey);
			window.removeEventListener("resize", onScroll);
			window.removeEventListener("scroll", onScroll, true);
		};
	}, [anchor, onClose]);

	return createPortal(
		<>
			<div
				ref={boxRef}
				className={`${className ?? "proj-menu"} proj-menu-floating`}
				role="menu"
				style={{ left: pos.left, top: pos.top, visibility: pos.visible ? "visible" : "hidden", ...style }}
				onContextMenu={(event) => event.preventDefault()}
				onMouseLeave={
					closeOnLeave
						? () => {
								if (!window.matchMedia("(hover: hover)").matches) return;
								if (leaveTimer.current !== null) clearTimeout(leaveTimer.current);
								leaveTimer.current = setTimeout(() => {
									leaveTimer.current = null;
									onClose();
								}, LEAVE_CLOSE_MS);
							}
						: undefined
				}
				onMouseEnter={
					closeOnLeave
						? () => {
								if (leaveTimer.current === null) return;
								clearTimeout(leaveTimer.current);
								leaveTimer.current = null;
							}
						: undefined
				}
			>
				{children}
			</div>
			{/*
			 * 指向触发器的小尾巴（只有「居中于触发器」的浮层画，跟 ModelPicker 那颗同一个画法）。
			 * 为什么它**不是浮层的子元素**：浮层自己常常靠 `overflow: auto` 就地滚（分支多了就要滚），
			 * 把尾巴放进去就得把 overflow 改成 visible —— 那滚就废了。放外面就没这个矛盾：
			 * 它是个 fixed 的小方块，坐标由这里算出（与浮层同一套视野坐标系），只有描边要接上。
			 */}
			{pos.arrow === null ? null : (
				<span
					className={`proj-menu-arrow${pos.below ? " proj-menu-arrow-top" : ""}`}
					style={{
						left: pos.left + pos.arrow - 5,
						top: pos.below ? pos.top - 5 : pos.top + pos.height - 5,
					}}
					aria-hidden="true"
				/>
			)}
		</>,
		document.body,
	);
}
