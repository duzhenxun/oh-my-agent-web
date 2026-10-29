import { useLayoutEffect, useRef, useState, type RefObject } from "react";
import { flatTextOf, locateAnchor, rangeOf } from "../annotation-anchor.ts";
import { annotationNumber, type Annotation } from "../annotations.ts";
import { useT } from "../use-language.ts";

/**
 * 正文里的「标注」：那段文字上一层底色 + 末尾挂一个编号徽标（1、2、3…）。
 *
 * 两件事各用各的办法：
 *
 *   - **底色**走 CSS Custom Highlight API（`CSS.highlights` + `::highlight(annot-mark)`）：
 *     它给 Range 上样式但**不往 DOM 里插节点**，所以不会跟 React 的水合/重渲染打架，
 *     流式追加、折叠展开都不用管（重新量一次 Range 就行）。
 *     不支持这套 API 的浏览器（老 Safari 之类）就只少一层底色，编号照常显示 —— 功能不缺。
 *   - **编号徽标**是一层 `position:absolute` 的浮层，坐标从 Range 的矩形算出来。
 *     它必须放在滚动内容里（不是视口坐标），这样滚动时跟着文字一起走，不用每帧重算；
 *     但内容一变高变矮就得重量 —— 靠 MutationObserver（流式追加、折叠「过程」、图片加载都在里面）
 *     加 ResizeObserver，统一攒到下一帧算一次。
 *
 * 防自激：浮层自己挂在被观察的这棵子树里，React 更新徽标 = 一次 DOM 变动 = 又触发一次重量。
 * 所以观察回调里**只认浮层外面的变动**，浮层里面的直接跳过。
 */

/** 一个高亮名共用一套样式（编号本身不参与上色），见 styles/annotations.css */
const HIGHLIGHT_NAME = "annot-mark";

type Badge = { id: string; index: number; left: number; top: number };

/** Custom Highlight API 在老浏览器里没有：拿不到就只画徽标 */
function highlightRegistry(): { set: (name: string, value: unknown) => void; delete: (name: string) => void } | null {
	const api = (CSS as unknown as { highlights?: unknown }).highlights;
	if (typeof api !== "object" || api === null) return null;
	return api as { set: (name: string, value: unknown) => void; delete: (name: string) => void };
}

function highlightCtor(): (new (...ranges: Range[]) => unknown) | null {
	const ctor = (globalThis as unknown as { Highlight?: unknown }).Highlight;
	return typeof ctor === "function" ? (ctor as new (...ranges: Range[]) => unknown) : null;
}

export function AnnotationMarks({
	container,
	annotations,
	onFocus,
}: {
	/** 消息区（`.messages`）：徽标浮层和 `#msg-*` 都在这下面找 */
	container: RefObject<HTMLElement | null>;
	annotations: readonly Annotation[];
	/** 点徽标：把那条标注的列表项打开 / 滚过去（由上层决定，这里只上报 id） */
	onFocus?: (id: string) => void;
}) {
	const t = useT();
	const overlayRef = useRef<HTMLDivElement | null>(null);
	const [badges, setBadges] = useState<Badge[]>([]);

	useLayoutEffect(() => {
		const host = container.current;
		if (host === null) return;
		let frame = 0;

		const measure = () => {
			frame = 0;
			const overlay = overlayRef.current;
			const base = host.getBoundingClientRect();
			const next: Badge[] = [];
			const ranges: Range[] = [];
			// 按 DOM 里出现的顺序上色（Highlight 内部会自己排，这里只保证同一个消息的多条不打架）
			const byId = new Map<string, HTMLElement>();
			for (const element of host.querySelectorAll<HTMLElement>("article.msg")) byId.set(element.id, element);

			for (const item of annotations) {
				const message = byId.get(`msg-${item.messageId}`);
				const body = message?.querySelector<HTMLElement>(".msg-body") ?? null;
				if (body === null) continue;
				const found = locateAnchor(flatTextOf(body), item.anchor);
				if (found === null) continue; // 那几句话被删了：这条标注就静默失效（列表里还在）
				const range = rangeOf(body, found.start, found.end);
				if (range === null) continue;
				ranges.push(range);
				if (overlay === null) continue;
				const rects = range.getClientRects();
				const rect = rects.length > 0 ? (rects[rects.length - 1] as DOMRect) : range.getBoundingClientRect();
				if (rect.width === 0 && rect.height === 0) continue;
				next.push({
					id: item.id,
					index: annotationNumber(annotations, item.id),
					left: rect.right - base.left + host.scrollLeft,
					top: rect.bottom - base.top + host.scrollTop,
				});
			}

			const registry = highlightRegistry();
			const HighlightClass = highlightCtor();
			if (registry !== null && HighlightClass !== null) {
				if (ranges.length > 0) registry.set(HIGHLIGHT_NAME, new HighlightClass(...ranges));
				else registry.delete(HIGHLIGHT_NAME);
			}

			// 坐标没变就别 setState：同样的数组换一份引用会让 React 白渲染一次，也更容易抖
			setBadges((current) =>
				current.length === next.length &&
				current.every((old, index) => {
					const fresh = next[index];
					return (
						fresh !== undefined &&
						old.id === fresh.id &&
						old.index === fresh.index &&
						Math.abs(old.left - fresh.left) < 0.5 &&
						Math.abs(old.top - fresh.top) < 0.5
					);
				})
					? current
					: next,
			);
		};

		const schedule = () => {
			if (frame !== 0) return;
			frame = window.requestAnimationFrame(measure);
		};

		const observer = new MutationObserver((records) => {
			const overlay = overlayRef.current;
			// 浮层内部的变化（就是上面那次 setState 引起的）不算内容变了
			if (overlay !== null && records.every((record) => overlay.contains(record.target))) return;
			schedule();
		});
		observer.observe(host, { childList: true, subtree: true, characterData: true });

		const resize = new ResizeObserver(schedule);
		resize.observe(host);
		window.addEventListener("resize", schedule);
		schedule();

		return () => {
			observer.disconnect();
			resize.disconnect();
			window.removeEventListener("resize", schedule);
			if (frame !== 0) window.cancelAnimationFrame(frame);
			highlightRegistry()?.delete(HIGHLIGHT_NAME);
		};
	}, [container, annotations]);

	// 一条标注都没有时连浮层都不画（占位 0 成本）
	if (annotations.length === 0) return null;

	return (
		<div className="annot-marks" ref={overlayRef}>
			{badges.map((badge) => (
				<button
					type="button"
					key={badge.id}
					className="annot-mark"
					style={{ left: badge.left, top: badge.top }}
					title={t(`第 ${badge.index} 条标注`, `Annotation ${badge.index}`)}
					aria-label={t(`第 ${badge.index} 条标注`, `Annotation ${badge.index}`)}
					onClick={() => onFocus?.(badge.id)}
				>
					{badge.index}
				</button>
			))}
		</div>
	);
}
