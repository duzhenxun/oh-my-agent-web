import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Snapshot } from "../types.ts";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { setApprovalMode } from "../ws.ts";
import { useT } from "../use-language.ts";
// 花费文案与子代理卡片 / 消息尾注共用一套（<$0.001 / $0.437 / $3.44）
import { costText } from "../subagent-view.tsx";
import { STATUSBAR_ITEM_KEY, STATUSBAR_TOGGLES } from "../ui-prefs.ts";
import { usePrefFlags } from "../use-pref-flags.ts";
import { centeredPopoverAnchor } from "../popover-anchor.ts";
import { EnginePicker } from "./EnginePicker.tsx";
import { ModelChips } from "./ModelChips.tsx";

function formatTokens(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(1)}K`;
	return `${(value / 1_000_000).toFixed(2)}M`;
}

/**
 * 底部状态栏：一眼看到“机器现在是什么状态、这条会话在用什么”。
 * 左：项目名 / 审批 / 排队 / 工作中 / 上下文；右：顶部栏开关。
 * 数据全部来自已有快照，不额外拉取。
 *
 * **两种口径**:
 *   - 「排队 / 工作中」是**整机**的（所有项目、所有会话加起来）—— 它们是「机器还在忙什么」；
 *   - 「模型 / 强度 / 审批 / 上下文」是**当前会话**的 —— 它们是「这一句怎么跑」。
 * 混着用会让人读错。
 *
 * 为什么把「模型 / 强度 / 审批」放这里：它们改的是**这一次以及之后怎么跑**，
 * 不是要发出去的内容；放在输入框上方会跟「想说什么」挤在一起。
 *
 * 中间的「排队 / 工作中 / 上下文」三块信息可以在设置 → 界面 → 底部里关掉（纯本机偏好）；
 * 审批模式与右端的「顶部」开关不可关 —— 它们是操作入口。
 */
export function StatusBar({
	snapshot,
	appbarHidden,
	onToggleAppbar,
}: {
	snapshot: Snapshot | null;
	/** 顶部栏是否收起（状态由 App 持有并持久化） */
	appbarHidden: boolean;
	onToggleAppbar: () => void;
}) {
	const t = useT();
	/**
	 * 「排队 / 工作中」按**整台服务端**算 —— 所有项目、所有会话加起来。
	 *
	 * 以前只算当前这条会话：别处还有会话在跑时，这里一直写 0，用户看不出「机器现在到底忙不忙」，
	 * 也不会知道「等的那条已经开始了」。这两块本来就是整机口径（跟侧栏那颗转圈同一个意思）；
	 * **模型 / 思考强度 / 上下文仍然只看当前会话** —— 那是「这一句怎么跑」，换成全局就是骗人。
	 */
	const running = snapshot
		? Object.values(snapshot.runningByConversation ?? {}).filter((item) => item.status !== "idle").length
		: 0;
	const queued = (snapshot?.queued ?? []).length;
	// 这三块信息的显隐：设置 → 界面 → 底部（默认全显示）
	const [showInfo] = usePrefFlags(STATUSBAR_TOGGLES, STATUSBAR_ITEM_KEY);
	/**
	 * 引擎切换：**固定在底座状态栏**（不再放顶栏）。“图标 + 短名 + 箭头” 归回到这里，
	 * 就排在「放行」那颗（审批模式）后面，跟它一样是「这一步怎么跑」的开关；
	 * 浮层要**向上**弹（状态栏贴着窗口最底，往下就出屏了），由 placement="statusbar" 负责。
	 * 不再设显隐勾选：它在顶栏时是面板之一，现在跟审批模式并排，是可操作的动作。
	 */
	const stats = snapshot?.sessionStats ?? null;
	// 上下文用量：sessionStats.contextTokens（最近一条 assistant 的输入侧）÷ 当前模型窗口。
	// 窗口大小客户端本来就有（快照里带着 providers → 每个模型的规格），不用再问服务端。
	const [providerName, ...modelRest] = String(snapshot?.model ?? "").split("/");
	const modelSpec = (snapshot?.providers ?? [])
		.find((provider) => provider.provider === providerName)
		?.models.find((model) => model.id === modelRest.join("/"));
	const contextWindow = modelSpec?.contextWindow && modelSpec.contextWindow > 0 ? modelSpec.contextWindow : null;
	const contextUsed = stats?.contextTokens ?? 0;
	const contextRatio = contextWindow ? Math.min(1, contextUsed / contextWindow) : 0;
	const contextPercent = contextWindow ? Math.round(contextRatio * 100) : null;
	/** 圆环：r=6 周长约 37.7，用 dasharray 画进度 */
	const RING = 37.7;
	const [usageOpen, setUsageOpen] = useState(false);
	/** 浮层锚点：贴着上下文胶囊**正上方**（状态栏是 overflow 容器，只能用 fixed + 现算坐标） */
	const [usageAnchor, setUsageAnchor] = useState<{ left: number; bottom: number; arrow: number } | null>(null);
	const contextRef = useRef<HTMLButtonElement>(null);
	const usagePopRef = useRef<HTMLDivElement>(null);

	/**
	 * 打开后量一次，并把锚点算成「**水平中心对齐胶囊中心**」。
	 *
	 * 以前是把浮层的**右边缘**对齐胶囊右边缘：胶囊在状态栏偏右时看着还行，
	 * 但浮层比胶囊宽得多，点中间却从左边冒出来一大截 —— 读起来像「没对准我点的地方」。
	 * 现在居中，再夹进视口（窄屏贴边不会跑出屏幕）。窗口尺寸变了要重算，
	 * 否则浮层会停在旧坐标上。
	 */
	useLayoutEffect(() => {
		// 手机上不用算坐标：弹层是整宽（左右各 8px），由 CSS 定位
		if (!usageOpen || currentMobileShell()) {
			setUsageAnchor(null);
			return;
		}
		const measure = () => {
			const chip = contextRef.current?.getBoundingClientRect();
			const pop = usagePopRef.current?.getBoundingClientRect();
			if (!chip || !pop) return;
			setUsageAnchor(
				centeredPopoverAnchor({
					trigger: { left: chip.left, top: chip.top, width: chip.width, height: chip.height },
					popover: { width: pop.width },
					viewport: { width: window.innerWidth, height: window.innerHeight },
				}),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [usageOpen]);

	/**
	 * 点浮层外面 / 按 Esc 关掉。
	 *
	 * 以前只有「再点一次胶囊」才关，于是想关它得先找准那个小胶囊 —— 满屏找。
	 * 点胶囊本身交给它自己的 onClick（这里跳过），否则会「先关再被 click 打开」地闪一下。
	 */
	useEffect(() => {
		if (!usageOpen) return;
		const onPointerDown = (event: PointerEvent) => {
			const target = event.target as Node | null;
			if (!target) return;
			if (usagePopRef.current?.contains(target)) return; // 浮层内部（以后可能有点得动的行）
			if (contextRef.current?.contains(target)) return; // 胶囊自己管开合
			setUsageOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setUsageOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [usageOpen]);
	return (
		<footer className="statusbar">
			{/*
			 * 项目名**不在这条上了**（用户 2026-10-29 定）：它跟分支一起挪到了输入框上方那一排
			 * （`ProjectBranchChips`），手机上也一样 —— 同一个名字在这儿再写一遍就是重复，
			 * 而且窄屏上这一条本来就挤。状态栏只留「怎么跑」的开关与整机状态。
			 */}
			<span className="status-controls">
				{/* 审批模式在最前面：它是「这一步会不会被拦住」的开关，最该一眼看到 */}
				{snapshot?.engineCapabilities.approvals === false ? (
					<span
						className="tool-chip tool-static"
						title={t(
							"该引擎自行决定授权，本工作台拦不住它的危险操作",
							"This engine decides approvals itself; the workbench cannot block its risky operations",
						)}
					>
						{t("🔒 审批：引擎自理", "🔒 Approvals: engine-managed")}
					</span>
				) : (
					<button
						type="button"
						className={`tool-chip${snapshot?.approvalMode === "allow" ? " tool-chip-warn" : ""}`}
						onClick={() =>
							setApprovalMode(
								snapshot?.approvalMode === "allow" ? "ask" : "allow",
								// 必须带上当前会话：模式是按会话存的，不带就会落到服务端以为的 activeId 上
								// （切会话的瞬间点一下，就会记到另一条会话头上，见 ws.ts 的备注）
								snapshot?.active.conversationId ?? null,
							)
						}
						title={t(
							"审批模式（全局生效，重启回到默认：放行）——点一下在「放行 / 询问」之间切换",
							"Approval mode (global; resets to allow on restart) — click to switch between allow and ask",
						)}
					>
						{/* 文案 2026-10-29 从「全部放行」改短成「放行」（用户：改成放行）——
						 * 跟隔壁的「🔒 询问」一样是两个字的动作词，手机上这一排本来就挤。 */}
						{snapshot?.approvalMode === "allow" ? t("🔓 放行", "🔓 Allow") : t("🔒 询问", "🔒 Ask")}
					</button>
				)}
				<EnginePicker placement="statusbar" />
				{/*
				 * 「模型 · 强度」：用户 2026-10-29 定 —— 从输入框上方那排**移下来**，放在引擎那颗的**右边**。
				 * 跟隔壁的审批 / 引擎是同一类开关（「这一步用谁、跑多细」），挤在一条里比挂在
				 * 输入框上方更好找；`statusbar.css` 里本来就留着 `.statusbar .model-trigger`
				 * 那套缩小样式，高度对得上（状态栏只有 24px）。
				 * **手机也一样**（同一天补的要求）：这条在手机上本来就是横向可滚的，
				 * 装不下的 排队 / 工作中 / 上下文 继续往右排，滑一下就能看到；
				 * 模型菜单在手机上本来就是底部抽屉（见 `ModelPicker`），点开不会跑出屏幕。
				 */}
				<ModelChips />
			</span>
			{showInfo.queued ? (
				<span
					className="status-item status-queued"
					title={t("所有项目 / 所有会话的待发队列合计", "Queued messages across all sessions and projects")}
				>
					<span className="status-ico">⏳</span> {t("排队", "Queued")} {queued}
				</span>
			) : null}
			{showInfo.running ? (
				<span
					className={`status-item status-running${running > 0 ? " is-working" : ""}`}
					title={t("所有项目 / 所有会话里正在跑的回合数", "Turns currently running across all sessions and projects")}
				>
					{/* 有回合在跑时转起来（没跑就是个静止的小环） */}
					<span className="status-spinner" aria-hidden="true" />
					{t("工作中", "Running")} {running}
				</span>
			) : null}
			{showInfo.context ? (
				<span className="status-context-wrap">
					<button
						ref={contextRef}
						type="button"
						className="status-context"
						title={
							contextWindow
								? `当前会话上下文：已用 ${contextUsed.toLocaleString()} / 窗口 ${contextWindow.toLocaleString()}（${contextPercent}%）· 点开看整段会话累计（每条回复底部的 I/O/C 只算那一轮）`
								: t("当前会话上下文（模型窗口未知）", "Context of this conversation (model window unknown)")
						}
						onClick={() => setUsageOpen((value) => !value)}
					>
						<svg className="status-ring" viewBox="0 0 16 16" aria-hidden="true">
							<circle className="status-ring-bg" cx="8" cy="8" r="6" />
							<circle
								className="status-ring-fg"
								cx="8"
								cy="8"
								r="6"
								style={{ strokeDasharray: `${(contextRatio * RING).toFixed(2)} ${RING}` }}
							/>
						</svg>
						<span className="status-context-used">{formatTokens(contextUsed)}</span>
						<span className="status-context-total">/ {contextWindow ? formatTokens(contextWindow) : "—"}</span>
					</button>
					{usageOpen ? (
						<div
							ref={usagePopRef}
							className={`status-usage-pop${currentMobileShell() ? " status-usage-pop-full" : ""}`}
							role="dialog"
							aria-label={t("会话信息", "Session info")}
							// 手机上交给 CSS（整宽）；桌面上先按「不可见」渲染一帧量出宽度，再落到最终位置（避免闪一下）
							style={
								currentMobileShell()
									? undefined
									: usageAnchor
										? { left: usageAnchor.left, bottom: usageAnchor.bottom }
										: { visibility: "hidden" }
							}
						>
							{/* 指向下方胶囊的小尾巴：没有它时浮层像凭空浮起来，
							    看不出是「从哪个按钮长出来的」（手机上浮层是整宽，不渲染） */}
							{usageAnchor ? (
								<span className="status-usage-arrow" style={{ left: usageAnchor.arrow }} aria-hidden="true" />
							) : null}
							<div className="status-usage-title">{t("会话信息（整段会话）", "Session info (whole session)")}</div>
							{[
								[t("用户消息", "User messages"), String(stats?.userMessages ?? 0)],
								[t("助手消息", "Assistant messages"), String(stats?.assistantMessages ?? 0)],
								[t("工具调用", "Tool calls"), String(stats?.toolCalls ?? 0)],
								// 「输入」在 pi 里不含缓存命中的部分，逐次累加；和下面的「上下文占用」不是一个量纲
								[t("输入（未命中缓存）", "Input (cache misses)"), formatTokens(stats?.inputTokens ?? 0)],
								[t("输出", "Output"), formatTokens(stats?.outputTokens ?? 0)],
								[t("缓存读（命中）", "Cache read (hits)"), formatTokens(stats?.cacheRead ?? 0)],
								[t("缓存写", "Cache write"), formatTokens(stats?.cacheWrite ?? 0)],
								// 花费比「合计 tokens」有用：合计被缓存读主导（每轮重读整段前缀），看不出到底花了多少
								["总花费", stats?.cost ? costText(stats.cost) : "—"],
								[
									"上下文（最后一次）",
									contextWindow
										? `${formatTokens(contextUsed)} / ${formatTokens(contextWindow)}`
										: formatTokens(contextUsed),
								],
							].map(([label, value]) => (
								<div className="status-usage-row" key={label}>
									<span>{label}</span>
									<span className="mono">{value}</span>
								</div>
							))}
							{/* 口径说明：这里和每条回复尾注的数字不是一回事，很容易被读成「同一个数怎么两样」 */}
							<div className="status-usage-note">
								上面这些是<b>{t("整段会话")}</b>
								{t("的累计值；每条回复底部那行")} <b>I / O / C</b> {t("是")}
								<b>{t("那一轮自己的")}</b>用量。 「输入」
								<b>{t("不含")}</b>缓存命中部分（命中单列在缓存读里，每一轮都重新读一遍整个前缀，所以会很大）。
								「上下文」只算
								<b>{t("最后一次")}</b>调用：输入 + 缓存读 + 缓存写，所以它常比累计输入大得多。
								<br />
								{/* 口径必须说清楚：这些数是从**主会话的 JSONL** 里算的，子代理是独立会话、独立计费，
								    压根不在这个文件里 —— 不写明的话，用户会拿它当「这一整轮到底花了多少」 */}
								另外，<b>{t("子代理")}</b>是独立会话、单独计费，
								<b>{t("不在")}</b>上面的统计里（去对话里的子代理卡片看它们各自的用量）。
							</div>
						</div>
					) : null}
				</span>
			) : null}
			<span className="status-spacer" />
			<button
				type="button"
				className="status-toggle"
				onClick={onToggleAppbar}
				title={appbarHidden ? t("显示顶部栏", "Show the top bar") : t("隐藏顶部栏", "Hide the top bar")}
			>
				<span className="status-toggle-icon">{appbarHidden ? "▾" : "▴"}</span>
				{/* 文案写「动作」而不是「东西」：以前只写「顶部」，看一眼不知道点下去会收起还是展开，
				    得先猜一遍。现在顶上写着什么，它就写着「隐藏顶部」；收起后变成「显示顶部」。 */}
				<span className="status-toggle-label">
					{appbarHidden ? t("显示顶部", "Show top bar") : t("隐藏顶部", "Hide top bar")}
				</span>
			</button>
		</footer>
	);
}
