/**
 * 轻提示的渲染层（挂在 App 里一次，`toast.ts` 的 showToast 就能从任何地方弹）。
 *
 * 位置固定在**底部居中**（状态栏上方）：不挡对话正文，也不跟右侧面板的工具条打架。
 * 每条提示自己计时；鼠标停在提示上时暂停计时（正要点「撤销」时被抽走会很难受）。
 *
 * 「底部居中」的**居中是指对话列居中**，不是窗口居中（见下面的 `useAlignToColumn`）。
 */
import { useEffect, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import { dismissToast, useToasts, type ToastItem } from "../toast.ts";

/**
 * 让提示条**跟对话列同宽**（用户：「长度需要跟着聊天内容宽度设置的一样，一行放不下就换行」）。
 *
 * 为什么不在 CSS 里算：提示条是 `position: fixed` 挂到 `document.body` 上的，那里的 `100%`
 * 是**整个窗口**；而对话列的位置取决于侧栏宽度（可拖）、分栏在哪一侧、以及
 * `--chat-max-width` 那几档 —— 这些 CSS 在 fixed 元素里一个都拿不到。以前就因此按窗口居中：
 * 侧栏一展开，提示条整体左偏半条侧栏，右边又只到 680px，长文案还被省略号切掉。
 *
 * 所以直接量输入框那一格：`.composer-wrap` 的左右 padding 就是「呼吸带」（见 chat.css
 * 顶部那段），减掉它剩下的宽度正好是消息正文 / 输入框的列宽。改设置、拖侧栏、开关分栏
 * 都会让这一格变宽变窄，跟着重量就行。量不到（分栏铺开、对话区没渲染）就退回窗口居中。
 */
type ColumnBox = { left: number; width: number };

function columnBox(): ColumnBox | null {
	const wrap = document.querySelector<HTMLElement>(".workspace .composer-wrap");
	if (!wrap) return null;
	const style = getComputedStyle(wrap);
	const rect = wrap.getBoundingClientRect();
	const padLeft = Number.parseFloat(style.paddingLeft) || 0;
	const padRight = Number.parseFloat(style.paddingRight) || 0;
	const width = rect.width - padLeft - padRight;
	if (!(width > 0)) return null;
	return { left: rect.left + padLeft, width };
}

function useAlignToColumn(hostRef: RefObject<HTMLDivElement | null>): void {
	useEffect(() => {
		const host = hostRef.current;
		if (!host) return;
		const apply = (): void => {
			const box = columnBox();
			if (!box) {
				host.classList.remove("toast-host-in-column");
				host.style.removeProperty("left");
				host.style.removeProperty("width");
				host.style.removeProperty("max-width");
				return;
			}
			host.classList.add("toast-host-in-column");
			host.style.left = `${Math.round(box.left)}px`;
			host.style.width = `${Math.round(box.width)}px`;
			// 兜底那条 `min(680px, 100vw - 24px)` 会把量出来的列宽再切一刀，量到了就撤掉
			host.style.maxWidth = "none";
		};
		apply();
		// 窗口缩放 / 拖侧栏 / 开关分栏：这一格会变宽变窄，重量一遍
		const wrap = document.querySelector<HTMLElement>(".workspace .composer-wrap");
		const observer = new ResizeObserver(apply);
		if (wrap) observer.observe(wrap);
		window.addEventListener("resize", apply);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", apply);
		};
	}, [hostRef]);
}

function Toast({ item }: { item: ToastItem }) {
	const [paused, setPaused] = useState(false);
	/** 已经过去的时间（悬停暂停时按暂停点续算） */
	const elapsed = useRef(0);
	const startedAt = useRef(Date.now());

	useEffect(() => {
		if (paused) {
			elapsed.current += Date.now() - startedAt.current;
			return;
		}
		startedAt.current = Date.now();
		const timer = window.setTimeout(() => dismissToast(item.id), Math.max(1200, item.ttl - elapsed.current));
		return () => window.clearTimeout(timer);
	}, [paused, item.id, item.ttl]);

	return (
		<div
			className="toast"
			role="status"
			aria-live="polite"
			onMouseEnter={() => setPaused(true)}
			onMouseLeave={() => setPaused(false)}
		>
			<span className="toast-text" title={item.text}>
				{item.text}
			</span>
			{item.actions.map((action) => (
				<button
					type="button"
					key={action.label}
					className="toast-action"
					onClick={() => {
						action.onClick();
						dismissToast(item.id);
					}}
				>
					{action.label}
				</button>
			))}
			<button type="button" className="toast-close" title="关掉" onClick={() => dismissToast(item.id)}>
				×
			</button>
		</div>
	);
}

/**
 * 提示条那一层。单独抽出来，是为了它**每次弹出都重新挂载**：量宽度在挂载时跑（那时
 * `.composer-wrap` 已经在 DOM 上了），而 `ToastHost` 本身是常驻的，effect 只跑一次就对不上了。
 */
function ToastLayer({ children }: { children: ReactNode }) {
	const hostRef = useRef<HTMLDivElement | null>(null);
	useAlignToColumn(hostRef);
	return (
		<div className="toast-host" ref={hostRef}>
			{children}
		</div>
	);
}

export function ToastHost() {
	const toasts = useToasts();
	if (toasts.length === 0) return null;
	return createPortal(
		<ToastLayer>
			{toasts.map((item) => (
				<Toast key={item.id} item={item} />
			))}
		</ToastLayer>,
		document.body,
	);
}
