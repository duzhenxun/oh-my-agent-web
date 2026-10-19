import { useState } from "react";
import type { UiMessage } from "../types.ts";

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
			question: text(message).slice(0, 120) || "（空消息）",
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
	const [hoverId, setHoverId] = useState<string | null>(null);
	const items = buildItems(messages);
	if (items.length === 0) return null;

	const jump = (id: string) => {
		const element = document.getElementById(`msg-${id}`);
		element?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	return (
		<div className="outline" aria-label="对话大纲">
			<div className="outline-rail">
				{items.map((item) => (
					<button
						type="button"
						key={item.id}
						className={`outline-dot${hoverId === item.id ? " outline-dot-on" : ""}`}
						onMouseEnter={() => setHoverId(item.id)}
						onMouseLeave={() => setHoverId((current) => (current === item.id ? null : current))}
						onFocus={() => setHoverId(item.id)}
						onClick={() => jump(item.id)}
						title={`第 ${item.index} 问`}
					/>
				))}
			</div>
			{hoverId ? (
				<div className="outline-preview">
					{(() => {
						const item = items.find((entry) => entry.id === hoverId);
						if (!item) return null;
						return (
							<>
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
								<div className="outline-hint">点击定位到这条消息</div>
							</>
						);
					})()}
				</div>
			) : null}
		</div>
	);
}
