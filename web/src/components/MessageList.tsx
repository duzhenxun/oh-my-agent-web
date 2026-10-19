import { setDraft } from "../store.ts";
import type { ActionItem, EngineName, UiMessage } from "../types.ts";
import type { PendingSend } from "../pending-sends.ts";
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

function MessageView({ message }: { message: UiMessage }) {
	const text = textOfMessage(message);
	return (
		<article className={`msg msg-${message.role}`} id={`msg-${message.id}`}>
			<header className="msg-head">
				<span className="msg-role">{message.role === "user" ? "我" : "助手"}</span>
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
	pending?: PendingSend[];
	onRecallPending?: (id: number) => void;
	onCancelPending?: (id: number) => void;
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
						<article className={`msg msg-user pending-item pending-${item.mode}`} key={item.id}>
							<header className="msg-head">
								<span className="msg-role">我</span>
								<span className={`sent-tag sent-tag-${item.mode}`}>{item.mode === "steer" ? "插队" : "排队"}</span>
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
