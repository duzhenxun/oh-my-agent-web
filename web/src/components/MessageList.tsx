import { memo, useEffect, useRef, useState } from "react";
import { setDraft } from "../store.ts";
import { SELECTION_TOOLBAR_KEY, THINKING_OPEN_KEY, TOOL_OPEN_KEY } from "../ui-prefs.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { useShowCost } from "../use-show-cost.ts";
import type { ActionItem, SubagentRunView, UiMessage } from "../types.ts";
import type { QueuedView } from "../pending-sends.ts";
import { firstLine, readExpanded, toggleExpanded, writeExpanded } from "../steer-collapsed.ts";
import { liftSteeredMessages } from "../steer-order.ts";
import { compactTokens } from "../session-metrics.ts";
import { formatRate, useLiveStats } from "../stream-speed.ts";
import { changedFilesIn } from "../changed-files.ts";
import { ActionSuggestions } from "./ActionSuggestions.tsx";
import { ChangedFiles } from "./ChangedFiles.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import { SelectionToolbar, type SelectionAddInput } from "./SelectionToolbar.tsx";
import { AnnotationMarks } from "./AnnotationMarks.tsx";
import type { Annotation } from "../annotations.ts";
import { ToolCard } from "./ToolCard.tsx";
import { AgentsRunStrip } from "./AgentsRunStrip.tsx";
import { assignRunsToMessages, subagentUsageOf } from "../subagent-view.tsx";

/** 消息里的纯文本（复制 / 从此处编辑都用它） */

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
function groupProcess(items: ProcessItem[]): {
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

/** 绝对时间：10月20日 00:05:33；`withDate: false` 时只留时间 00:05:33（手机上用） */
function stampOf(ts: number, withDate = true): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	return withDate ? `${date.getMonth() + 1}月${date.getDate()}日 ${time}` : time;
}

/**
 * 尾注时间那一小格：**两种写法都渲染**，由 CSS 决定显示哪个。
 *
 * 为什么不用 JS 判宽度：媒体查询是纯 CSS 的，横竖屏旋转、宽窄屏切换都不用重渲染。
 * 现在两边都显示**带月日的完整写法**（用户 2026-10-30：「用户发出的消息，要把月日也显示出来」）——
 * 手机上曾经为了给「复制 / 从此处编辑」腾地方去掉了月日，结果隔天翻记录只看到 `13:31:53`，
 * 分不清是哪一天。收起的那几粒字才几十像素，日期比它值钱。
 * `-short` 这一份**先留着**：哪天又要在窄屏上省地方，改一行 CSS 就能切回去，不用动 JSX。
 */
function FootStamp({ ts, title }: { ts: number; title: string }) {
	return (
		<span className="msg-foot-stamp" title={title}>
			<span className="msg-foot-stamp-full">{stampOf(ts)}</span>
			<span className="msg-foot-stamp-short">{stampOf(ts, false)}</span>
		</span>
	);
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
 * 收起时的思考预览：**一行文字，放不下就省略号**（不做任何滚动动画）。
 *
 * 以前这里是跑马灯（按实测宽度算起点/终点 + 恒定速度横向滚一趟）。去掉的原因：它一直在动，
 * 而这一行只是"这轮想了什么"的提示；要看全文点开就是。动的东西在长会话里还会一直抢注意力，
 * 几十个折叠块同时挂着动画也不便宜。
 */
function ThinkingPreview({ text }: { text: string }) {
	return (
		<span className="thinking-preview" title={text}>
			{text}
		</span>
	);
}

/**
 * 一段思考：单独一行，点开展开全文。
 *
 * 以前是「所有思考段合并成一块」，工具调用又单独提到最上面 —— 于是「想 → 调工具 → 想 → 调工具」
 * 的顺序全乱了。现在思考与工具都交给外层的「过程」容器按发生顺序摆，这里只管一段。
 */
function ThinkingSegment({ text, index }: { text: string; index: number }) {
	const t = useT();
	/**
	 * 展开状态 = 「用户对**这一块**的手动选择」优先，否则跟着「设置 → 界面 → 过程 → 默认展开思考块」走。
	 * 用 `manual ?? pref` 而不是 useEffect 同步：手点过的块不会被全局开关拽回去，
	 * 没点过的块在开关一拨就立刻跟着变 —— 拨完马上能看到效果，不用等新消息。
	 */
	const [manualOpen, setManualOpen] = useState<boolean | null>(null);
	const [defaultOpen] = useStoredBool(THINKING_OPEN_KEY, false);
	const open = manualOpen ?? defaultOpen;
	const joined = text.trim();
	if (joined === "") return null;
	const preview = joined.replace(/\s+/g, " ").trim().slice(0, 160);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-head" onClick={() => setManualOpen(!open)}>
				{/* 编号在最前面：一眼能数到「第几次思考」，也方便指代（“看第 2 段”） */}
				<span className="thinking-index mono" title={`第 ${index} 段思考`}>
					{index}
				</span>
				<span aria-hidden="true">💡</span>
				<span className="thinking-label">
					{t("思考", "Thinking")}
					{open ? "" : t("（点击展开）", " (click to expand)")}
				</span>
				{open ? null : <ThinkingPreview text={preview} />}
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
	const t = useT();
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
				title={t(
					"这条回复已生成的 token（流式期间按字符估算；跑完后尾注给引擎报的真实用量）",
					"Tokens generated so far (estimated from characters while streaming; the footnote shows the engine's real usage afterwards)",
				)}
			>
				{/* 箭头单独一个 span：等宽字体里的空格很宽，包在文字里会拉出一道难看的空隙 */}
				<span className="msg-live-arrow" aria-hidden="true">
					↓
				</span>
				{withThousands(live.tokens)}
			</span>
			{/* 还没吐出字（或停下来在调工具）时不报速：不占一个空白青底徽标，只把「↓ 数字」留在那 */}
			{live.rate > 0 ? (
				<span
					className="msg-live-rate mono"
					title={t("最近 4 秒的生成速度（token/秒）", "Generation speed over the last 4 seconds (tokens/s)")}
				>
					{formatRate(live.rate)}
				</span>
			) : null}
		</span>
	);
}

import { argsPreview } from "./ToolCard.tsx";
import { useT } from "../use-language.ts";
import { textOfMessage } from "../message-text.ts";
import { rememberMessages } from "../store.ts";
import { setPathOpener } from "../path-tokens.ts";

/**
 * 「这一刻在干什么。」
 *
 * 为什么单独一行：一轮跑起来后，「过程」容器**默认是折扇**的 —— 只写一行「1 段思考 1 次工具」，
 * 用户看不到中间在干什么。这一行永远贴在消息末尾、折扇体外面，所以：
 *   - 有工具在跑 → 「正在运行 bash…」+ 参数摘要（能看出这一步动的是哪条命令 / 哪个文件）
 *   - 模型在想事 / 还没开口 → 「正在等待模型…」
 *   - 正文正在流式吐字 → 不画（正文本身在动，再加一行只会让人以为卡住了）
 */
function activityVerb(name: string): string {
	if (/^(bash|sh|shell|shell_command|exec|run|run_command|terminal)$/i.test(name)) return "正在运行";
	if (/^(write|edit|str_replace|apply_patch|patch|multi_edit|multiedit|notebook_edit)$/i.test(name))
		return "正在修改文件";
	if (/^(read|view|cat|open)$/i.test(name)) return "正在读取文件";
	if (/^(grep|rg|search|find|glob|ls|list)$/i.test(name)) return "正在检索";
	if (/^(web_search|webfetch|fetch|browse)$/i.test(name)) return "正在联网查询";
	return "正在执行";
}

/**
 * 「正文是否已经停下来了。」
 *
 * 只靠「最后一块是正文」判断不够：模型把话说完之后、调工具之前可能要想好几秒，
 * 这期间最后一块仍然是正文 —— 那就什么都没画，又回到「不知道它在干什么」。
 * 所以配一个停表：正文长度在 `delayMs` 内没再长，就当作「停了」→ 恢复等待提示。
 */
function useStalled(active: boolean, length: number, delayMs = 2500): boolean {
	const [stalled, setStalled] = useState(active);
	useEffect(() => {
		if (!active) {
			setStalled(false);
			return;
		}
		setStalled(false);
		const id = window.setTimeout(() => setStalled(true), delayMs);
		return () => window.clearTimeout(id);
	}, [active, length, delayMs]);
	return stalled;
}

function LiveActivity({
	message,
	tool,
	retrying,
}: {
	message: UiMessage;
	/** 正在跑的工具（来自快照 `running.activeTool`；没有就是 null） */
	tool: { name: string; argsSummary: string; startedAt: number } | null;
	/** 传输层被打断、引擎正在自动重试（来自快照 `running.retrying`） */
	retrying?: { attempt: number; maxAttempts: number } | null;
}) {
	const t = useT();
	const tail = message.blocks.at(-1);
	const tailText = tail?.kind === "text" ? tail.text.trim() : "";
	const stalled = useStalled(tailText !== "", tailText.length);
	const now = useSecondTick(tool !== null);
	// 正文还在长 → 让它自己说话。但「正在重试」期间正文本来就是停的，必须盖过这条规则
	if (tailText !== "" && !tool && !stalled && !retrying) return null;

	const retryLabel = retrying ? `模型调用被打断，正在自动重试（${retrying.attempt}/${retrying.maxAttempts}）` : null;
	const verb = tool ? activityVerb(tool.name) : (retryLabel ?? "正在等待模型");
	const args = tool ? argsPreview(tool.argsSummary) : null;
	const seconds = tool ? Math.max(0, Math.floor((now - tool.startedAt) / 1000)) : 0;
	return (
		<div className="msg-activity" role="status" aria-live="polite">
			{/*
			 * 三颗依次呼吸的点，不是一个干转的圆圈（用户 2026-10-29：「换一种图标」）：
			 * 「正在等待模型」本质上是在等它「开口」，三点跳动的语义就是「在想 / 在说」；
			 * 而且三点不靠旋转表达进展，行里还有秒数和参数要读，视觉上安静得多。
			 * 纯 CSS，不加图标包也不加图标文件。
			 */}
			<span className="msg-activity-dots" aria-hidden="true">
				<span className="msg-activity-dot" />
				<span className="msg-activity-dot" />
				<span className="msg-activity-dot" />
			</span>
			<span className="msg-activity-label">
				{verb}
				{tool ? (
					<>
						{" "}
						<span className="msg-activity-tool mono">{tool.name}</span>
					</>
				) : null}
				…
			</span>
			{args ? (
				<span className="msg-activity-args mono" title={args}>
					{args}
				</span>
			) : null}
			{seconds >= 2 ? (
				<span
					className="msg-activity-time mono"
					title={t("这个工具已经跑了多久", "How long this tool has been running")}
				>
					{seconds}s
				</span>
			) : null}
		</div>
	);
}

/**
 * 秒级时钟：只有「正在跑」的那一条会挂定时器，跑完（或不是实时行）立刻拆掉。
 * 不能给每条消息都挂 —— 历史几十条消息一起跑 interval 是白烧电。
 */
function useSecondTick(active: boolean): number {
	const [now, setNow] = useState(() => Date.now());
	useEffect(() => {
		if (!active) return;
		setNow(Date.now()); // 挂上先把当前值对齐，别拿上次卸载时的旧值算
		const id = window.setInterval(() => setNow(Date.now()), 1000);
		return () => window.clearInterval(id);
	}, [active]);
	return now;
}

function MessageViewInner({
	message,
	modelLabel,
	live,
	activeTool = null,
	retrying = null,
	workspaceRoot,
	onOpenFile,
	subagentRuns,
	onFork,
}: {
	message: UiMessage;
	modelLabel: string;
	live: boolean;
	/** 属于**这一条消息**的子代理运行记录（空/缺省 = 这一轮没派子代理） */
	subagentRuns?: readonly SubagentRunView[];
	/** 这一轮此刻在跑的工具（只在「当前会话 + 正在跑」的那条上给；用来画实时动作提示） */
	activeTool?: { name: string; argsSummary: string; startedAt: number } | null;
	/** 正在自动重试（快照的 `running.retrying`）：同样只给「当前会话 + 正在跑」的那条 */
	retrying?: { attempt: number; maxAttempts: number } | null;
	/** 当前会话的工作区（把工具参数里的绝对路径折成相对路径；没有就折不了） */
	workspaceRoot: string | null;
	onOpenFile?: (path: string, root: string | null) => void;
	/** 点消息里的文件路径（报告产物清单 / 行内代码）：在右侧预览它 */
	onOpenPath?: (path: string) => void;
	/** 「从这里创建分支」：给了才画那枚图标（引擎不支持 / 临时对话时不给） */
	onFork?: (messageId: string) => void;
}) {
	const t = useT();
	const text = textOfMessage(message);
	/** 金额显不显示跟着本机偏好（手机默认不显示，见 use-show-cost.ts） */
	const showCost = useShowCost();
	/** 这一轮工具写过的文件：贴在尾注上方，点一下在右侧面板打开（见 changed-files.ts） */
	const changed = message.role === "assistant" ? changedFilesIn(message, workspaceRoot) : [];
	/**
	 * 「过程」= 思考与工具调用，**按发生顺序**排（想 → 调工具 → 想 → 调工具…）。
	 * 整段默认折叠成一个按钮，展开后每一项仍然各管各的（思考单独展开、工具卡单独展开）。
	 */
	const processItems = message.blocks.filter(
		(block): block is Extract<typeof block, { kind: "thinking" }> | Extract<typeof block, { kind: "tool" }> =>
			block.kind === "thinking" || block.kind === "tool",
	);
	/** 这一轮子代理的用量（可能为空：这一轮没派子代理，或它们还没回报用量） */
	const subUsageRaw = subagentRuns ? subagentUsageOf(subagentRuns) : null;
	const subUsage = subUsageRaw && (subUsageRaw.total > 0 || subUsageRaw.cost > 0) ? subUsageRaw : null;
	const toolCount = processItems.filter((item) => item.kind === "tool").length;
	const thinkingCount = processItems.length - toolCount;
	/** 退路耗时：老历史没有开始/结束时间戳，只能把工具卡时长 + 思考累计加起来（会把空闲时间漏掉） */
	const toolDurationMs = processItems.reduce(
		(sum, item) => sum + (item.kind === "tool" && item.endedAt ? item.endedAt - item.startedAt : 0),
		0,
	);
	const summedDurationMs = toolDurationMs + (message.thinkingMs ?? 0);
	/**
	 * 耗时 = **墙上时钟**（ts → endedAt），不是各段相加：
	 *   - 跑着的时候拿 ts 到现在，每秒跳一次，看着像个秒表；
	 *   - 跑完换成 endedAt - ts，和刚才跳到的数字对得上；
	 *   - 拿不到时间戳（老历史）才回落到相加，总比不显示强。
	 */
	const ticking = live && message.endedAt === undefined;
	const now = useSecondTick(ticking);
	const startedAt = Number.isFinite(message.ts) ? message.ts : null;
	const wallClockMs = startedAt === null ? null : (message.endedAt ?? now) - startedAt;
	const useWallClock = wallClockMs !== null && (ticking || message.endedAt !== undefined);
	const durationMs = useWallClock ? Math.max(0, wallClockMs) : Math.max(0, summedDurationMs);
	/**
	 * 走秒时只给整秒：小数（1.4s / 2.4s）每秒大变一次，看着在抖；
	 * 但过了一分钟还按秒数显示会变成「耗时 95s」，所以 60s 以上交回 formatDuration，
	 * 先把毫秒削平到整秒（否则它会四舍五入，秒表会跳 1m5s → 1m6s 地抖）。
	 */
	const wholeSeconds = Math.floor(durationMs / 1000) * 1000;
	const durationLabel = !ticking
		? formatDuration(durationMs) // 跑完了：给精确值（1.7s / 1m11s）
		: durationMs < 60_000
			? `${wholeSeconds / 1000}s` // 走秒期：1s / 2s / 3s…
			: formatDuration(wholeSeconds); // 过了一分钟改回「1m23s」
	/**
	 * 过程容器（思考 + 工具卡）本身也是一层折叠。既然「默认展开思考块 / 工具卡」都开了，
	 * 还把它收着等于什么都没展开 —— 所以只要任一开关打开就默认展开；但**手动点过**的那条消息
	 * 以手动为准（否则用户点了「点击收起」，一次重渲染又会自己弹回来）。
	 */
	const [manualShowTools, setManualShowTools] = useState<boolean | null>(null);
	const [thinkingDefaultOpen] = useStoredBool(THINKING_OPEN_KEY, false);
	const [toolsDefaultOpen] = useStoredBool(TOOL_OPEN_KEY, false);
	const showTools = manualShowTools ?? (thinkingDefaultOpen || toolsDefaultOpen);
	/**
	 * 时间只有尾注左下这一处：消息一出现就显示（开始时间），跑完再更新成完成时间。
	 * 抬头不再放时间（打开历史时那串时分秒很吵）。
	 */
	const finishedAt = message.endedAt ?? null;
	/**
	 * 「插队」消息**默认收起**（ADR-0041）：它注入后撤不回来（已经交给引擎了），但会一直占着对话，
	 * 长会话里越堆越多 —— 所以先压成一行（标签 + 首行 + 时间），点一下看全文。
	 * localStorage 只记**手动展开过**的那几条（白名单），没记录的就是收起。
	 */
	const [steerCollapsed, setSteerCollapsed] = useState(() => !readExpanded(window.localStorage).has(message.id));
	const toggleSteerCollapsed = (): void => {
		const next = toggleExpanded(readExpanded(window.localStorage), message.id);
		writeExpanded(window.localStorage, next);
		setSteerCollapsed(!next.has(message.id));
	};

	// 收起态：只留一行（标签 + 首行 + 时间），点一下展开回完整气泡
	if (message.steer && steerCollapsed) {
		return (
			<article className="msg msg-user msg-steer msg-steer-collapsed" id={`msg-${message.id}`}>
				<button
					type="button"
					className="steer-collapsed-row"
					onClick={toggleSteerCollapsed}
					title={t("展开这条插队消息", "Expand this steered message")}
				>
					<span className="sent-tag sent-tag-steer">{t("已插队", "Steered")}</span>
					<span className="steer-collapsed-text">{firstLine(text)}</span>
					<span className="steer-collapsed-open" aria-hidden="true">
						▸
					</span>
					<FootStamp ts={message.ts} title={t("这条消息的时间", "When this message was sent")} />
				</button>
			</article>
		);
	}

	return (
		// 用户消息：操作/时间那一行放在气泡**里面**（换行分隔），不挂在气泡下面
		<article className={`msg msg-${message.role}${message.steer ? " msg-steer" : ""}`} id={`msg-${message.id}`}>
			{/* 助手抬头：模型 + 实时数字。
			    用户消息**不要抬头**（气泡里只有自己说的话），时间与操作放到气泡下面那行。 */}
			{message.role === "assistant" ? (
				<header className="msg-head">
					{message.role === "assistant" && modelLabel !== "" ? (
						<span className="msg-model" title={t("这条消息生成时用的模型", "The model that generated this message")}>
							{modelLabel}
						</span>
					) : null}
					{live ? <LiveOutput message={message} /> : null}
				</header>
			) : null}
			<div className="msg-bubble">
				{/* 「插队」消息的抬头：和待发条一个形状（我 + 标签 + 右侧 ↩/▾），只是它已经插进对话了。
				    ↩ = 移回输入框重发；▾/▸ = 收起 / 展开（ADR-0041，不可撤回，见 steer-collapsed.ts）。
				    这里**故意不用 ×**：× 在下面那些「还没发出去」的待发条上是"取消"的意思，
				    而这条早就交给这一轮了、撤不回 —— 同一个图标两处两种语义，只会让人以为能撤。 */}
				{message.steer ? (
					<header className="msg-head msg-steer-head">
						<span className="msg-role">{t("我", "Me")}</span>
						<span className="sent-tag sent-tag-steer">{t("已插队", "Steered")}</span>
						<span className="topbar-spacer" />
						<button
							type="button"
							className="msg-action"
							onClick={() => setDraft(text)}
							title={t("移回输入框，改完再发", "Move back to the input and send again")}
						>
							↩
						</button>
						<button
							type="button"
							className="msg-action msg-steer-fold"
							aria-expanded={!steerCollapsed}
							onClick={toggleSteerCollapsed}
							title={t(
								"收起这条插队消息（已交给这一轮，撤不回）",
								"Collapse this steered message (already handed to this turn, cannot be recalled)",
							)}
							aria-label={t("收起这条插队消息", "Collapse this steered message")}
						>
							▾
						</button>
					</header>
				) : null}
				<div className="msg-body">
					{processItems.length > 0 ? (
						<div className="msg-process">
							<button
								type="button"
								className="msg-tools-toggle"
								aria-expanded={showTools}
								onClick={() => setManualShowTools(!showTools)}
								title={t("思考与工具调用按发生顺序排列", "Thinking and tool calls in the order they happened")}
							>
								<span className={`msg-tools-caret${showTools ? " msg-tools-caret-open" : ""}`} aria-hidden="true" />
								{thinkingCount > 0 ? <span className="msg-process-meta">{thinkingCount} 段思考</span> : null}
								{toolCount > 0 ? <span className="msg-process-meta">{toolCount} 次工具</span> : null}
								{/* 提示语单独一个 span：手机上会被收掉（三角箭头本身就表示可展开），
								    留着它会把这条挤成两行 */}
								<span className="msg-process-label">
									{t("过程", "Process")} {processItems.length} {t("步", "steps")}
								</span>
								<span className="msg-process-hint">{showTools ? "（点击收起）" : "（点击展开）"}</span>
								{/* 耗时排最后：它是个「结果」，不是入口 —— 先给「做了什么/多少步」，最后才落时间。
								    跑着的时候它会每秒跳一次（秒表），跑完定格成总耗时。 */}
								{durationMs > 0 ? (
									<span
										className="msg-process-meta msg-process-time"
										title={ticking ? "这一轮从开始到现在的墙上时间（每秒刷新）" : "这一轮的总耗时"}
									>
										耗时 {durationLabel}
									</span>
								) : null}
								{/* 手机上顶替「（点击展开）」的箭头，放在**整条最后**：手风琴的惯例位置，
								    一个字都不占，还能看出「能点、点开会转」 */}
								<span
									className={`msg-process-chevron${showTools ? " msg-process-chevron-open" : ""}`}
									aria-hidden="true"
								/>
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
					{/* 子代理卡片：落在「过程（思考 / 工具）」之后、正文（最终回答）之前。
					     子代理是这一轮的过程产物 —— 它属于这段过程，不属于「对话下面」。
					     后一轮再派子代理时，这里会长出**新的一块**：分配按「开始时间落在哪条助手消息」
					     做，所以上一轮的卡片留在它原来的位置上，不会被复用 / 顶掉。 */}
					{subagentRuns && subagentRuns.length > 0 ? <AgentsRunStrip runs={subagentRuns} /> : null}
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
					{/* 「正在运行 bash…」/「正在等待模型…」：在折扇体外面，收起也看得见（见 LiveActivity） */}
					{live ? <LiveActivity message={message} tool={activeTool} retrying={retrying} /> : null}
				</div>
				{/* 「插队」小标已经移到气泡内的抬头里（见上方 msg-steer-head），这里不再重复 */}
			</div>
			{message.role === "user" ? (
				// 气泡下面那一行：默认只露时间；复制/编辑鼠标悬浮在气泡上才出现（靠右、排在时间前面）
				<footer className="msg-user-foot">
					<CopyButton text={text} title={t("复制这条消息", "Copy this message")} />
					{/* 插队消息的「移回输入框」在气泡抬头里（和待发条一致），这里不再重复一个 */}
					{message.steer ? null : (
						<button
							type="button"
							className="msg-action"
							onClick={() => setDraft(text)}
							title={t("把这条消息放回输入框，改完再发", "Put this message back in the input, edit and send again")}
						>
							↳ {t("从此处编辑", "Edit from here")}
						</button>
					)}
					<FootStamp ts={message.ts} title={t("这条消息的时间", "When this message was sent")} />
				</footer>
			) : null}
			{message.role === "assistant" ? (
				<ChangedFiles
					files={changed}
					onOpen={onOpenFile ? (file) => onOpenFile(file.path, workspaceRoot) : undefined}
				/>
			) : null}
			{message.role === "assistant" ? (
				<footer className="msg-foot">
					{/* 用量（上传/下载 + 缓存 + 花费）**一直显示**：每调完一次模型就多一份，
					 * 跑的过程中就能看到这一轮已经花掉多少（以前跟复制一起藏到结束，中途一片空白）。
					 * 数字是累加的，跑着的时候一直在涨。 */}
					{live && !message.usage ? (
						// 第一次模型调用还没结束：引擎那时才回报真实用量 —— 先给句话，别让人以为这里坏了
						<span
							className="msg-usage msg-usage-waiting"
							title={t(
								"引擎在每次模型调用结束时回报真实用量，第一次调用还没结束",
								"The engine reports real usage at the end of each model call; the first call has not finished yet",
							)}
						>
							用量统计中…
						</span>
					) : null}
					{message.usage ? (
						<span className="msg-usage mono">
							{usageItemsOf(message.usage).map((item) => (
								<span className="msg-usage-item" key={item.key} title={item.title}>
									{item.tag ? <span className="msg-usage-tag">{item.tag}</span> : null}
									{item.text}
								</span>
							))}
						</span>
					) : null}
					{/* 子代理的用量：**不在上面那行里**。
					     引擎只回报主会话的 usage，子代理是独立会话、独立计费；两块数字天然是两本账。
					     不单独列出来的话，用户按这行估成本会严重低估（子代理常常比主对话还贵）。 */}
					{subUsage ? (
						<span
							className="msg-usage msg-usage-sub mono"
							title={t(
								`子代理 ${subUsage.count} 个（独立计费，不含左边的 in/out/cache）：输入 ${withThousands(subUsage.input)}、输出 ${withThousands(subUsage.output)} tokens，花费 ${formatCost(subUsage.cost)}。` +
									`这一轮合计 ${formatCost((message.usage?.cost ?? 0) + subUsage.cost)}`,
								`${subUsage.count} subagent(s), billed separately (not in the in/out/cache at left): input ${withThousands(subUsage.input)}, output ${withThousands(subUsage.output)} tokens, ${formatCost(subUsage.cost)}. Turn total ${formatCost((message.usage?.cost ?? 0) + subUsage.cost)}`,
							)}
						>
							<span className="msg-usage-tag">🤖 {subUsage.count}</span>
							<span className="msg-usage-item">
								{subUsage.input > 0 ? `in ${compactTokens(subUsage.input)}` : ""}
								{subUsage.input > 0 && subUsage.output > 0 ? " " : ""}
								{subUsage.output > 0 ? `out ${compactTokens(subUsage.output)}` : ""}
							</span>
							{showCost && subUsage.cost > 0 ? (
								<span className="msg-usage-item msg-usage-cost">{formatCost(subUsage.cost)}</span>
							) : null}
						</span>
					) : null}
					{/* 复制只等跑完：复制一个还在长的东西没意义（用户反馈也是这么说的） */}
					{live ? null : (
						<CopyButton text={text} className="msg-foot-copy" title={t("复制这条回复", "Copy this reply")} />
					)}
					{/* 从这里创建分支（= pi 的 /fork）：在这条回复处另开一条会话接着聊，原对话不动。
					 * 也只在跑完之后给：跑到一半去 fork，拿到的是半截历史。 */}
					{live || !onFork ? null : (
						<button
							type="button"
							className="msg-foot-copy msg-foot-fork"
							onClick={() => onFork(message.id)}
							title={t("从这里创建分支（原对话保持不变）", "Branch from here (original chat stays unchanged)")}
							aria-label={t("从这里创建分支", "Branch from here")}
						>
							<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
								<path d="M4.4 3.6v6.2a2.4 2.4 0 0 0 2.4 2.4h2.4" strokeLinecap="round" />
								<circle cx="4.4" cy="2.6" r="1.5" />
								<circle cx="4.4" cy="13.4" r="1.5" />
								<circle cx="12.2" cy="12.2" r="1.5" />
							</svg>
						</button>
					)}
					<span className="topbar-spacer" />
					{/* 时间：**一开始就显示**（先给开始时间），跑完再换成完成时间 —— 不再等结束才出现 */}
					<FootStamp
						ts={finishedAt ?? message.ts}
						title={finishedAt !== null ? "这条回复完成的时间" : "这条回复开始的时间"}
					/>
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

/**
 * 尾注那一行的一项：`[in]18K`（词标 + 缩写数字），悬浮看全称与精确值。
 *
 * 用**英文词标**而不是中文标签：四个中文词（输入 / 输出 / 缓存读 / 缓存写）
 * 把尾注拉得很长（手机上直接换行），英文词只有 2–6 个字符，一眼认得又不占宽；
 * 准数（千位分隔）和中文全称放在 title 里，悬浮一下就有。
 * 早先这里用的是单字母 I / O / C / W，但字母谁是谁全靠猜 —— 换成词之后不用记忆。
 */
type UsageItem = { key: string; tag?: string; text: string; title: string };

function usageItemsOf(usage: NonNullable<UiMessage["usage"]>): UsageItem[] {
	const items: UsageItem[] = [
		{
			key: "in",
			tag: "in",
			text: compactTokens(usage.input),
			title: `输入 ${withThousands(usage.input)} tokens（这一轮发给模型的）`,
		},
		{
			key: "out",
			tag: "out",
			text: compactTokens(usage.output),
			title: `输出 ${withThousands(usage.output)} tokens（模型写回来的）`,
		},
	];
	if (usage.cacheRead > 0) {
		items.push({
			key: "cacheRead",
			tag: "cache",
			text: compactTokens(usage.cacheRead),
			title: `缓存读 ${withThousands(usage.cacheRead)} tokens（命中提示词缓存，按折扣计价）`,
		});
	}
	if (usage.cacheWrite > 0) {
		items.push({
			key: "cacheWrite",
			tag: "cacheW",
			text: compactTokens(usage.cacheWrite),
			title: `缓存写 ${withThousands(usage.cacheWrite)} tokens（把前缀写进缓存，下次能命中）`,
		});
	}
	// 花费自带 $ 符号，不再加徽标；pi 拿不到价格时就不出现（不编 0）
	if (usage.cost)
		items.push({ key: "cost", text: formatCost(usage.cost), title: "这一轮的花费（pi 按 provider 配置的价格估算）" });
	return items;
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
	workspaceRoot = null,
	onOpenFile,
	onOpenPath,
	running = false,
	activeTool = null,
	retrying = null,
	pending = [],
	onRecallPending,
	onCancelPending,
	actions = [],
	subagentRuns = [],
	onFork,
	onAddSelectionToSession,
	onAskSelectionInSideChat,
	annotations,
	onFocusAnnotation,
}: {
	messages: UiMessage[];
	hasMoreBefore: boolean;
	/** 当前会话的全部子代理运行记录（跨轮次累积）：这里按时间分配给各自那条助手消息 */
	subagentRuns?: readonly SubagentRunView[];
	/** 模型 id → 显示名（取自快照的模型表，和底部选择器同一份数据） */
	modelLabels?: Record<string, string>;
	/** 当前工作区：把「改动过的文件」里的绝对路径折成相对路径 */
	workspaceRoot?: string | null;
	/** 点改动过的文件：在右侧面板按文件管理的方式打开它 */
	onOpenFile?: (path: string, root: string | null) => void;
	/** 点消息里的文件路径（报告产物清单 / 行内代码）：在右侧预览它 */
	onOpenPath?: (path: string) => void;
	/** 当前会话这一轮是否在跑：只有它才会给最后一条助手消息挂实时数字 */
	running?: boolean;
	/** 这一轮正在跑的工具（快照的 `running.activeTool`）：画「正在运行 bash…」用 */
	activeTool?: { name: string; argsSummary: string; startedAt: number } | null;
	/** 这一轮正在自动重试（快照的 `running.retrying`）：把「正在等待模型…」换成「正在重试…」 */
	retrying?: { attempt: number; maxAttempts: number } | null;
	/** 「插队 / 排队」中、还没真正发出的消息 */
	pending?: QueuedView[];
	onRecallPending?: (id: string) => void;
	onCancelPending?: (id: string) => void;
	/** 模型给出的「下一步建议」（ADR-0022）：挂在消息流最末尾，和消息一起滚 */
	actions?: ActionItem[];
	/** 「从这里创建分支」：给了才给助手消息尾注画那枚图标 */
	onFork?: (messageId: string) => void;
	/** 选中文字后点「添加到会话」：把它交给上层收进这条会话（引用 + 编号，见 annotations.ts） */
	onAddSelectionToSession?: (input: SelectionAddInput) => void;
	/** 把选中的一段文字带去右侧临时聊天里问 */
	onAskSelectionInSideChat?: (text: string) => void;
	/** 当前会话的标注（正文里的编号 + 底色也跟着它画）；不传或空 = 没有标注这一层 */
	annotations?: readonly Annotation[];
	/** 点正文里的编号：让人看到「这条标注说了什么」（上层负责滚到列表那一条） */
	onFocusAnnotation?: (id: string) => void;
}) {
	const t = useT();
	/** 消息区自己（`.messages`）：选区工具栏只认这棵子树里的选中 */
	const listRef = useRef<HTMLDivElement | null>(null);
	/** 设置 → 对话 → 「标注」：关掉之后选字不再浮那颗工具栏（已标好的照样画，见 `AnnotationMarks`） */
	const [selectionToolbarOn] = useStoredBool(SELECTION_TOOLBAR_KEY, true);
	// 抬头的模型名只算一次（以前是每条消息各自从 store 里拿）
	/** 一条消息抬头显示什么模型：**用它自己生成时的模型**（历史不会跟当前选择变） */
	const labelOf = (model: string | undefined): string => {
		if (!model) return "";
		const mapped = modelLabels?.[model];
		if (mapped) return mapped;
		// 模型表里没有（旧记录 / 已删除的 provider）：退化成去掉 provider 前缀的 id
		return model.split("/").slice(1).join("/") || model;
	};
	// 记一份「最近看到的正文」：`/copy` 这条斜杠命令够不着组件树，从 store 里取
	rememberMessages(messages);
	// Markdown 深在组件树里，拿不到 prop：把「点路径 → 预览」注册成模块级回调
	setPathOpener(onOpenPath ?? null);
	// 空会话（新会话）什么都不画：标题/引导在输入框上方那块（NewChatMeta），这里留白
	if (messages.length === 0) return null;
	/**
	 * 插队消息先挪位再画：服务端只能把插队那句话追加到这一轮末尾，
	 * 而它其实是插在中间的（后面那段助手正文说不定就是在回答它）——
	 * 不挪的话看着像先答后问，气泡上却还挂着「插队」（见 `steer-order.ts`）。
	 * 只改显示顺序，消息本身一个字不动。
	 */
	const shown = liftSteeredMessages(messages);
	// 实时数字挂在哪条消息上：最后一条**还没跑完**的助手消息（跑完 endedAt 才有值）
	const liveId = running ? (lastOpenAssistant(shown)?.id ?? null) : null;
	// 子代理卡片挂在哪条消息上：按「开始时间落在哪条助手消息」分配（见 assignRunsToMessages）
	const runsByMessage = assignRunsToMessages(subagentRuns, shown);

	return (
		<div className="messages" ref={listRef}>
			{hasMoreBefore ? (
				<div className="more-before">
					{t("更早的消息未在本页（分页在 M6）", "Earlier messages are not on this page")}
				</div>
			) : null}
			{shown.map((message) => (
				<MessageView
					key={message.id}
					message={message}
					modelLabel={labelOf(message.model)}
					live={message.id === liveId}
					// 只给 live 那条：memo 才能继续跳过其他消息的重渲染
					activeTool={message.id === liveId ? activeTool : null}
					retrying={message.id === liveId ? retrying : null}
					workspaceRoot={workspaceRoot}
					onOpenFile={onOpenFile}
					subagentRuns={runsByMessage.get(message.id)}
					onFork={onFork}
				/>
			))}
			{/* 建议操作紧跟在最后一条消息之后（ADR-0022）：它是「针对这一轮」的下一步 */}
			{pending.length > 0 ? (
				<div className="pending-sends">
					{pending.map((item) => (
						// 排队 / 插队共用一种待发行：形状、两个按钮完全一样，只差标签与色调
						<article className={`msg msg-user pending-item pending-${item.mode}`} key={item.id}>
							<header className="msg-head">
								<span className="msg-role">{t("我", "Me")}</span>
								<span className={`sent-tag sent-tag-${item.mode}`}>
									{item.mode === "steer" ? t("插队", "Steer") : t("排队", "Queue")}
								</span>
								<span className="topbar-spacer" />
								<button
									type="button"
									className="msg-action"
									title={t("移回输入框", "Move back to the input")}
									onClick={() => onRecallPending?.(item.id)}
								>
									↩
								</button>
								<button
									type="button"
									className="msg-action"
									title={
										item.mode === "steer"
											? t("取消插队（还没插进去，取消了就不会插进去）", "Cancel the steer (not inserted yet)")
											: t("取消这条", "Cancel this one")
									}
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
			{/* 下一步建议（ADR-0022）：它是「这一轮之后往哪走」，属于对话流的一部分 ——
			 * 所以放在最后一条消息（连同它的用量尾注）下面，跟正文一起滚，而不是钉在输入区上方。 */}
			<ActionSuggestions actions={actions} running={running} />
			{/*
			 * 选中一段文字后浮出来的几个动作（见 SelectionToolbar）：
			 * 「添加到会话」/「在临时聊天中提问」（自己说的话再添回去没意义，那个分支由组件自己判断）。
			 * 整颗浮层受设置 → 对话 →「标注」控制（`SELECTION_TOOLBAR_KEY`）：关掉就只是选字。
			 */}
			{onAskSelectionInSideChat && selectionToolbarOn ? (
				<SelectionToolbar
					container={listRef}
					onAddToSession={onAddSelectionToSession}
					onAskInSideChat={onAskSelectionInSideChat}
				/>
			) : null}
			{/* 标注层：正文底色 + 编号徽标。空列表时组件自己不画（见 AnnotationMarks） */}
			{annotations && annotations.length > 0 ? (
				<AnnotationMarks container={listRef} annotations={annotations} onFocus={onFocusAnnotation} />
			) : null}
		</div>
	);
}
