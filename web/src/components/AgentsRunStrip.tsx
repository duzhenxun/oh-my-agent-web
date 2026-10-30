/**
 * 这一轮对话里的「子代理」卡片条（派出去的活，就地看）。
 *
 * 位置：**嵌在消息流里**，落在「过程（思考 / 工具）」之后、正文（最终回答）之前 ——
 * 子代理是这一轮的过程产物，它就该在那儿，而不是吊在整个对话之下（那样看着像另一个模块，
 * 也分不清是哪一问派出去的）。面板只留模板与开关。
 *
 * 数据由调用方按「本轮」筛好传进来（见 subagent-view 的 runsOfCurrentTurn）：
 * 上一问的子代理不该挂在新问题上。
 *
 * 纪律：数据仍只来自快照（`snapshot.subagents` 已经是「只含当前会话」的投影），
 * 数字口径与顶栏浮层 / 面板共用 `subagent-view.ts`，不在这里另算一套。
 * 会话保留最近 30 条历史记录（跨轮次累积，不是并发数），所以按「轮次」分组：
 * 调用方已经把「这一轮」的运行筛好传进来了（`assignRunsToMessages`），
 * 所以这里**把这一轮的全部运行都铺出来**，包括已经跑完的 ——
 * 以前只铺「最新一批（起始时间 30 秒内）」，于是模型分两波派活时（先 4 个、过会儿再 3 个）
 * 先开的那几张跑完就“不见了”，用户会以为记录被删了。要看整轮的账，就得一条不落。
 */
import { useEffect, useState } from "react";
import { useAppSelector } from "../store.ts";
import { compact, costText, countsLabel, durationMs, isActive, totalsOf } from "../subagent-view.tsx";
import type { SubagentRunView } from "../types.ts";
import { AgentsRunCard } from "./AgentsRunCard.tsx";
import { useT } from "../use-language.ts";
import { useShowCost } from "../use-show-cost.ts";

/** 折叠状态记在本地：用户收起来了就别再自作主张弹开 */
const OPEN_KEY = "agent-web:agents-strip-open";

export function AgentsRunStrip({ runs }: { runs: readonly SubagentRunView[] }) {
	const t = useT();
	const snapshot = useAppSelector((state) => state.snapshot);
	const [now, setNow] = useState(() => Date.now());
	/** 金额显不显示跟着本机偏好（手机默认不显示，见 use-show-cost.ts） */
	const showCost = useShowCost();
	const [open, setOpen] = useState(() => localStorage.getItem(OPEN_KEY) !== "0");

	/**
	 * 不额外看 `engineCapabilities.subagents`：调用方已经把「本轮有没有子代理」筛好了，
	 * 有运行记录就说明引擎支持 —— 多一道能力位只会在能力位过期时把真实数据藏起来。
	 */
	/**
	 * 本轮全部运行，新的在上（同批派发时看着还是原来的顺序）。
	 * 不再只取「最新一批」：跑完的那几张必须一直留在这儿，否则用户会以为记录被删了。
	 */
	const ordered = [...runs].sort((a, b) => b.startedAt - a.startedAt);
	const totals = totalsOf(ordered, now);
	const active = totals.running;
	/** 并发上限：排队卡片要说清楚「在等谁」，不能只写「排队中」 */
	const concurrency = snapshot?.subagentSettings?.concurrency ?? 4;
	/** 队列是先进先出，所以按开始时间排就能给出「第几位」（只是提示，不当作承诺） */
	const queuedHints = new Map<string, string>();
	ordered
		.filter((run) => run.status === "queued")
		.sort((a, b) => a.startedAt - b.startedAt)
		.forEach((run, index) => {
			queuedHints.set(run.id, `排队第 ${index + 1} 位 · 等前面跑完自动开（最多同时 ${concurrency} 个）`);
		});
	/** 有在跑的都要动：1 秒刷一次「多久了」，没有在跑的就不起定时器 */
	const live = active > 0;

	useEffect(() => {
		if (!open && !live) return;
		const timer = setInterval(() => setNow(Date.now()), live ? 1000 : 10_000);
		return () => clearInterval(timer);
	}, [open, live]);

	useEffect(() => {
		localStorage.setItem(OPEN_KEY, open ? "1" : "0");
	}, [open]);

	// 新开出来一个在跑的：自动展开（否则用户以为没动静；他已经手动收起过的情况也让位给"有活了"）
	const firstActiveId = runs.find(isActive)?.id ?? null;
	useEffect(() => {
		if (firstActiveId) setOpen(true);
	}, [firstActiveId]);

	// 切会话就是另一批子代理了：卡片收起来，别把上一个会话的结果留在屏幕上
	useEffect(() => {
		setOpen(localStorage.getItem(OPEN_KEY) !== "0");
	}, [snapshot?.active.conversationId]);

	if (ordered.length === 0) return null;

	return (
		<section className={`agents-strip${live ? " agents-strip-live" : ""}`} aria-label={t("当前会话的子代理")}>
			<header className="agents-strip-bar">
				<button
					type="button"
					className="agents-strip-toggle"
					onClick={() => setOpen((value) => !value)}
					aria-expanded={open}
					title={open ? "收起子代理卡片" : "展开子代理卡片"}
				>
					<svg
						viewBox="0 0 16 16"
						width="13"
						height="13"
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
					<span className="agents-strip-name">{t("子代理")}</span>
					<span className="agents-strip-count">{countsLabel(active, ordered.length)}</span>
					<svg
						className={`agents-strip-caret${open ? " agents-strip-caret-open" : ""}`}
						viewBox="0 0 16 16"
						width="12"
						height="12"
						fill="none"
						stroke="currentColor"
						strokeWidth={1.6}
						aria-hidden="true"
					>
						<path d="m4 6.4 4 4 4-4" strokeLinecap="round" strokeLinejoin="round" />
					</svg>
				</button>
				<span className="agents-strip-total" title={t("统计本轮全部子代理（含已完成的）")}>
					{totals.ms > 0 ? <>⏱ {durationMs(totals.ms)}</> : null}
					{totals.tokens > 0 ? (
						<>
							{totals.ms > 0 ? " · " : ""}
							{compact(totals.tokens)} tokens
						</>
					) : null}
					{showCost && totals.cost > 0 ? <> · {costText(totals.cost)}</> : null}
				</span>
			</header>
			{open ? (
				<ul className="agents-strip-cards">
					{ordered.map((run) => (
						<AgentsRunCard
							key={run.id}
							run={run}
							now={now}
							queueHint={queuedHints.get(run.id)}
							showCost={showCost}
						/>
					))}
				</ul>
			) : null}
		</section>
	);
}
