import type { UiMessage } from "../types.ts";
import { Markdown } from "./Markdown.tsx";
import { ToolCard } from "./ToolCard.tsx";

function MessageView({ message }: { message: UiMessage }) {
	return (
		<article className={`msg msg-${message.role}`}>
			<header className="msg-head">
				<span className="msg-role">{message.role === "user" ? "我" : "助手"}</span>
				<span className="msg-time">{new Date(message.ts).toLocaleTimeString()}</span>
			</header>
			<div className="msg-body">
				{message.blocks.map((block, index) => {
					if (block.kind === "text") {
						return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
					}
					if (block.kind === "tool") {
						return <ToolCard key={block.toolCallId} block={block} />;
					}
					return (
						<div key={index} className="block-error">
							<span className="block-error-code">{block.code}</span>
							<span className="block-error-text">{block.message}</span>
						</div>
					);
				})}
			</div>
		</article>
	);
}

const HINTS = ["tool", "approve", "fail", "huge", "boom", "slow"];

export function MessageList({ messages, hasMoreBefore }: { messages: UiMessage[]; hasMoreBefore: boolean }) {
	if (messages.length === 0) {
		return (
			<div className="empty">
				<p>M1：假引擎已就绪（没有调用任何模型）。试试这些触发词：</p>
				<ul>
					{HINTS.map((hint) => (
						<li key={hint}>
							<code>{hint}</code>
							<span className="empty-hint">
								{hint === "tool" ? "工具卡片" : null}
								{hint === "approve" ? "审批弹窗" : null}
								{hint === "fail" ? "失败的工具（退出码）" : null}
								{hint === "huge" ? "超大输出截断" : null}
								{hint === "boom" ? "错误块 + notice" : null}
								{hint === "slow" ? "慢速输出（用来试「停止」）" : null}
							</span>
						</li>
					))}
				</ul>
			</div>
		);
	}

	return (
		<div className="messages">
			{hasMoreBefore ? <div className="more-before">更早的消息未在本页（分页在 M6）</div> : null}
			{messages.map((message) => (
				<MessageView key={message.id} message={message} />
			))}
		</div>
	);
}
