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
			question: text(message) || "（空消息）",
			answer: answer ? text(answer) : "",
		});
	});
	return items;
}

/**
 * 右侧「对话大纲」栏：每条提问一行（编号 + 问题 + 回答摘录），点哪条就滚到哪条。
 *
 * 之前是窄条上的一排小方块 —— 只能看出"有几轮"，看不出内容。
 * 现在换成常驻侧栏（可收起，开关在顶栏）：
 *   · 问题加粗、回答灰色截断两行；
 *   · 悬停整行高亮，不用额外浮层（浮层在窄列里反而挡视线）。
 */
export function ConversationOutline({ messages, hasMoreBefore }: { messages: UiMessage[]; hasMoreBefore: boolean }) {
	const items = buildItems(messages);
	if (items.length === 0) return null;

	const jump = (id: string) => {
		document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: "smooth", block: "start" });
	};

	return (
		<aside className="outline-panel">
			<div className="outline-panel-head">
				<span>对话大纲</span>
				<span className="outline-count">{items.length}</span>
			</div>
			<div className="outline-panel-list">
				{hasMoreBefore ? <div className="outline-more">更早的轮次还没加载（分页未做）</div> : null}
				{items.map((item) => (
					<button
						type="button"
						className="outline-entry"
						key={item.id}
						onClick={() => jump(item.id)}
						title="点击定位到这条消息"
					>
						<span className="outline-num mono">{item.index}</span>
						<span className="outline-body">
							<span className="outline-q">{item.question}</span>
							{item.answer ? <span className="outline-a">{item.answer}</span> : null}
						</span>
					</button>
				))}
			</div>
		</aside>
	);
}
