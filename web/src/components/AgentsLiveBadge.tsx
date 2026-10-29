/**
 * 顶栏的「子代理」实时徽标 + 浮层（多开时一眼看清谁在跑）。
 *
 * 为什么要有它：子代理是**并行**的，跑起来之后主对话那边往往只剩一句「等子代理」，
 * 用户想知道「现在几个在跑、各自花了多久/多少 token」得先开面板 —— 那一步太多。
 * 这里把同一份快照数据（`snapshot.subagents`）摊在顶栏，做一眼概览；
 * 想看结果 / 会话文件就去**对话下方的卡片条**（`AgentsRunStrip`），面板只管模板与开关。
 *
 * 数据全部来自快照，除「计时」之外不自己造数字：浮层里的耗时 / token / 花费与面板同源
 * （`subagent-view.ts` 的同一套函数），不会出现「顶栏说 2 分钟、面板说 1 分钟」。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { useAppState } from "../store.ts";
import { interruptSubagent } from "../ws.ts";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { belowPopoverAnchor } from "../popover-anchor.ts";
import {
	batchesOf,
	STATUS_LABEL,
	StatusDot,
	compact,
	costText,
	duration,
	durationMs,
	isActive,
	relativeTime,
	runsOfCurrentTurn,
	totalsOf,
} from "../subagent-view.tsx";
import { useT } from "../use-language.ts";
import { useShowCost } from "../use-show-cost.ts";

export function AgentsLiveBadge({
	onOpenPanel,
	turnStartedAt,
}: {
	onOpenPanel: () => void;
	/** 本轮起点（最后一条用户消息的时间）：只显示这一轮派出去的子代理 */
	turnStartedAt: number | null;
}) {
	const t = useT();
	const { snapshot } = useAppState();
	/** 金额显不显示跟着本机偏好（手机默认不显示，见 use-show-cost.ts） */
	const showCost = useShowCost();
	const [open, setOpen] = useState(false);
	const [now, setNow] = useState(() => Date.now());
	const box = useRef<HTMLDivElement | null>(null);
	const triggerRef = useRef<HTMLButtonElement>(null);
	const popRef = useRef<HTMLDivElement>(null);
	/**
	 * 浮层坐标（居中于徽标、夹进视口）。
	 *
	 * 以前是 CSS 的 `right: 0` 贴徽标右边缘：桌面上还行，**手机上直接跑偏** ——
	 * 卡片宽 351px 挂在一个靠右的徽标上，左边溢出屏幕，看起来就是"被挡掉一半"。
	 */
	const [anchor, setAnchor] = useState<{ left: number; top: number; arrow: number } | null>(null);
	const mobile = currentMobileShell();

	useLayoutEffect(() => {
		if (!open) {
			setAnchor(null);
			return;
		}
		const measure = () => {
			const trigger = triggerRef.current?.getBoundingClientRect();
			const pop = popRef.current?.getBoundingClientRect();
			if (!trigger || !pop) return;
			setAnchor(
				belowPopoverAnchor({
					trigger: { left: trigger.left, top: trigger.top, width: trigger.width, height: trigger.height },
					popover: { width: pop.width },
					viewport: { width: window.innerWidth, height: window.innerHeight },
				}),
			);
		};
		measure();
		window.addEventListener("resize", measure);
		return () => window.removeEventListener("resize", measure);
	}, [open, mobile]);

	/**
	 * 只认**本轮**的运行记录。
	 *
	 * 以前这里是快照里的全部记录（每会话留最近 30 条、跨轮次累积），于是一发新问题，
	 * 上一问的子代理还挂在顶栏上 —— 看着像「这一问又跑了一遍」。用户消息一出现，
	 * 起点就往前推，旧的自动退场（新一轮真的派了子代理再重新出现）。
	 */
	const runs = runsOfCurrentTurn(snapshot?.subagents ?? [], turnStartedAt);
	const capable = snapshot?.engineCapabilities.subagents === true;
	// 只算最近一轮：历史记录是累积的（每会话 30 条），拿总数会让人以为并发开到了 8 个
	const latest = batchesOf(runs)[0] ?? [];
	const totals = totalsOf(latest, now);
	/** 队列先进先出：按开始时间排就能给出「第几位」（与卡片条同一口径） */
	const concurrency = snapshot?.subagentSettings?.concurrency ?? 4;
	const queuedOrder = new Map<string, number>();
	latest
		.filter((run) => run.status === "queued")
		.sort((a, b) => a.startedAt - b.startedAt)
		.forEach((run, index) => queuedOrder.set(run.id, index + 1));

	// 浮层开着、或还有在跑的：1 秒刷一次「多久了」（不跑定时器就没有额外开销）
	useEffect(() => {
		if (!open && totals.running === 0) return;
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, [open, totals.running]);

	// 点外面 / Esc 关掉；切会话也关（那是另一批子代理了）
	useEffect(() => {
		if (!open) return;
		const onPointerDown = (event: PointerEvent) => {
			if (box.current && !box.current.contains(event.target as Node)) setOpen(false);
		};
		const onKeyDown = (event: KeyboardEvent) => {
			if (event.key === "Escape") setOpen(false);
		};
		document.addEventListener("pointerdown", onPointerDown);
		document.addEventListener("keydown", onKeyDown);
		return () => {
			document.removeEventListener("pointerdown", onPointerDown);
			document.removeEventListener("keydown", onKeyDown);
		};
	}, [open]);

	useEffect(() => {
		setOpen(false);
	}, [snapshot?.active.conversationId]);

	// 没有子代理（或引擎不提供）→ 不占位置
	if (!capable || runs.length === 0) return null;

	const mainTitle = snapshot?.conversations.find((item) => item.id === snapshot.active.conversationId)?.title ?? "";
	const active = latest.filter(isActive).length;
	const label = active > 0 ? `${active} / ${latest.length} 个在跑` : `${latest.length} 个子代理（最近一轮）`;

	return (
		<div className="agents-live" ref={box}>
			<button
				ref={triggerRef}
				type="button"
				className={`appbar-agents${active > 0 ? " appbar-agents-on" : ""}${open ? " appbar-agents-open" : ""}`}
				onClick={() => setOpen((value) => !value)}
				title={label}
				aria-haspopup="dialog"
				aria-expanded={open}
				aria-label={`子代理：${label}`}
			>
				<svg
					viewBox="0 0 16 16"
					width="14"
					height="14"
					fill="none"
					stroke="currentColor"
					strokeWidth={1.4}
					strokeLinecap="round"
					strokeLinejoin="round"
					aria-hidden="true"
				>
					<rect x="3.2" y="5.6" width="9.6" height="7.4" rx="2.2" />
					<path d="M8 5.6V3.3" />
					<circle cx="6" cy="8.7" r="0.7" fill="currentColor" stroke="none" />
					<circle cx="10" cy="8.7" r="0.7" fill="currentColor" stroke="none" />
					<path d="M6.2 11h3.6" />
				</svg>
				<span className="appbar-agents-count">{active > 0 ? `${active}` : `${latest.length}`}</span>
				{active > 0 ? <span className="appbar-agents-total">/{latest.length}</span> : null}
			</button>

			{open ? (
				<div
					ref={popRef}
					className="agents-pop"
					role="dialog"
					aria-label={t("子代理运行情况", "Subagent activity")}
					// 先按不可见渲染一帧量宽度，再落到最终坐标（避免闪一下）
					style={anchor ? { left: anchor.left, top: anchor.top } : { visibility: "hidden" }}
				>
					{/* 朝上的小尾巴，指着徽标中心（浮层被夹到视口边缘时也不会漂） */}
					{anchor ? <span className="agents-pop-arrow" style={{ left: anchor.arrow }} aria-hidden="true" /> : null}
					{/* 滚动放在这一层：浮层本身不能 overflow:hidden，否则朝上的小尾巴会被裁掉 */}
					<div className="agents-pop-scroll">
						<div className="agents-pop-head">
							<span className="agents-pop-title">Agents</span>
							<span className="agents-pop-note">
								{latest.length} {t("个子 Agent（最近一轮）", "subagents (latest turn)")}
							</span>
							<span className="agents-pop-total">
								{totals.ms > 0 ? (
									<>
										{t("合计", "Total")} ⏱ {durationMs(totals.ms)}
									</>
								) : null}
								{totals.tokens > 0 ? (
									<>
										{totals.ms > 0 ? " · " : `${t("合计", "Total")} `}
										{compact(totals.tokens)} tokens
									</>
								) : null}
								{showCost && totals.cost > 0 ? <> · {costText(totals.cost)}</> : null}
							</span>
							{active > 0 ? <span className="agents-pop-running">{active} 个运行中</span> : null}
						</div>

						<ul className="agents-pop-list">
							<li className="agents-pop-row agents-pop-row-main">
								<span className="agents-pop-icon" aria-hidden="true">
									<svg
										viewBox="0 0 16 16"
										width="15"
										height="15"
										fill="none"
										stroke="currentColor"
										strokeWidth={1.3}
										strokeLinecap="round"
										strokeLinejoin="round"
									>
										<circle cx="8" cy="5.4" r="2.6" />
										<path d="M2.8 13.4a5.2 5.2 0 0 1 10.4 0" />
									</svg>
								</span>
								<span className="agents-pop-main">
									<span className="agents-pop-name">{t("主 Agent")}</span>
									<span className="agents-pop-sub" title={mainTitle}>
										{mainTitle || "当前会话"}
									</span>
								</span>
								<span className="agents-pop-status">{t("当前")}</span>
							</li>

							{latest.map((run) => (
								<li key={run.id} className={`agents-pop-row agents-pop-row-${run.status}`}>
									<span className="agents-pop-icon" aria-hidden="true">
										<svg
											viewBox="0 0 16 16"
											width="15"
											height="15"
											fill="none"
											stroke="currentColor"
											strokeWidth={1.3}
											strokeLinecap="round"
											strokeLinejoin="round"
										>
											<rect x="3.2" y="5.6" width="9.6" height="7.4" rx="2.2" />
											<path d="M8 5.6V3.3" />
											<circle cx="6" cy="8.7" r="0.7" fill="currentColor" stroke="none" />
											<circle cx="10" cy="8.7" r="0.7" fill="currentColor" stroke="none" />
											<path d="M6.2 11h3.6" />
										</svg>
									</span>
									<button
										type="button"
										className="agents-pop-main agents-pop-main-btn"
										onClick={() => setOpen(false)}
										title={`${run.task}\n\n结果与耗时详情看对话下方的子代理卡片`}
									>
										<span className="agents-pop-name">{run.description || run.label}</span>
										<span className="agents-pop-sub">
											{run.label} · {relativeTime(run.startedAt, now)}
										</span>
										<span className="agents-pop-metrics">
											<span>⏱ {duration(run, now)}</span>
											{run.tokens?.total ? <span>{compact(run.tokens.total)} tokens</span> : null}
											{showCost && run.cost ? <span>{costText(run.cost)}</span> : null}
										</span>
									</button>
									<span
										className={`agents-pop-status agents-status-${run.status}`}
										title={
											run.status === "queued"
												? `排队第 ${queuedOrder.get(run.id) ?? "?"} 位：等前面跑完自动开（最多同时 ${concurrency} 个）`
												: undefined
										}
									>
										<StatusDot status={run.status} />
										{STATUS_LABEL[run.status]}
									</span>
									{isActive(run) ? (
										<button
											type="button"
											className="agents-pop-stop"
											onClick={() => interruptSubagent(run.id)}
											title={t("停掉这个子代理（不动主会话）")}
										>
											停止
										</button>
									) : null}
								</li>
							))}
						</ul>

						<div className="agents-pop-foot">
							<button
								type="button"
								className="agents-pop-more"
								onClick={() => {
									setOpen(false);
									onOpenPanel();
								}}
							>
								打开面板（模板 / 设置）
							</button>
						</div>
					</div>
				</div>
			) : null}
		</div>
	);
}
