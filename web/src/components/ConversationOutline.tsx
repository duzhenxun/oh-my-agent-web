import { useMemo, useRef, useState } from "react";
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
	if (items.length === 0) return null;

	const jump = (id: string) => {
		document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	// 悬停时不止显示这一条：上下各带两条，方便看清前后语境
	const window =
		hoverIndex === null ? [] : items.slice(Math.max(0, hoverIndex - 2), Math.min(items.length, hoverIndex + 3));

	return (
		<div className="outline" aria-label={t("对话大纲")}>
			<div className="outline-rail" onMouseLeave={scheduleClose} onMouseEnter={keepOpen}>
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
				<div className="outline-preview" onMouseEnter={keepOpen} onMouseLeave={scheduleClose}>
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
