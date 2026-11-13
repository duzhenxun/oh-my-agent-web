import { Fragment, memo, useEffect, useMemo, useRef, useState } from "react";
import { compactTokens } from "../session-metrics.ts";
import { formatRate, useLiveStats } from "../stream-speed.ts";
import { setDraft } from "../store.ts";
import { formatDuration, formatElapsedSeconds } from "../lib/duration-label.ts";
import {
	PROCESS_AUTO_COLLAPSE_KEY,
	PROCESS_AUTO_FOLD_RUNNING_KEY,
	SELECTION_TOOLBAR_KEY,
	THINKING_OPEN_KEY,
	TOOL_OPEN_KEY,
} from "../ui-prefs.ts";
import { useStoredBool } from "../use-stored-bool.ts";
import { useSkillNames } from "../skill-names.ts";
import {
	foldLayout,
	hidesNarration,
	isNarrationText,
	isTurnRunning,
	processView,
	shouldForgetManual,
} from "../process-fold.ts";
import type { ActionItem, SubagentRunView, UiMessage } from "../types.ts";
import type { QueuedView } from "../pending-sends.ts";
import { firstLine, readExpanded, toggleExpanded, writeExpanded } from "../steer-collapsed.ts";
import { liftSteeredMessages } from "../steer-order.ts";
import { changedFilesIn } from "../changed-files.ts";
import { ActionSuggestions } from "./ActionSuggestions.tsx";
import { ChangedFiles } from "./ChangedFiles.tsx";
import { CopyButton } from "./CopyButton.tsx";
import { Markdown } from "./Markdown.tsx";
import { urlTokens } from "../url-tokens.ts";
import { SelectionToolbar, type SelectionAddInput } from "./SelectionToolbar.tsx";
import { AnnotationMarks } from "./AnnotationMarks.tsx";
import type { Annotation } from "../annotations.ts";
import { ToolCard } from "./ToolCard.tsx";
import { AgentsRunStrip } from "./AgentsRunStrip.tsx";
import { assignRunsToMessages, isActive, subagentUsageOf } from "../subagent-view.tsx";

/** 消息里的纯文本（复制 / 从此处编辑都用它） */

/** 过程里的一项（思考或工具调用） */
type ProcessItem = Extract<UiMessage["blocks"][number], { kind: "thinking" } | { kind: "tool" }>;
type ToolItem = Extract<ProcessItem, { kind: "tool" }>;
type ErrorItem = Extract<UiMessage["blocks"][number], { kind: "error" }>;

/**
 * 过程里的一小块：**一段思考 + 它后面跟着的那些工具调用**。
 *
 * 为什么要分块：过程一长（五六个思考、十几次工具），扁平地排下来分不清
 * 「哪几次工具是这次想完之后干的」。分块后每段思考前面有编号，读起来是
 * 「想 ① → 试一下 → 再想 ② → 再试」的节奏。
 */
type ProcessGroupView = {
	key: string;
	thinking: { text: string } | null;
	tools: ToolItem[];
};

/**
 * 一轮回复的一个渲染单元：连续的过程、一段正文、或一个错误块。
 *
 * 「连续」是关键：中间只要插了一段正文，过程就在那里断开 —— 那正是模型
 * 「说一句 → 调工具 → 再说一句」的时间线，不能把它们再缝到一起去。
 */
type TurnSegment =
	| { kind: "process"; groups: ProcessGroupView[] }
	| { kind: "text"; text: string; index: number }
	| { kind: "error"; block: ErrorItem; index: number };

/**
 * 把这一轮的 blocks 切成**按发生顺序**排的渲染单元（用户 2026-10-30：照 codex 那样显示）。
 *
 * 以前是「所有思考/工具收进一个折叠容器、整体提到正文上方」—— 于是「说一句 → 调工具 → 再说一句」
 * 的顺序全丢了：十几次工具挤在最上面，中间那几段说明被甩到最下面，读起来像两件事。
 * 现在过程只在**它发生的位置**成段：`groups` 里仍是「一段思考 + 它后面的工具」，
 * 正文留在原位 —— 流式期间看到的就是一条时间线。
 *
 * 分块规则：
 *   - 碰到 thinking 就开新块（后续工具都归它）；
 *   - 第一个 thinking 之前就有工具（少见，但不是不可能）→ 单独成一块，`thinking` 为 null。
 *
 * 顺带数出两个计数：思考段数 / 工具调用次数 —— 折叠行要报给人看。
 */
function buildTurnSegments(blocks: UiMessage["blocks"]): {
	segments: TurnSegment[];
	thinkingCount: number;
	toolCount: number;
} {
	const segments: TurnSegment[] = [];
	let current: Extract<TurnSegment, { kind: "process" }> | null = null;
	let thinkingCount = 0;
	let toolCount = 0;
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		if (!block) continue;
		if (block.kind === "thinking" || block.kind === "tool") {
			if (!current) {
				current = { kind: "process", groups: [] };
				segments.push(current);
			}
			if (block.kind === "thinking") {
				thinkingCount += 1;
				current.groups.push({ key: `think-${index}`, thinking: { text: block.text }, tools: [] });
				continue;
			}
			toolCount += 1;
			const lastGroup = current.groups[current.groups.length - 1];
			if (lastGroup) lastGroup.tools.push(block);
			else current.groups.push({ key: `lead-${index}`, thinking: null, tools: [block] });
			continue;
		}
		// 正文 / 错误块：过程在这里断开
		current = null;
		if (block.kind === "text") {
			segments.push({ kind: "text", text: block.text, index });
			continue;
		}
		segments.push({ kind: "error", block, index });
	}
	return { segments, thinkingCount, toolCount };
}

/** 用户消息里的图片引用：Composer 发送时追加在正文末尾的 `![名](/api/uploads/<id>)` */
const USER_IMAGE_REF = /!\[([^\]]*)\]\((\/api\/uploads\/[a-z0-9-]{8,64})\)/g;

/**
 * 用户消息：正文按原文纯文字显示（不走 markdown，避免贴进来的 HTML 被吞掉）；
 * 图片引用从正文里拎出来，画成缩略图，点开用图片查看器放大。
 * 以前整段当文字，`![名](/api/uploads/…)` 就原样露出来，图本身不见了。
 */
function UserMessageText({ text }: { text: string }) {
	const t = useT();
	const images: { src: string; alt: string }[] = [];
	const body = text
		.replace(USER_IMAGE_REF, (_match, alt: string, src: string) => {
			images.push({ src, alt });
			return "";
		})
		.trim();
	return (
		<>
			{body !== "" ? (
				<div className="msg-user-text">
					<UserTextWithLinks text={body} />
				</div>
			) : null}
			{images.length > 0 ? (
				<div className="msg-user-images">
					{images.map((image, index) => (
						<button
							key={`${image.src}-${index}`}
							type="button"
							className="msg-user-img-btn"
							title={image.alt || t("查看图片", "View image")}
							onClick={() => openImageViewer(image.src, image.alt)}
						>
							<img className="msg-user-img" src={image.src} alt={image.alt} loading="lazy" />
						</button>
					))}
				</div>
			) : null}
		</>
	);
}

/**
 * 用户消息里的网址：气泡仍按原文显示，但 http(s) 地址要能点开 —— **新标签页**（用户 2026-11-10：
 * 「这种 http/https 的连接要在新标签中打开，这属于网址」）。这里不整段上 markdown，
 * 只把网址那几段换成 `<a>`：贴进来的 HTML 依旧原样当文字（见上面那段的理由）。
 * 没有网址时原样返回字符串，别给每句话都套一层 Fragment。
 */
function UserTextWithLinks({ text }: { text: string }) {
	const parts = urlTokens(text);
	if (parts.every((part) => part.url === undefined)) return <>{text}</>;
	return (
		<>
			{parts.map((part, index) =>
				part.url ? (
					<a
						key={index}
						className="msg-user-link"
						href={part.url}
						target="_blank"
						rel="noopener noreferrer"
						title={tNow("在新标签页打开", "Open in a new tab")}
					>
						{part.text}
					</a>
				) : (
					<Fragment key={index}>{part.text}</Fragment>
				),
			)}
		</>
	);
}

/** 千分位：5865 → 5,865 */
function withThousands(value: number): string {
	return value.toLocaleString("en-US");
}

/**
 * 绝对时间：中文 `10月20日 00:05:33`、英文 `Oct 20 00:05:33`；
 * `withDate: false` 时只留时间（窄屏那份备用写法）。
 */
function stampOf(ts: number, withDate: boolean, english: boolean): string {
	const date = new Date(ts);
	const pad = (value: number) => String(value).padStart(2, "0");
	const time = `${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`;
	if (!withDate) return time;
	const day =
		english === true
			? `${date.toLocaleDateString("en-US", { month: "short" })} ${date.getDate()}`
			: `${date.getMonth() + 1}月${date.getDate()}日`;
	return `${day} ${time}`;
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
	const { language } = useLanguage();
	const english = language === "en";
	return (
		<span className="msg-foot-stamp" title={title}>
			<span className="msg-foot-stamp-full">{stampOf(ts, true, english)}</span>
			<span className="msg-foot-stamp-short">{stampOf(ts, false, english)}</span>
		</span>
	);
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
function ThinkingSegment({ text }: { text: string }) {
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
	// 预览同样交给 CSS 省略号：这里只留一个宽松上限，别在还有宽度时提前断（用户 2026-11-02）
	const preview = joined.replace(/\s+/g, " ").trim().slice(0, 240);
	return (
		<div className="thinking-block">
			<button type="button" className="thinking-head" onClick={() => setManualOpen(!open)}>
				{/* 这里原本有三个东西：编号圆片（①②…）、💡、以及「思考」两个字。
				     编号先撤（用户 2026-10-30：「这种数字不要了」）—— 它只在「要指代第几段」时有用，
				     而一轮动辄十几段，读起来只是每行前面多一个蓝点；顺序本来就由上下位置表达。
				     💡 也撤了：彩色 emoji 在一行灰字里是全场最亮的元素，比正文还抢眼。 */}
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

import { describeTool, skillOf, ToolKindIcon } from "./tool-activity.tsx";
import { tNow, useLanguage, useT } from "../use-language.ts";
import { textOfMessage } from "../message-text.ts";
import { rememberMessages } from "../store.ts";
import { setPathOpener } from "../path-tokens.ts";
import { openImageViewer } from "../image-viewer.ts";

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

/**
 * 「这一刻在干什么」—— 贴在消息末尾的那一行状态位。
 *
 * 以前这一行是「三颗跳动的点 + 正在运行 + bash + 参数」，而上面还铺着思考行和工具卡；
 * codex 那边跑的时候就是**一行**：图标告诉你这是在调 skill、读文件、列目录还是跑命令，
 * 文字人话（「正在读取 Weather Forecast 技能」），换动作时**就地替换**。
 * 现在过程在跑的时候是铺开的（用户 2026-11-02），这一行不再代替时间线，只补它说不清的三件事：
 * 正在重试、卡住了、以及「模型还在想/还没开口」（这时没有工具卡可看）。
 *
 * 这一行永远贴在消息末尾、折扇体外面：
 *   - 有工具在跑 → 图标 + 「正在运行 <命令>」/「正在读取 x.py」…（说法见 tool-activity.tsx）
 *   - 模型在想事 / 还没开口 → 星形图标 +「正在思考」（不再区分「等待模型」）
 *   - 正文正在流式吐字 → 不画（正文本身在动，再加一行只会让人以为卡住了）
 */
function LiveActivity({
	message,
	tool,
	retrying,
}: {
	message: UiMessage;
	/** 正在跑的工具（来自快照 `running.activeTool`；带 `argsFull`，弹层里能看完整命令） */
	tool: { name: string; argsSummary: string; argsFull?: string; startedAt: number } | null;
	/** 传输层被打断、引擎正在自动重试（来自快照 `running.retrying`） */
	retrying?: { attempt: number; maxAttempts: number } | null;
}) {
	const t = useT();
	const tail = message.blocks.at(-1);
	const tailText = tail?.kind === "text" ? tail.text.trim() : "";
	const stalled = useStalled(tailText !== "", tailText.length);
	const now = useSecondTick(tool !== null);

	const retryLabel = retrying
		? t(
				`模型调用被打断，正在自动重试（${retrying.attempt}/${retrying.maxAttempts}）`,
				`Model call interrupted, retrying automatically (${retrying.attempt}/${retrying.maxAttempts})`,
			)
		: null;
	/** 工具名 + 参数 → 图标 + 一句人话（正在读取 X 技能 / 正在运行 <命令>…，见 tool-activity.tsx） */
	const info = tool ? describeTool(tool.name, tool.argsSummary, tool.argsFull) : null;
	const seconds = tool ? Math.max(0, Math.floor((now - tool.startedAt) / 1000)) : 0;
	/**
	 * 点开看全文（用户 2026-10-30：「需要有个可以点开，我想点开看的时候，可以点开看一眼
	 * 到底在干嘛」）。行尾那截只够扫一眼，`node -e '…'` 这种压完还是半截 ——
	 * 所以整行变成按钮，点开弹层里给完整命令 / 脚本正文。
	 */
	const [open, setOpen] = useState(false);
	const wrapRef = useRef<HTMLDivElement | null>(null);
	useEffect(() => {
		if (!open) return;
		// 点别处 / 按 Esc 就收起来（跟仓库里其它弹层一致：不靠「再点一次」才关得掉）
		const onPointerDown = (event: MouseEvent) => {
			if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("mousedown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("mousedown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	/**
	 * 弹层向上弹（锚在行底边），所以**能有多高取决于这行上面还剩多少空间**：
	 * 行贴着屏幕底部时，固定高度会把顶部（标题 + 复制按钮）顶出视口 —— 手机上实测 y=-57px。
	 * 高度按 `行顶 - 10px` 算，窗口尺寸变了再量一次。
	 */
	const [popMaxHeight, setPopMaxHeight] = useState<number | null>(null);
	useEffect(() => {
		if (!open) {
			setPopMaxHeight(null);
			return;
		}
		const fit = () => {
			const rect = wrapRef.current?.getBoundingClientRect();
			if (rect) setPopMaxHeight(Math.max(180, Math.floor(rect.top - 10)));
		};
		fit();
		window.addEventListener("resize", fit);
		return () => window.removeEventListener("resize", fit);
	}, [open]);

	// 正文还在长 → 让它自己说话。但「正在重试」期间正文本来就是停的，必须盖过这条规则。
	// 这句只能放在**所有 hook 之后**：否则有正文 / 没正文会改变 hook 数量（React 直接报错）
	if (tailText !== "" && !tool && !stalled && !retrying) return null;

	/** 弹层里那坨：完整命令 / 脚本正文（没东西可看就不让点） */
	const full = info?.full ?? null;
	const openable = full !== null && full.trim() !== "";
	return (
		<div className="msg-activity-wrap" ref={wrapRef}>
			<button
				type="button"
				className="msg-activity"
				aria-expanded={openable ? open : undefined}
				aria-label={openable ? t("展开看完整命令", "Show the full command") : undefined}
				{...(openable ? {} : { tabIndex: -1 })}
				onClick={() => {
					if (openable) setOpen((value) => !value);
				}}
			>
				{/* 图标就是这一行最先传达的东西：书 = 读技能，文件 = 读文件，文件夹 = 列目录，
				 * 终端 = 跑命令，地球 = 联网，放大镜 = 检索，铅笔 = 改文件，机器人 = 子代理，
				 * 星 = 没在调工具（在想 / 重试）。所以不再另加「正在运行 bash」这种工具名黑话 */}
				<ToolKindIcon kind={info ? info.kind : "thinking"} className="msg-activity-icon" />
				<span className="msg-activity-label" aria-live="polite">
					{/* 没在调工具 = 模型还在想：不再区分「等待模型」和「正在思考」——
					     对用户就是同一件事（模型还没回话），两个说法只会让人以为卡住了（用户 2026-11-02）。 */}
					{info ? info.now : (retryLabel ?? t("正在思考", "Thinking"))}
				</span>
				{info?.detail ? <span className="msg-activity-args mono">{info.detail}</span> : null}
				{seconds >= 2 ? (
					<span
						className="msg-activity-time mono"
						title={t("这个工具已经跑了多久", "How long this tool has been running")}
					>
						{formatElapsedSeconds(seconds)}
					</span>
				) : null}
			</button>
			{open && openable ? (
				<div
					className="msg-activity-pop"
					role="dialog"
					aria-label={info?.now ?? ""}
					style={popMaxHeight === null ? undefined : { maxHeight: `${popMaxHeight}px` }}
				>
					<div className="msg-activity-pop-head">
						<ToolKindIcon kind={info?.kind ?? "thinking"} className="msg-activity-pop-icon" />
						<span className="msg-activity-pop-title">{info?.now}</span>
						{tool ? (
							<span className="msg-activity-pop-meta mono">
								{seconds >= 1 ? formatElapsedSeconds(seconds) : ""}
								<span className="msg-activity-pop-tool">{tool.name}</span>
							</span>
						) : null}
					</div>
					<div className="msg-activity-pop-foot">
						{/* 复制整条命令：弹层里要能一眼看全，也要能直接拿走（用户 2026-11-02） */}
						<CopyButton
							text={full}
							className="msg-action msg-activity-pop-copy"
							title={t("复制这条完整命令", "Copy this full command")}
						/>
					</div>
					<pre className="msg-activity-pop-body mono">{full}</pre>
				</div>
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
	activeTool?: { name: string; argsSummary: string; argsFull?: string; startedAt: number } | null;
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
	/**
	 * 技能真名（`new-skill-3` → `Weather Forecast`）是异步拉的：
	 * 这里挂一次订阅，名字表到了就重渲染 → 底下那些工具行 / 折叠行里的技能名跟着改口。
	 */
	useSkillNames();
	const text = textOfMessage(message);
	/** 金额一律显示（主会话尾注的 $ 也从来不看开关，两边只能一致） */
	/** 这一轮工具写过的文件：贴在尾注上方，点一下在右侧面板打开（见 changed-files.ts） */
	const changed = message.role === "assistant" ? changedFilesIn(message, workspaceRoot) : [];
	/**
	 * 「过程」= 思考与工具调用，**按发生顺序**排（想 → 调工具 → 想 → 调工具…）。
	 * 整段默认折叠成一个按钮，展开后每一项仍然各管各的（思考单独展开、工具卡单独展开）。
	 */
	const { segments, thinkingCount, toolCount } = buildTurnSegments(message.blocks);
	/**
	 * 折叠**收到哪里**：最后一个结论之前的一切 —— 思考、工具卡、**以及中间那几段说明文字**。
	 *
	 * 这条路走过三次（判断全在 `foldLayout` 里）：
	 *   - 2026-10-30：只收思考与工具，说明文字留在外面（当时的理由是「A 不行改用 B」是可信度来源）；
	 *   - 2026-11-02：改回来了 —— 跑完屏幕上剩下「我先看一下…」「版本并不一致，我再确认…」
	 *     这类过程话，最后的结论反而被麦在中间（用户给了截图）。现在**跑的时候照样铺着看，
	 *     跑完只留最后的结果**，说明文字跟过程一起进折叠，点开就能看回完整时间线；
	 *   - 2026-11-03：没结论的回合（插队 / 打断截在工具调用上）也整条收掉 —— 之前这些回合
	 *     在历史里永远摊开，用户勾了「跑完自动折叠」也看不到效果。
	 *
	 * 两个落点：
	 *   - `firstProcessAt` = 折叠按钮的落点：第一次动手的地方（按钮长在「过程」发生的位置）；
	 *   - `lastAnswerAt` = 收到哪里为止：它之前的全部都能藏进折叠。
	 */
	const { firstProcessAt, lastAnswerAt, lastProcessAt, hasAnswer, insideFold } = foldLayout(segments);
	const hasProcess = firstProcessAt >= 0;
	/**
	 * 这一轮加载过的技能（去重、保留先后）。
	 * 用户 2026-10-30：「你要调用什么 skill 时要说出来，我要看到」——
	 * 折叠行里只报「2 次工具」等于把这件事又藏起来了，所以技能名直接摆在折叠行上。
	 */
	const skillsUsed = Array.from(
		new Set(
			message.blocks
				.map((block) => (block.kind === "tool" ? skillOf(block.name, block.argsSummary) : null))
				.filter((skill): skill is string => skill !== null),
		),
	);
	/** 这一轮子代理的用量（可能为空：这一轮没派子代理，或它们还没回报用量） */
	const subUsageRaw = subagentRuns ? subagentUsageOf(subagentRuns) : null;
	const subUsage = subUsageRaw && (subUsageRaw.total > 0 || subUsageRaw.cost > 0) ? subUsageRaw : null;
	/** 退路耗时：老历史没有开始/结束时间戳，只能把工具卡时长 + 思考累计加起来（会把空闲时间漏掉） */
	const toolDurationMs = message.blocks.reduce(
		(sum, block) => sum + (block.kind === "tool" && block.endedAt ? block.endedAt - block.startedAt : 0),
		0,
	);
	const summedDurationMs = toolDurationMs + (message.thinkingMs ?? 0);
	/**
	 * 耗时 = **墙上时钟**（ts → endedAt），不是各段相加：
	 *   - 跑着的时候拿 ts 到现在，每秒跳一次，看着像个秒表；
	 *   - 跑完换成 endedAt - ts，和刚才跳到的数字对得上；
	 *   - 拿不到时间戳（老历史）才回落到相加，总比不显示强。
	 */
	/** 这一轮还在跑（没写 endedAt）：耗时在走秒、过程铺开，都是这一个事实 */
	const running = isTurnRunning({ live, endedAt: message.endedAt });
	const ticking = running;
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
	 * 折叠条的展开状态：
	 *   - **跑着的时候铺开**（用户 2026-11-02）：思考段、工具卡、以及中间那几段说明都按发生顺序排着，
	 *     顶部那行「N 段思考 · N 次工具 · 耗时」的秒表跟着往上跳 —— 长任务能一眼看出它到底在干什么；
	 *   - **跑完自动收起**（默认）：过程收成那一行，屏幕上只留最后的结果；
	 *     **以工具调用收尾的也算跑完**（插队 / 被打断的回合，用户 2026-11-03）：照样收，
	 *     否则重开历史时这些回合永远是摊开的（用户勾了「跑完自动折叠」却看不到效果）；
	 *   - 关掉了「跑完自动折叠过程」→ 交回两个「默认展开」开关；
	 *   - **手动点过**的那条消息以手动为准（否则用户点开看了一眼，一次重渲染又自己折叠回去），
	 *     但「跑完那一下」会把这条手动状态作废 —— 要的就是跑完自动收起，不能因为中途点开过就不收。
	 * 关掉自动折叠时回落到原来那两个「默认展开思考块 / 工具卡」开关。
	 */
	const [manualShowTools, setManualShowTools] = useState<boolean | null>(null);
	const [thinkingDefaultOpen] = useStoredBool(THINKING_OPEN_KEY, false);
	const [toolsDefaultOpen] = useStoredBool(TOOL_OPEN_KEY, false);
	const [autoCollapse] = useStoredBool(PROCESS_AUTO_COLLAPSE_KEY, true);
	/** 跑着的时候就收起来（设置 → 过程 → 跑时自动折叠；默认关，铺着看是原来的行为） */
	const [autoFoldRunning] = useStoredBool(PROCESS_AUTO_FOLD_RUNNING_KEY, true);
	/**
	 * 过程区怎么画：要么完整时间线（`all`），要么收成一行（`collapsed`）。
	 * 判断全在 process-fold.ts，这里只喂事实 + 把它翻译成“画到哪”。
	 */
	const view = processView({
		running,
		autoCollapse,
		autoFoldRunning,
		defaultOpen: thinkingDefaultOpen || toolsDefaultOpen,
		manual: manualShowTools,
	});
	const showAll = view === "all";
	/**
	 * 跑完那一下把手动状态交回默认：跑着的时候点开/收起过的，不该阻止它跑完自己收起来。
	 * 用 ref 盯「上一帧还在跑」而不是每帧都清 —— 否则跑完之后用户手动点开会被下一次重渲染抹掉。
	 */
	const wasRunning = useRef(running);
	useEffect(() => {
		if (shouldForgetManual(wasRunning.current, running)) setManualShowTools(null);
		wasRunning.current = running;
	}, [running]);
	/**
	 * 折叠按钮：思考与工具的目录。渲染在**第一次动手的位置**（过程是在那里发生的），
	 * 而不是一直顶在正文上方 —— 结论应该先被看到，看细节才往下找这一行。
	 * 跑着的时候照样画：那行「N 段思考 · 耗时」就是「到现在干了多少」的概览（带秒表），
	 * 而且它就是「想看看前面那些组」的入口（点一下展开完整时间线）。
	 */
	const foldButton = (
		<button
			type="button"
			className="msg-tools-toggle"
			aria-expanded={showAll}
			onClick={() => setManualShowTools(!showAll)}
			title={t(
				"思考、工具调用、以及中间那几段说明，按发生顺序排列（跑的时候铺着看，跑完自动收起；点这一行展开 / 收起）",
				"Thinking, tool calls and the narration in between, in the order they happened (they stay open while the turn runs and fold away when it ends; click this line to expand/collapse)",
			)}
		>
			<span className={`msg-tools-caret${showAll ? " msg-tools-caret-open" : ""}`} aria-hidden="true" />
			{/* 折叠行只报「几段思考 / 几次工具 / 什么技能 / 多久」（用户 2026-10-30：简化）。
			 * 「过程 N 步」是和这两项重复的第三个数（N = 段 + 次），删掉；
			 * 「（点击展开）」也删了 —— 左侧三角和行尾箭头已经在说这件事。 */}
			{thinkingCount > 0 ? (
				<span className="msg-process-meta">{t(`${thinkingCount} 段思考`, `${thinkingCount} thinking`)}</span>
			) : null}
			{toolCount > 0 ? (
				<span className="msg-process-meta">{t(`${toolCount} 次工具`, `${toolCount} tools`)}</span>
			) : null}
			{/* 技能名：不点开也要看得见——“这一轮到底调了哪个 skill”是最常被问的一句 */}
			{skillsUsed.length > 0 ? (
				<span className="msg-process-meta msg-process-skills">
					{t("技能", "Skills")} {skillsUsed.join(" · ")}
				</span>
			) : null}
			{/* 耗时排最后：它是个「结果」，不是入口 —— 先给「做了什么」，最后才落时间。
				    跑着的时候它会每秒跳一次（秒表），跑完定格成总耗时。 */}
			{durationMs > 0 ? (
				<span
					className="msg-process-meta msg-process-time"
					title={
						ticking
							? t(
									"这一轮从开始到现在的墙上时间（每秒刷新）",
									"Wall-clock time since this turn started (ticks every second)",
								)
							: t("这一轮的总耗时", "Total time this turn took")
					}
				>
					{t("耗时", "took")} {durationLabel}
				</span>
			) : null}
			{/* 行尾箭头放在**整条最后**：手风琴的惯例位置。原来它只在手机端顶替
				    「（点击展开）」那行灰字，现在那行字没了，它就是唯一的「能点」提示。 */}
			<span className={`msg-process-chevron${showAll ? " msg-process-chevron-open" : ""}`} aria-hidden="true" />
		</button>
	);
	/**
	 * 画一个渲染单元。
	 *
	 * 正文 / 错误块：**永远画**，永远在它发生的位置（见 buildTurnSegments）—— 折叠不再动它们。
	 * 过程段（思考 + 工具）：
	 *   - `all`：全部铺开（按钮长在**第一段**过程的位置）；
	 *   - `collapsed`：只剩按钮。
	 * 中间那几段说明（text）同理：收起时按折叠范围切（最后一个结论之前的进折叠）。
	 * 错误块**不进折叠**：那一行只报「N 段思考 · N 次工具 · 耗时」，报错藏进去就没人知道了。
	 */
	const renderSegment = (segment: TurnSegment, index: number) => {
		if (segment.kind === "process") {
			if (view === "collapsed")
				return index === firstProcessAt ? <Fragment key={`fold-${index}`}>{foldButton}</Fragment> : null;
			/**
			 * 正在跑的那一步**不画卡**（用户 2026-11-02）：末尾那行状态已经用同一句话 + 秒表报了
			 * 「正在跑命令 … 7s」，再摆一张卡就是同一条命令连看两遍。等它跑完（status 变 ok/failed）
			 * 卡会自然出现在它原来的位置上 —— 时间线里不缺任何一步。
			 */
			const visibleGroups = segment.groups
				.map((group) => ({
					key: group.key,
					thinking: group.thinking,
					tools: group.tools.filter((tool) => !(running && tool.status === "running")),
				}))
				.filter((group) => group.thinking !== null || group.tools.length > 0);
			const groups =
				visibleGroups.length === 0 ? null : (
					<div className="process-segment">
						{visibleGroups.map((group) => (
							<div className="process-group" key={group.key}>
								{group.thinking ? <ThinkingSegment text={group.thinking.text} /> : null}
								{group.tools.map((tool, toolIndex) => (
									<ToolCard key={tool.toolCallId || `${group.key}-${toolIndex}`} block={tool} />
								))}
							</div>
						))}
					</div>
				);
			// 按钮跟在第一段过程头上（展开 / 收起都只有这一个位置；跑着的分支上面已经返回了）
			if (index !== firstProcessAt) return groups ? <Fragment key={`process-${index}`}>{groups}</Fragment> : null;
			return (
				<Fragment key={`fold-${index}`}>
					{foldButton}
					{groups}
				</Fragment>
			);
		}
		if (segment.kind === "text") {
			// 收起时：折叠范围内的不画（只要有一句落在最后，它就是「最后的输出」，永远画）；
			// “跑完了却没结论” 的回合连说明也一起收（用户 2026-11-03，见 hidesNarration）
			if (hidesNarration({ view, running, hasProcess, hasAnswer, insideFold: insideFold(index) })) return null;
			// `live` = 这一条正在流式生成：markdown 降级渲染（节流 + 暂不高亮），
			// 否则每个 delta 都要把整段正文重新解析一遍（越长越贵，末尾最卡）
			// 中间那几段说明（结论之前的正文）字号大一号：夹在思考行与工具行之间时，
			// 它才是「人说的话」，要一眼看得出比机器步骤重要（用户 2026-11-02）。
			// 判定见 `isNarrationText`：同一片过程里的说明必须**全是**这一档，
			// 不能「最新那句当结论、前面几句当叙述」——那样同一层里大小不一（用户 2026-11-02：「不统一呀」）。
			// 用户自己发的话：**按原文纯文字**显示。Markdown 开着 skipHtml，原始 HTML（比如贴进来的 <script>）
			// 会被整段丢掉，于是气泡变成空白（用户 2026-11-05 报的）。用户消息没有排版需求，直接当文字。
			// 图片引用（Composer 发送时写进正文的 `![名](/api/uploads/<id>)`）单独画成缩略图，不混进文字里。
			if (message.role === "user") {
				return segment.text.trim() ? <UserMessageText key={segment.index} text={segment.text} /> : null;
			}
			const narration = isNarrationText({ index, lastAnswerAt, lastProcessAt, running });
			return segment.text.trim() ? (
				<Markdown
					key={segment.index}
					text={segment.text}
					live={live}
					className={narration ? "md-narration" : undefined}
				/>
			) : null;
		}
		// 错误块永远画（收起时也不藏）：它是这一轮真正要说的话
		return (
			<div key={segment.index} className="block-error">
				<span className="block-error-code">{segment.block.code}</span>
				<span className="block-error-text">{segment.block.message}</span>
			</div>
		);
	};
	/**
	 * 正在跑的那一步（给末尾状态行 / 弹层用）。
	 *
	 * 优先用快照的 `activeTool`，但它**只有 200 字摘要**：老服务端不带 `argsFull`，弹层里就只剩
	 * 一截（用户 2026-11-02：「怎么还是不能全部显示出来」）。而消息里那个 `status === "running"`
	 * 的工具块本来就带 `argsFull`，所以这里把它补上 —— 不依赖服务端版本，刷新就能看全文。
	 */
	const runningBlock = [...message.blocks]
		.reverse()
		.find((block) => block.kind === "tool" && block.status === "running");
	const runningArgsFull = runningBlock && runningBlock.kind === "tool" ? runningBlock.argsFull : undefined;
	const liveTool = activeTool ? { ...activeTool, argsFull: activeTool.argsFull ?? runningArgsFull } : null;
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
					{/*
					 * 过程与正文**按发生顺序**交错排（见 buildTurnSegments）。
					 * 折叠**收到最后一个结论之前**：思考、工具卡、以及中间那几段说明一起进折叠，
					 * 跑完屏幕上只剩最后的输出；折叠按钮生在第一次动手的地方。
					 * 没有过程（普通问答）时连按钮都不画，整条都是正文。
					 */}
					{hasProcess ? <div className="msg-process">{segments.map(renderSegment)}</div> : segments.map(renderSegment)}
					{/* 子代理卡片：子代理是这一轮的过程产物，不属于「对话下面」。
					     后一轮再派子代理时，这里会长出**新的一块**：分配按「开始时间落在哪条助手消息」
					     做，所以上一轮的卡片留在它原来的位置上，不会被复用 / 顶掉。 */}
					{subagentRuns && subagentRuns.length > 0 ? <AgentsRunStrip runs={subagentRuns} /> : null}
					{/* 「正在读取 X 技能」/「正在运行 <命令>」/「正在思考」：贴在末尾的状态位。
					     过程铺开之后它不是时间线的替代品，只报「卡没卡、重试没重试、在想还是在等」 */}
					{live ? <LiveActivity message={message} tool={liveTool} retrying={retrying} /> : null}
				</div>
				{/* 「插队」小标已经移到气泡内的抬头里（见上方 msg-steer-head），这里不再重复 */}
			</div>
			{message.role === "assistant" ? (
				<footer className="msg-foot">
					{/* 尾注：用量 · 复制 · 分支 · 时间（用户 2026-10-30 定：**放回底部**，抬头只留模型与流式计数）
					 * 数字每调完一次模型就多一份、跑着的时候一直在涨（以前这些在尾注，
					 * 和复制按钮挤在一行）。 */}
					{message.usage ? (
						<span className="msg-usage mono">
							{usageItemsOf(message.usage, t).map((item) => (
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
							{/* 子代理金额：一律显示（与左边的 in/out/cache/$ 同一口径，不再分两套开关） */}
							{subUsage.cost > 0 ? (
								<span className="msg-usage-item msg-usage-cost">{formatCost(subUsage.cost)}</span>
							) : null}
						</span>
					) : null}

					{/* 复制只等跑完：复制一个还在长的东西没意义（用户反馈也是这么说的） */}
					{live ? null : (
						<CopyButton text={text} className="msg-foot-copy" title={t("复制这条回复", "Copy this reply")} />
					)}
					{/* 从这里创建分支（= pi 的 /fork）：在这条回复处另开一条会话接着聊，原对话不动。
					 * 也只在跑完之后给：跑到一半去 fork，拿到的是半截历史。
					 * 用量与时间搬到抬头那行了（用户 2026-10-30），这里只剩操作 —— 两个都没有时整条不画。 */}
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
							<span>{t("分叉", "Fork")}</span>
						</button>
					)}
					<span className="topbar-spacer" />
					{/* 时间：**一开始就显示**（先给开始时间），跑完再换成完成时间 —— 不再等结束才出现 */}
					<FootStamp
						ts={finishedAt ?? message.ts}
						title={
							finishedAt !== null
								? t("这条回复完成的时间", "When this reply finished")
								: t("这条回复开始的时间", "When this reply started")
						}
					/>
				</footer>
			) : null}
			{message.role === "user" ? (
				// 气泡下面那一行：默认只露时间；复制/编辑鼠标悬浮在气泡上才出现（靠右、排在时间前面）
				<footer className="msg-user-foot">
					{/* 顺序（用户 2026-10-30）：「从此处编辑」在前、「复制」在后，两个都常显（不再等悬浮）。
					 * 插队消息的「移回输入框」在气泡抬头里（和待发条一致），这里不再重复一个。 */}
					{message.steer ? null : (
						<button
							type="button"
							className="msg-action"
							onClick={() => setDraft(text)}
							title={t("把这条消息放回输入框，改完再发", "Put this message back in the input, edit and send again")}
						>
							↳ {t("编辑", "Edit")}
						</button>
					)}
					<CopyButton text={text} title={t("复制这条消息", "Copy this message")} />
					<FootStamp ts={message.ts} title={t("这条消息的时间", "When this message was sent")} />
				</footer>
			) : null}
			{message.role === "assistant" ? (
				<ChangedFiles
					files={changed}
					onOpen={onOpenFile ? (file) => onOpenFile(file.path, workspaceRoot) : undefined}
				/>
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

function usageItemsOf(usage: NonNullable<UiMessage["usage"]>, t: (zh: string, en?: string) => string): UsageItem[] {
	const items: UsageItem[] = [
		{
			key: "in",
			tag: "in",
			text: compactTokens(usage.input),
			title: t(
				`输入 ${withThousands(usage.input)} tokens（这一轮发给模型的）`,
				`Input ${withThousands(usage.input)} tokens (sent to the model this turn)`,
			),
		},
		{
			key: "out",
			tag: "out",
			text: compactTokens(usage.output),
			title: t(
				`输出 ${withThousands(usage.output)} tokens（模型写回来的）`,
				`Output ${withThousands(usage.output)} tokens (written back by the model)`,
			),
		},
	];
	if (usage.cacheRead > 0) {
		items.push({
			key: "cacheRead",
			tag: "cache",
			text: compactTokens(usage.cacheRead),
			title: t(
				`缓存读 ${withThousands(usage.cacheRead)} tokens（命中提示词缓存，按折扣计价）`,
				`Cache read ${withThousands(usage.cacheRead)} tokens (prompt cache hit, billed at a discount)`,
			),
		});
	}
	if (usage.cacheWrite > 0) {
		items.push({
			key: "cacheWrite",
			tag: "cacheW",
			text: compactTokens(usage.cacheWrite),
			title: t(
				`缓存写 ${withThousands(usage.cacheWrite)} tokens（把前缀写进缓存，下次能命中）`,
				`Cache write ${withThousands(usage.cacheWrite)} tokens (prefix stored for the next hit)`,
			),
		});
	}
	// 花费自带 $ 符号，不再加徽标；pi 拿不到价格时就不出现（不编 0）
	if (usage.cost)
		items.push({
			key: "cost",
			text: formatCost(usage.cost),
			title: t(
				"这一轮的花费（pi 按 provider 配置的价格估算）",
				"Cost of this turn (estimated from the provider prices pi has)",
			),
		});
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

/**
 * 缺省的空子代理列表。
 *
 * 写成解构默认值 `subagentRuns = []` 时，每次渲染都是一个新数组 —— 下面那两个
 * `useMemo` 的依赖每帧都变，等于没 memo。手机 CPU 上这直接变成切会话时的卡顿。
 */
const NO_SUBAGENT_RUNS: readonly SubagentRunView[] = [];

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
	subagentRuns = NO_SUBAGENT_RUNS,
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
	activeTool?: { name: string; argsSummary: string; argsFull?: string; startedAt: number } | null;
	/** 这一轮正在自动重试（快照的 `running.retrying`）：把「正在思考」换成「正在重试…」 */
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
	/**
	 * 插队消息先挪位再画：服务端只能把插队那句话追加到这一轮末尾，
	 * 而它其实是插在中间的（后面那段助手正文说不定就是在回答它）——
	 * 不挪的话看着像先答后问，气泡上却还挂着「插队」（见 `steer-order.ts`）。
	 * 只改显示顺序，消息本身一个字不动。
	 *
	 * 两个 O(消息数) 的纯函数用 `useMemo` 记一份：本组件会因为输入框、悬停、选中这些
	 * 与会话内容无关的状态频繁重渲染，每帧重算 + 重建 Map 在手机上可感。
	 * **必须在下面那个早退之前调**（hooks 不能有条件地调用）。
	 */
	const shown = useMemo(() => liftSteeredMessages(messages), [messages]);
	// 子代理卡片挂在哪条消息上：按「开始时间落在哪条助手消息」分配（见 assignRunsToMessages）
	const runsByMessage = useMemo(() => assignRunsToMessages(subagentRuns, shown), [subagentRuns, shown]);
	// 空会话（新会话）什么都不画：标题/引导在输入框上方那块（NewChatMeta），这里留白
	if (messages.length === 0) return null;
	// 实时数字挂在哪条消息上：最后一条**还没跑完**的助手消息（跑完 endedAt 才有值）
	const liveId = running ? (lastOpenAssistant(shown)?.id ?? null) : null;
	/**
	 * 找不到宿主消息、但**正在跑**的那几张：刷新进来时宿主消息可能还没进本页（分页 / 轮次刚开）。
	 * 以前这种会直接不画（`assignRunsToMessages` 对配不上的直接 `continue`），于是
	 * 「刷新后看不到正在跑的子代理」——用户 2026-11-02 报的就是这个。
	 * 这些兜底顶在对话最上面；已经跑完的不享此待遇（那是历史，该留在它当时的位置）。
	 */
	const placed = new Set<string>();
	for (const list of runsByMessage.values()) for (const run of list) placed.add(run.id);
	const orphanRunning = subagentRuns.filter((run) => isActive(run) && !placed.has(run.id));

	return (
		<div className="messages" ref={listRef}>
			{hasMoreBefore ? (
				<div className="more-before">
					{t("更早的消息未在本页（分页在 M6）", "Earlier messages are not on this page")}
				</div>
			) : null}
			{/* 没宿主的「正在跑」卡片条：顶在对话最上面，免得刷新进来时凭空消失 */}
			{orphanRunning.length > 0 ? (
				<div className="agents-strip-orphan">
					<AgentsRunStrip runs={orphanRunning} />
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
						// id 跟真消息同一套命名：滚动锚点靠 `msg-<id>` 找节点（点按钮发出去的那条先落在这里）
						<article className={`msg msg-user pending-item pending-${item.mode}`} key={item.id} id={`msg-${item.id}`}>
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
