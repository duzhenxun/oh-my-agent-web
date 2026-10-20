import { useState } from "react";
import { setDraft, useAppState } from "../store.ts";
import type { ActionItem, EngineName, UiMessage } from "../types.ts";
import type { QueuedView } from "../pending-sends.ts";
import { ActionSuggestions } from "./ActionSuggestions.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolCard } from "./ToolCard.tsx";

/** 消息里的纯文本（复制 / 从此处编辑都用它） */
export function textOfMessage(message: UiMessage): string {
	return message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((text) => text.trim() !== "")
		.join("\n\n");
}

/** 思考过程：默认折叠成一行，点开看全文（和工具调用一样"想看的才看"） */
function ThinkingBlockView({ text }: { text: string }) {
	const [open, setOpen] = useState(false);
	if (text.trim() === "") return null;
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-head" onClick={() => setOpen((value) => !value)}>
				<span aria-hidden="true">💡</span>
				<span className="thinking-preview">{text.replace(/\s+/g, " ").trim().slice(0, 120)}</span>
				<span className="thinking-caret">{open ? "▾" : "▸"}</span>
			</button>
			{open ? <div className="thinking-body">{text}</div> : null}
		</div>
	);
}

function MessageView({ message }: { message: UiMessage }) {
	// 助手消息的抬头：当前 Agent（引擎）+ 当前模型（模型名用蓝色，见 .msg-model）
	const { snapshot } = useAppState();
	const agentLabel = snapshot?.engine === "fake" ? "FAKE" : "PI";
	// 只显示模型 id：`provider/model` 去掉前缀（前缀在下面的模型选择器里能看到）
	const modelLabel = snapshot?.model ? snapshot.model.split("/").slice(1).join("/") || snapshot.model : "";
	const text = textOfMessage(message);
	// 工具调用默认折叠：只把"最终处理好的回答"露出来，想看过程再展开
	const toolBlocks = message.blocks.filter((block) => block.kind === "tool");
	const [showTools, setShowTools] = useState(false);
	return (
		<article className={`msg msg-${message.role}`} id={`msg-${message.id}`}>
			<header className="msg-head">
				<span className="msg-role">{message.role === "user" ? "我" : agentLabel}</span>
				{message.role === "assistant" && modelLabel !== "" ? (
					<span className="msg-model" title="这条会话当前使用的模型">
						{modelLabel}
					</span>
				) : null}
				<span className="msg-time">{new Date(message.ts).toLocaleTimeString()}</span>
				{/* 鼠标悬浮才出现的操作（用户消息还额外支持「从此处编辑」） */}
				<div className="msg-actions">
					<button
						type="button"
						className="msg-action"
						onClick={() => void navigator.clipboard?.writeText(text)}
						title="复制这条消息"
					>
						⧉ 复制
					</button>
					{message.role === "user" ? (
						<button
							type="button"
							className="msg-action"
							onClick={() => setDraft(text)}
							title="把这条消息放回输入框，改完再发"
						>
							↳ 从此处编辑
						</button>
					) : null}
				</div>
			</header>
			<div className="msg-body">
				{toolBlocks.length > 0 ? (
					<button type="button" className="msg-tools-toggle" onClick={() => setShowTools((value) => !value)}>
						<span className={`msg-tools-caret${showTools ? " msg-tools-caret-open" : ""}`} aria-hidden="true" />
						{toolBlocks.length} 次工具调用{showTools ? "（点击收起）" : "（点击查看过程）"}
					</button>
				) : null}
				{message.blocks.map((block, index) => {
					if (block.kind === "thinking") {
						return <ThinkingBlockView key={index} text={block.text} />;
					}
					if (block.kind === "text") {
						return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
					}
					if (block.kind === "tool") {
						return showTools ? <ToolCard key={block.toolCallId} block={block} /> : null;
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

/** 假引擎（AGENT_WEB_ENGINE=fake）的剧本触发词，只在那个模式下才有意义 */
const FAKE_HINTS: Array<[string, string]> = [
	["tool", "工具卡片"],
	["approve", "审批弹窗"],
	["fail", "失败的工具（退出码）"],
	["huge", "超大输出截断"],
	["boom", "错误块 + notice"],
	["slow", "慢速输出（用来试「停止」）"],
];

/** 真实引擎下该说什么：引导它干活，并说明安全边界 */
const REAL_HINTS = [
	"读一个文件，先说清它做什么",
	"改一处代码，然后跑一次测试",
	"在仓库里搜一个符号，列出在哪儿定义、在哪儿用",
];

function EmptyState({ engine }: { engine: EngineName }) {
	if (engine === "fake") {
		return (
			<div className="empty">
				<p>
					当前是<strong>假引擎</strong>（<code>AGENT_WEB_ENGINE=fake</code>
					）：不调用任何模型，只按剧本回话。试试这些触发词：
				</p>
				<ul>
					{FAKE_HINTS.map(([keyword, description]) => (
						<li key={keyword}>
							<code>{keyword}</code>
							<span className="empty-hint">{description}</span>
						</li>
					))}
				</ul>
			</div>
		);
	}
	return (
		<div className="empty">
			<p>直接在下面说话就行 —— 它会读文件、改代码、跑命令，危险操作会先弹窗问你。</p>
			<ul>
				{REAL_HINTS.map((hint) => (
					<li key={hint}>{hint}</li>
				))}
			</ul>
			<p className="empty-hint">工作区就是上面那个目录；会话会自动存到 ~/.agent-web。</p>
		</div>
	);
}

export function MessageList({
	messages,
	hasMoreBefore,
	engine,
	actions,
	running,
	pending = [],
	onRecallPending,
	onCancelPending,
}: {
	messages: UiMessage[];
	hasMoreBefore: boolean;
	engine: EngineName;
	actions: ActionItem[];
	running: boolean;
	/** 「插队 / 排队」中、还没真正发出的消息 */
	pending?: QueuedView[];
	onRecallPending?: (id: string) => void;
	onCancelPending?: (id: string) => void;
}) {
	if (messages.length === 0) return <EmptyState engine={engine} />;

	return (
		<div className="messages">
			{hasMoreBefore ? <div className="more-before">更早的消息未在本页（分页在 M6）</div> : null}
			{messages.map((message) => (
				<MessageView key={message.id} message={message} />
			))}
			{/* 建议操作紧跟在最后一条消息之后（ADR-0022）：它是「针对这一轮」的下一步 */}
			{pending.length > 0 ? (
				<div className="pending-sends">
					{pending.map((item) => (
						<article className="msg msg-user pending-item pending-queue" key={item.id}>
							<header className="msg-head">
								<span className="msg-role">我</span>
								<span className="sent-tag sent-tag-queue">排队</span>
								<span className="topbar-spacer" />
								<button
									type="button"
									className="msg-action"
									title="移回输入框"
									onClick={() => onRecallPending?.(item.id)}
								>
									↩
								</button>
								<button
									type="button"
									className="msg-action"
									title="取消这条"
									onClick={() => onCancelPending?.(item.id)}
								>
									×
								</button>
							</header>
							<div className="msg-body">{item.text}</div>
						</article>
					))}
				</div>
			) : null}
			<ActionSuggestions actions={actions} running={running} />
		</div>
	);
}
