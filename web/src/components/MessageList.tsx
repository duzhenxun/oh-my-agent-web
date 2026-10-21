import { memo, useState } from "react";
import { setDraft } from "../store.ts";
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

/** 千分位：5865 → 5,865 */
function withThousands(value: number): string {
	return value.toLocaleString("en-US");
}

/** 绝对时间：10月20日 00:05:33（精确到秒） */
function stampOf(ts: number): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	return `${date.getMonth() + 1}月${date.getDate()}日 ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
}

/** 耗时显示：`2s` / `1.4s` / `1m20s` */
function formatDuration(ms: number): string {
	if (ms < 1000) return `${Math.round(ms)}ms`;
	if (ms < 60_000) return ms < 10_000 ? `${(ms / 1000).toFixed(1)}s` : `${Math.round(ms / 1000)}s`;
	const minutes = Math.floor(ms / 60_000);
	const seconds = Math.round((ms % 60_000) / 1000);
	return seconds > 0 ? `${minutes}m${seconds}s` : `${minutes}m`;
}

/**
 * 思考过程：**所有段落收成一块**，默认只显示一行（三角展开看全文）。
 *
 * 为什么不一段一行：模型一轮能想十几段，散着排会把整条消息撑到几十行，
 * 正文反而找不到了。收成一行「思考 9 段 · 耗时 2s」既看得出想过、又不占地方。
 */
function ThinkingGroup({ texts, durationMs }: { texts: string[]; durationMs?: number }) {
	const [open, setOpen] = useState(false);
	const joined = texts.join("\n\n").trim();
	if (joined === "") return null;
	const preview = joined.replace(/\s+/g, " ").trim().slice(0, 120);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-head" onClick={() => setOpen((value) => !value)}>
				<span aria-hidden="true">💡</span>
				<span className="thinking-label">
					思考{texts.length > 1 ? ` ${texts.length} 段` : ""}
					{open ? "" : "（点击展开）"}
				</span>
				<span className="thinking-preview">{preview}</span>
				{durationMs && durationMs > 0 ? (
					<span className="thinking-duration">· 耗时 {formatDuration(durationMs)}</span>
				) : null}
				<span className="thinking-caret">{open ? "▾" : "▸"}</span>
			</button>
			{open ? <div className="thinking-body">{joined}</div> : null}
		</div>
	);
}

function MessageViewInner({
	message,
	agentLabel,
	modelLabel,
}: {
	message: UiMessage;
	agentLabel: string;
	modelLabel: string;
}) {
	const text = textOfMessage(message);
	// 工具调用默认折叠：只把"最终处理好的回答"露出来，想看过程再展开
	const toolBlocks = message.blocks.filter((block) => block.kind === "tool");
	const thinkingTexts = message.blocks.flatMap((block) => (block.kind === "thinking" ? [block.text] : []));
	/** 工具总耗时：每张工具卡自己带起止时间，加起来就有（没有结束时间的按 0 算） */
	const toolDurationMs = toolBlocks.reduce(
		(sum, block) => sum + (block.kind === "tool" && block.endedAt ? block.endedAt - block.startedAt : 0),
		0,
	);
	const [showTools, setShowTools] = useState(false);
	return (
		<article className={`msg msg-${message.role}`} id={`msg-${message.id}`}>
			<header className="msg-head">
				<span className="msg-role">{message.role === "user" ? "我" : agentLabel}</span>
				{message.steer ? <span className="sent-tag sent-tag-steer">引导</span> : null}
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
						{toolDurationMs > 0 ? ` · 耗时 ${formatDuration(toolDurationMs)}` : ""}
					</button>
				) : null}
				{message.blocks.map((block, index) => {
					if (block.kind === "thinking") {
						// 收成一块：只在第一个思考块的位置渲染，后续思考块跳过
						const firstThinking = message.blocks.findIndex((item) => item.kind === "thinking") === index;
						return firstThinking ? (
							<ThinkingGroup key="thinking" texts={thinkingTexts} durationMs={message.thinkingMs} />
						) : null;
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
			{message.role === "assistant" ? (
				<footer className="msg-foot">
					{message.usage ? (
						<span className="msg-usage mono" title="本次回复的 token 用量（输入 / 输出 / 缓存读 与 缓存写）">
							{withThousands(message.usage.input)} in · {withThousands(message.usage.output)} out
							{message.usage.cacheRead > 0 ? ` · ${withThousands(message.usage.cacheRead)} cache R` : ""}
							{message.usage.cacheWrite > 0 ? ` · ${withThousands(message.usage.cacheWrite)} cache W` : ""}
						</span>
					) : null}
					<button
						type="button"
						className="msg-foot-copy"
						title="复制这条回复"
						onClick={() => void navigator.clipboard?.writeText(text)}
					>
						⧉ 复制
					</button>
					<span className="topbar-spacer" />
					<span className="msg-foot-stamp">{stampOf(message.ts)}</span>
				</footer>
			) : null}
		</article>
	);
}

/** 一条消息：抬头（引擎 / 模型）+ 可折叠的工具调用 + markdown 正文。
 *
 * memo 是手机端卡顿的关键：以前每条消息都自己 `useAppState()`，而 store 是
 * 「整份快照 + 草稿」一个对象 —— 在输入框里打**一个字**、或流式来一个 delta，
 * 全篇消息都会重渲染，markdown 得重新解析一遍。现在引擎/模型由外层算好传进来，
 * 内容没变的消息直接跳过。
 */
const MessageView = memo(MessageViewInner);

export function MessageList({
	messages,
	hasMoreBefore,
	engine,
	modelLabel: modelLabelProp,
	actions,
	running,
	pending = [],
	onRecallPending,
	onCancelPending,
}: {
	messages: UiMessage[];
	hasMoreBefore: boolean;
	engine: EngineName;
	/** 当前模型的显示名（与底部模型选择器里那个名字**完全一致**），每条消息的抬头用 */
	modelLabel?: string;
	actions: ActionItem[];
	running: boolean;
	/** 「插队 / 排队」中、还没真正发出的消息 */
	pending?: QueuedView[];
	onRecallPending?: (id: string) => void;
	onCancelPending?: (id: string) => void;
}) {
	// 抬头上的两个标签只算一次（以前是每条消息各自从 store 里拿）
	const agentLabel = engine === "fake" ? "FAKE" : "PI";
	// 抬头显示的名字由外层算好（取快照里 models 的 label），保证和底部选择器一字不差
	const modelLabel = modelLabelProp ?? "";
	// 空会话（新会话）什么都不画：标题/引导在输入框上方那块（NewChatMeta），这里留白
	if (messages.length === 0) return null;

	return (
		<div className="messages">
			{hasMoreBefore ? <div className="more-before">更早的消息未在本页（分页在 M6）</div> : null}
			{messages.map((message) => (
				<MessageView key={message.id} message={message} agentLabel={agentLabel} modelLabel={modelLabel} />
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
