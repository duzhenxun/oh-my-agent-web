import { useLayoutEffect, useMemo, useRef, useState } from "react";
import type { UiMessage } from "../types.ts";
import { tNow, useT } from "../use-language.ts";

type Item = { id: string; index: number; question: string; answer: string };

/** 从消息列表里抽出「问答对」：每条用户消息 + 它后面第一条助手消息 */
function buildItems(messages: UiMessage[]): Item[] {
	const text = (message: UiMessage): string =>
		message.blocks
			.filter((block) => block.kind === "text")
			.map((block) => (block.kind === "text" ? block.text : ""))
			.join(" ")
			.replace(/\s+/g, " ")
			.trim();
	const items: Item[] = [];
	messages.forEach((message, index) => {
		if (message.role !== "user") return;
		const answer = messages.slice(index + 1).find((next) => next.role === "assistant");
		items.push({
			id: message.id,
			index: items.length + 1,
			question: text(message).slice(0, 120) || tNow("（空消息）", "(empty message)"),
			answer: answer ? text(answer).slice(0, 160) : "",
		});
	});
	return items;
}

/**
 * 对话大纲（右侧窄条）：每条用户提问一个空心方块。
 * - 鼠标移到方块上 → 弹出这条问答的简版
 * - 点击 → 滚到那条消息
 *
 * 只依赖已有的消息数组，不额外拉数据。
 */
export function ConversationOutline({ messages }: { messages: UiMessage[] }) {
	const t = useT();
	const [hoverIndex, setHoverIndex] = useState<number | null>(null);
	/**
	 * 关闭有个短延迟：鼠标从窄条移到预览面板要跨过 6px 间隙，
	 * 没延迟的话一离开窄条预览就消失，根本移不进去（更别说点里面的条目）。
	 */
	const closeTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const keepOpen = () => {
		if (closeTimer.current) clearTimeout(closeTimer.current);
		closeTimer.current = null;
	};
	const scheduleClose = () => {
		keepOpen();
		closeTimer.current = setTimeout(() => setHoverIndex(null), 160);
	};
	/**
	 * O(消息数) 的抽取只跑一遍：本组件会因为 hoverIndex 每秒重渲染，而手机上它虽然被 CSS
	 * 隐藏，计算照样会发生 —— 长会话里每帧重建一整套大纲纯属白烧 CPU。
	 * 依赖里带上 `t`：条目文本里有 `tNow` 的空消息文案，切语言要跟着重算。
	 */
	const items = useMemo(() => buildItems(messages), [messages, t]);
	/**
	 * 预览面板的垂直锚点：`.outline` 是 `row-reverse + flex-start`，默认会把面板顶在
	 * 整个大纲的最上面，跟鼠标指着的方块毫无关系 —— 会话一长，点下面的方块、弹窗
	 * 却在屏幕顶上。这里量出悬停方块的位置，把面板平移过去。
	 *
	 * 对齐的是面板里「当前高亮的那一条」而不是面板顶部：面板会带前后各两条语境，
	 * 对顶部就会让高亮条和鼠标差出好几行。
	 */
	const [previewOffset, setPreviewOffset] = useState(0);
	const outlineRef = useRef<HTMLDivElement | null>(null);
	const railRef = useRef<HTMLDivElement | null>(null);
	const previewRef = useRef<HTMLDivElement | null>(null);
	useLayoutEffect(() => {
		if (hoverIndex === null) return;
		const container = outlineRef.current;
		const preview = previewRef.current;
		const dot = railRef.current?.children[hoverIndex] as HTMLElement | undefined;
		if (!container || !preview || !dot) return;
		const containerRect = container.getBoundingClientRect();
		const previewRect = preview.getBoundingClientRect();
		const active = preview.querySelector<HTMLElement>(".outline-entry-on");
		// 高亮条相对面板顶部的偏移（面板自身的 marginTop 会一起平移，差值是稳定的）
		const activeTop = active ? active.getBoundingClientRect().top - previewRect.top : 0;
		const dotTop = dot.getBoundingClientRect().top - containerRect.top;
		// 别超出大纲可视范围：上方不出界，下方留 8px 余量
		const max = Math.max(0, container.clientHeight - preview.offsetHeight - 8);
		setPreviewOffset(Math.max(0, Math.min(dotTop - activeTop, max)));
	}, [hoverIndex, items.length]);
	if (items.length === 0) return null;

	const jump = (id: string) => {
		document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	// 悬停时不止显示这一条：上下各带两条，方便看清前后语境
	const window =
		hoverIndex === null ? [] : items.slice(Math.max(0, hoverIndex - 2), Math.min(items.length, hoverIndex + 3));

	return (
		<div className="outline" aria-label={t("对话大纲")} ref={outlineRef}>
			<div className="outline-rail" ref={railRef} onMouseLeave={scheduleClose} onMouseEnter={keepOpen}>
				{items.map((item, index) => (
					<button
						type="button"
						key={item.id}
						className={`outline-dot${hoverIndex === index ? " outline-dot-on" : ""}`}
						onMouseEnter={() => setHoverIndex(index)}
						onFocus={() => setHoverIndex(index)}
						onClick={() => jump(item.id)}
						title={t(`第 ${item.index} 问`, `Question ${item.index}`)}
					/>
				))}
			</div>
			{hoverIndex !== null ? (
				<div
					className="outline-preview"
					ref={previewRef}
					style={{ marginTop: previewOffset }}
					onMouseEnter={keepOpen}
					onMouseLeave={scheduleClose}
				>
					{window.map((item) => {
						const isCurrent = items[hoverIndex]?.id === item.id;
						return (
							<button
								type="button"
								key={item.id}
								className={`outline-entry${isCurrent ? " outline-entry-on" : ""}`}
								onClick={() => jump(item.id)}
								title={t("点击定位到这条消息")}
							>
								<div className="outline-item">
									<span className="outline-num mono">{String(item.index).padStart(2, "0")}</span>
									<span className="outline-q">{item.question}</span>
								</div>
								{item.answer ? (
									<div className="outline-item outline-item-answer">
										<span className="outline-num mono">A</span>
										<span className="outline-a">{item.answer}</span>
									</div>
								) : null}
							</button>
						);
					})}
					<div className="outline-hint">{t("点击任意一条定位过去")}</div>
				</div>
			) : null}
		</div>
	);
}
