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

export function ProjectMenuPopover({
	anchor,
	point,
	className,
	onClose,
	children,
}: {
	/** 触发它的按钮（用来定位） */
	anchor?: HTMLElement | null;
	/** 右键位置（优先于 anchor）：菜单就从鼠标那儿弹出来 */
	point?: MenuPoint | null;
	/** 额外的样式类（会话菜单用 `.pi-menu` 的配色，定位仍走 `.proj-menu-floating`） */
	className?: string;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
		left: 0,
		top: 0,
		visible: false,
	});

	// 打开后量一次：右键就给鼠标位置，按钮就贴它右下；贴边时往上/往左翻
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!box) return;
		if (!point && !anchor) return;
		const size = box.getBoundingClientRect();
		const margin = 8;
		let left: number;
		let top: number;
		if (point) {
			left = point.x;
			top = point.y;
		} else {
			const a = (anchor as HTMLElement).getBoundingClientRect();
			left = a.right - size.width;
			top = a.bottom + 4;
		}
		if (left + size.width > window.innerWidth - margin) left = window.innerWidth - size.width - margin;
		if (left < margin) left = margin;
		if (top + size.height > window.innerHeight - margin) {
			top = point ? point.y - size.height : (anchor as HTMLElement).getBoundingClientRect().top - size.height - 4;
		}
		if (top < margin) top = margin;
		setPos({ left, top, visible: true });
	}, [anchor, point]);

	// 点外面 / 按 Esc 关掉；滚动或窗口尺寸变化也关（否则菜单会飘在错的位置）
	useEffect(() => {
		const onDown = (event: MouseEvent) => {
			const target = event.target as Node;
			if (boxRef.current?.contains(target) || anchor?.contains(target)) return;
			onClose();
		};
		const onKey = (event: KeyboardEvent) => {
			if (event.key === "Escape") onClose();
		};
		const onScroll = () => onClose();
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
		<div
			ref={boxRef}
			className={`${className ?? "proj-menu"} proj-menu-floating`}
			role="menu"
			style={{ left: pos.left, top: pos.top, visibility: pos.visible ? "visible" : "hidden" }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{children}
		</div>,
		document.body,
	);
}
