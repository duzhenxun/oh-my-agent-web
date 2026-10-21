/**
 * 项目行的「⋯」菜单（浮窗）。
 *
 * 为什么要 portal + fixed：菜单原来直接放在 `details` 里，而侧栏列表是 `overflow: auto`，
 * 菜单一旦比剩余高度长就被**裁掉**（截图里那次只剩三项，下面被「文件管理」挡住）。
 * 现在用 portal 挂到 body、按锚点按钮的位置算坐标，并自动夹进视口，永远浮在最上层。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export function ProjectMenuPopover({
	anchor,
	onClose,
	children,
}: {
	/** 触发它的按钮（用来定位） */
	anchor: HTMLElement | null;
	onClose: () => void;
	children: React.ReactNode;
}) {
	const boxRef = useRef<HTMLDivElement>(null);
	const [pos, setPos] = useState<{ left: number; top: number; visible: boolean }>({
		left: 0,
		top: 0,
		visible: false,
	});

	// 打开后量一次：贴按钮右下，超出视口就往上/往左翻
	useLayoutEffect(() => {
		const box = boxRef.current;
		if (!anchor || !box) return;
		const a = anchor.getBoundingClientRect();
		const size = box.getBoundingClientRect();
		const margin = 8;
		let left = a.right - size.width;
		if (left < margin) left = a.left;
		let top = a.bottom + 4;
		if (top + size.height > window.innerHeight - margin) top = Math.max(margin, a.top - size.height - 4);
		setPos({ left: Math.min(left, window.innerWidth - size.width - margin), top, visible: true });
	}, [anchor]);

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
			className="proj-menu proj-menu-floating"
			role="menu"
			style={{ left: pos.left, top: pos.top, visibility: pos.visible ? "visible" : "hidden" }}
			onContextMenu={(event) => event.preventDefault()}
		>
			{children}
		</div>,
		document.body,
	);
}
