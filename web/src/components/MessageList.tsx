import { memo, useState } from "react";
import { setDraft } from "../store.ts";
import type { UiMessage } from "../types.ts";
import type { QueuedView } from "../pending-sends.ts";
import { formatRate, useLiveStats } from "../stream-speed.ts";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import { ToolCard } from "./ToolCard.tsx";

/** 消息里的纯文本（复制 / 从此处编辑都用它） */
export function textOfMessage(message: UiMessage): string {
	return message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((text) => text.trim() !== "")
		.join("\n\n");
}

/** 过程里的一项（思考或工具调用） */
type ProcessItem = Extract<UiMessage["blocks"][number], { kind: "thinking" } | { kind: "tool" }>;

/**
 * 把平坦的过程列表切成小块：**一段思考 + 它后面跟着的那些工具调用** = 一小块。
 *
 * 为什么不在渲染时现算：过程列表一长（五六个思考、十几次工具），扁平地排下来
 * 分不清「哪几次工具是这次想完之后干的」。切成块后每块前面有编号，读起来是
 * 「想 ① → 试一下 → 再想 ② → 再试」的节奏。
 *
 * 规则：
 *   - 碰到 thinking 就开新块（后续工具都归它）；
 *   - 第一个 thinking 之前就有工具（少见，但不是不可能）→ 单独成一块，`thinking` 为 null。
 */
export function groupProcess(items: ProcessItem[]): {
	thinking: { text: string; index: number } | null;
	tools: Extract<ProcessItem, { kind: "tool" }>[];
}[] {
	const groups: {
		thinking: { text: string; index: number } | null;
		tools: Extract<ProcessItem, { kind: "tool" }>[];
	}[] = [];
	let thinkingCount = 0;
	for (const item of items) {
		if (item.kind === "thinking") {
			thinkingCount += 1;
			groups.push({ thinking: { text: item.text, index: thinkingCount }, tools: [] });
			continue;
		}
		const last = groups[groups.length - 1];
		if (last) last.tools.push(item);
		else groups.push({ thinking: null, tools: [item] });
	}
	return groups;
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
 * 一段思考：单独一行，点开展开全文。
 *
 * 以前是「所有思考段合并成一块」，工具调用又单独提到最上面 —— 于是「想 → 调工具 → 想 → 调工具」
 * 的顺序全乱了。现在思考与工具都交给外层的「过程」容器按发生顺序摆，这里只管一段。
 */
function ThinkingSegment({ text, index }: { text: string; index: number }) {
	const [open, setOpen] = useState(false);
	const joined = text.trim();
	if (joined === "") return null;
	const preview = joined.replace(/\s+/g, " ").trim().slice(0, 160);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-head" onClick={() => setOpen((value) => !value)}>
				{/* 编号在最前面：一眼能数到「第几次思考」，也方便指代（“看第 2 段”） */}
				<span className="thinking-index mono" title={`第 ${index} 段思考`}>
					{index}
				</span>
				<span aria-hidden="true">💡</span>
				<span className="thinking-label">思考{open ? "" : "（点击展开）"}</span>
				{open ? null : <span className="thinking-preview">{preview}</span>}
				<span className="thinking-caret">{open ? "▾" : "▸"}</span>
			</button>
			{open ? <div className="thinking-body">{joined}</div> : null}
		</div>
	);
}

/**
 * 流式中的实时数字：`↓ 已生成 token` + 最近几秒的 `t/s` 徽标。
 *
 * 只在「这条消息还在跑」时挂载 —— 挂载即采样（见 stream-speed.ts），
 * 跑完卸载，数字随之消失、交回尾注里的真实用量。
 */
function LiveOutput({ message }: { message: UiMessage }) {
	// 正文 + 思考一起算：思考也是吐出来的 token，不算进去闷头想事时看着像卡住
	const text = message.blocks
		.map((block) => (block.kind === "text" || block.kind === "thinking" ? block.text : ""))
		.join("");
	const live = useLiveStats(text);
	// 0 token = 还没吐第一个字：宁可什么都不画 —— 「↓ 0」看着像卡在起点
	if (live.tokens === 0) return null;
	return (
		<span className="msg-live">
			<span
				className="msg-live-tokens mono"
				title="这条回复已生成的 token（流式期间按字符估算；跑完后尾注给引擎报的真实用量）"
			>
				{/* 箭头单独一个 span：等宽字体里的空格很宽，包在文字里会拉出一道难看的空隙 */}
				<span className="msg-live-arrow" aria-hidden="true">
					↓
				</span>
				{withThousands(live.tokens)}
			</span>
			{/* 还没吐出字（或停下来在调工具）时不报速：不占一个空白青底徽标，只把「↓ 数字」留在那 */}
			{live.rate > 0 ? (
				<span className="msg-live-rate mono" title="最近 4 秒的生成速度（token/秒）">
					{formatRate(live.rate)}
				</span>
			) : null}
		</span>
	);
}

function MessageViewInner({ message, modelLabel, live }: { message: UiMessage; modelLabel: string; live: boolean }) {
	const text = textOfMessage(message);
	/**
	 * 「过程」= 思考与工具调用，**按发生顺序**排（想 → 调工具 → 想 → 调工具…）。
	 * 整段默认折叠成一个按钮，展开后每一项仍然各管各的（思考单独展开、工具卡单独展开）。
	 */
	const processItems = message.blocks.filter(
		(block): block is Extract<typeof block, { kind: "thinking" }> | Extract<typeof block, { kind: "tool" }> =>
			block.kind === "thinking" || block.kind === "tool",
	);
	const toolCount = processItems.filter((item) => item.kind === "tool").length;
	const thinkingCount = processItems.length - toolCount;
	/** 过程总耗时：工具卡自带起止时间，思考用累计的 thinkingMs */
	const toolDurationMs = processItems.reduce(
		(sum, item) => sum + (item.kind === "tool" && item.endedAt ? item.endedAt - item.startedAt : 0),
		0,
	);
	const processDurationMs = toolDurationMs + (message.thinkingMs ?? 0);
	const [showTools, setShowTools] = useState(false);
	/**
	 * 时间只有尾注左下这一处：消息一出现就显示（开始时间），跑完再更新成完成时间。
	 * 抬头不再放时间（打开历史时那串时分秒很吵）。
	 */
	const finishedAt = message.endedAt ?? null;
	return (
		// 用户消息：操作/时间那一行放在气泡**里面**（换行分隔），不挂在气泡下面
		<article className={`msg msg-${message.role}`} id={`msg-${message.id}`}>
			{/* 助手抬头：模型 + 实时数字。
			    用户消息**不要抬头**（气泡里只有自己说的话），时间与操作放到气泡下面那行。 */}
			{message.role === "assistant" || message.steer ? (
				<header className="msg-head">
					{message.role === "assistant" && modelLabel !== "" ? (
						<span className="msg-model" title="这条消息生成时用的模型">
							{modelLabel}
						</span>
					) : null}
					{live ? <LiveOutput message={message} /> : null}
					{message.steer ? <span className="sent-tag sent-tag-steer">引导</span> : null}
				</header>
			) : null}
			<div className="msg-bubble">
				<div className="msg-body">
					{processItems.length > 0 ? (
						<div className="msg-process">
							<button
								type="button"
								className="msg-tools-toggle"
								onClick={() => setShowTools((value) => !value)}
								title="思考与工具调用按发生顺序排列"
							>
								<span className={`msg-tools-caret${showTools ? " msg-tools-caret-open" : ""}`} aria-hidden="true" />
								{/* 耗时放最前：一眼先看「这轮花了多久」，后面才是细节计数 */}
								{processDurationMs > 0 ? (
									<span className="msg-process-meta">耗时 {formatDuration(processDurationMs)}</span>
								) : null}
								{thinkingCount > 0 ? <span className="msg-process-meta">{thinkingCount} 段思考</span> : null}
								{toolCount > 0 ? <span className="msg-process-meta">{toolCount} 次工具</span> : null}
								<span>
									过程 {processItems.length} 步{showTools ? "（点击收起）" : "（点击展开）"}
								</span>
							</button>
							{showTools ? (
								<div className="msg-process-body">
									{/* 一块 = 一段思考 + 它后面跟着的工具调用（见 groupProcess） */}
									{groupProcess(processItems).map((group, groupIndex) => (
										<div
											className="process-group"
											key={group.thinking ? `think-${group.thinking.index}` : `lead-${groupIndex}`}
										>
											{group.thinking ? (
												<ThinkingSegment text={group.thinking.text} index={group.thinking.index} />
											) : null}
											{group.tools.map((tool, toolIndex) => (
												<ToolCard key={tool.toolCallId || `tool-${groupIndex}-${toolIndex}`} block={tool} />
											))}
										</div>
									))}
								</div>
							) : null}
						</div>
					) : null}
					{message.blocks.map((block, index) => {
						// 思考 / 工具都进「过程」容器了，这里只画正文与错误块
						if (block.kind === "thinking" || block.kind === "tool") return null;
						if (block.kind === "text") {
							return block.text.trim() ? <Markdown key={index} text={block.text} /> : null;
						}
						return (
							<div key={index} className="block-error">
								<span className="block-error-code">{block.code}</span>
								<span className="block-error-text">{block.message}</span>
							</div>
						);
					})}
				</div>
			</div>
			{message.role === "user" ? (
				// 气泡下面那一行：默认只露时间；复制/编辑鼠标悬浮在气泡上才出现（靠右、排在时间前面）
				<footer className="msg-user-foot">
					<CopyButton text={text} title="复制这条消息" />
					<button
						type="button"
						className="msg-action"
						onClick={() => setDraft(text)}
						title="把这条消息放回输入框，改完再发"
					>
						↳ 从此处编辑
					</button>
					<span className="msg-foot-stamp">{stampOf(message.ts)}</span>
				</footer>
			) : null}
			{message.role === "assistant" ? (
				<footer className="msg-foot">
					{message.usage ? (
						<span
							className="msg-usage mono"
							title="本轮合计（含过程里每一次模型调用的费用）：输入 / 输出 / 缓存读 / 缓存写"
						>
							{withThousands(message.usage.input)} in · {withThousands(message.usage.output)} out
							{message.usage.cacheRead > 0 ? ` · ${withThousands(message.usage.cacheRead)} cache R` : ""}
							{message.usage.cacheWrite > 0 ? ` · ${withThousands(message.usage.cacheWrite)} cache W` : ""}
							{/* 本次花费：pi 只在 provider 配了价格时给（拿不到就不显示，不编 0） */}
							{message.usage.cost ? ` · ${formatCost(message.usage.cost)}` : ""}
						</span>
					) : null}
					<CopyButton text={text} className="msg-foot-copy" title="复制这条回复" />
					<span className="topbar-spacer" />
					{/* 时间：**一开始就显示**（先给开始时间），跑完再换成完成时间 —— 不再等结束才出现 */}
					<span className="msg-foot-stamp" title={finishedAt !== null ? "这条回复完成的时间" : "这条回复开始的时间"}>
						{stampOf(finishedAt ?? message.ts)}
					</span>
				</footer>
			) : null}
		</article>
	);
}

/**
 * 最后一条「还没跑完」的助手消息：回合结束时会写 endedAt，所以「没有 endedAt」就是还在流式。
 * 倒着找（不用 findLast：手机上的老 Safari 没这个方法）。
 */
function lastOpenAssistant(messages: UiMessage[]): UiMessage | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message && message.role === "assistant" && message.endedAt === undefined) return message;
	}
	return null;
}

/** 花费：小额（<1 分）多给两位小数，否则「$0.00」会看不出差别 */
function formatCost(cost: number): string {
	return `$${cost < 0.01 ? cost.toFixed(4) : cost.toFixed(2)}`;
}

/** 一条消息：抬头（引擎 / 模型）+ 可折叠的工具调用 + markdown 正文。
 *
 * memo 是手机端卡顿的关键：以前每条消息都自己 `useAppState()`，而 store 是
 * 「整份快照 + 草稿」一个对象 —— 在输入框里打**一个字**、或流式来一个 delta，
 * 全篇消息都会重渲染，markdown 得重新解析一遍。现在模型名由外层算好传进来，
 * 内容没变的消息直接跳过。
 */
const MessageView = memo(MessageViewInner);

export function MessageList({
	messages,
	hasMoreBefore,
	modelLabels,
	running = false,
	pending = [],
	onRecallPending,
	onCancelPending,
}: {
	messages: UiMessage[];
	hasMoreBefore: boolean;
	/** 模型 id → 显示名（取自快照的模型表，和底部选择器同一份数据） */
	modelLabels?: Record<string, string>;
	/** 当前会话这一轮是否在跑：只有它才会给最后一条助手消息挂实时数字 */
	running?: boolean;
	/** 「插队 / 排队」中、还没真正发出的消息 */
	pending?: QueuedView[];
	onRecallPending?: (id: string) => void;
	onCancelPending?: (id: string) => void;
}) {
	// 抬头的模型名只算一次（以前是每条消息各自从 store 里拿）
	/** 一条消息抬头显示什么模型：**用它自己生成时的模型**（历史不会跟当前选择变） */
	const labelOf = (model: string | undefined): string => {
		if (!model) return "";
		const mapped = modelLabels?.[model];
		if (mapped) return mapped;
		// 模型表里没有（旧记录 / 已删除的 provider）：退化成去掉 provider 前缀的 id
		return model.split("/").slice(1).join("/") || model;
	};
	// 空会话（新会话）什么都不画：标题/引导在输入框上方那块（NewChatMeta），这里留白
	if (messages.length === 0) return null;
	// 实时数字挂在哪条消息上：最后一条**还没跑完**的助手消息（跑完 endedAt 才有值）
	const liveId = running ? (lastOpenAssistant(messages)?.id ?? null) : null;

	return (
		<div className="messages">
			{hasMoreBefore ? <div className="more-before">更早的消息未在本页（分页在 M6）</div> : null}
			{messages.map((message) => (
				<MessageView
					key={message.id}
					message={message}
					modelLabel={labelOf(message.model)}
					live={message.id === liveId}
				/>
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
		</div>
	);
}
