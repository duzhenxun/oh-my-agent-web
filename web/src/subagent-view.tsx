/**
 * 子代理的显示口径（面板与顶栏浮层共用，避免两处各写一套）。
 *
 * 纯函数 + 两个小图标组件：这里的数字要能对得上 —— 同一个运行在「顶栏浮层」和
 * 「面板」里显示的耗时 / token / 花费必须是同一份计算。
 */
import type { SubagentRunView, SubagentStatus } from "./types.ts";

export const STATUS_LABEL: Record<SubagentStatus, string> = {
	queued: "排队中",
	running: "运行中",
	completed: "已完成",
	failed: "失败",
	aborted: "已停止",
};

const ACTIVE_STATUSES: SubagentStatus[] = ["queued", "running"];
export function isActive(run: SubagentRunView): boolean {
	return ACTIVE_STATUSES.includes(run.status);
}

export function relativeTime(at: number, now: number): string {
	const seconds = Math.max(0, Math.round((now - at) / 1000));
	if (seconds < 60) return `${seconds} 秒前`;
	const minutes = Math.round(seconds / 60);
	if (minutes < 60) return `${minutes} 分钟前`;
	const hours = Math.round(minutes / 60);
	if (hours < 24) return `${hours} 小时前`;
	return `${Math.round(hours / 24)} 天前`;
}

/** 一次运行的耗时（没结束就算到现在）：`12s` / `1m57s` / `1h03m` */
export function duration(run: SubagentRunView, now: number): string {
	const end = run.endedAt ?? now;
	const seconds = Math.max(0, Math.round((end - run.startedAt) / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 1500 → 1.5k；145000 → 145k；2_400_000 → 2.4M */
export function compact(value: number): string {
	if (value < 1000) return String(value);
	if (value < 1_000_000) return `${(value / 1000).toFixed(value < 10_000 ? 1 : 0)}k`;
	return `${(value / 1_000_000).toFixed(1)}M`;
}

/** 花费：小于 1 分也要看得见（$0.002 这种），大于 1 块就不用三位小数了 */
export function costText(cost: number): string {
	// 便宜的模型一次调用往往不到 1 厘：显示成 $0.000 会让人以为没花钱
	if (cost > 0 && cost < 0.001) return "<$0.001";
	return cost >= 1 ? `$${cost.toFixed(2)}` : `$${cost.toFixed(3)}`;
}

type SubagentTotals = {
	/** 在跑（含排队）的条数 */
	running: number;
	/** 所有记录的耗时之和（含仍在跑的按至今算） */
	ms: number;
	tokens: number;
	cost: number;
};

export function totalsOf(runs: readonly SubagentRunView[], now: number): SubagentTotals {
	let ms = 0;
	let tokens = 0;
	let cost = 0;
	let running = 0;
	for (const run of runs) {
		if (isActive(run)) running += 1;
		ms += Math.max(0, (run.endedAt ?? now) - run.startedAt);
		tokens += run.tokens?.total ?? 0;
		cost += run.cost ?? 0;
	}
	return { running, ms, tokens, cost };
}

/**
 * 这一轮子代理的用量合计（消息尾注用）。
 *
 * 为什么需要它：引擎只把**主会话**的 usage 报给宿主（`turn-events` 的 `usage` 事件），
 * 子代理各自是独立会话、独立计费 —— 两份数字天然不在一本账里。
 * 尾注上那行 `in / out / cache / $` **不含**子代理，所以要把这堆单独列出来，
 * 否则用户按尾注估成本会严重低估（子代理常常比主对话还贵）。
 */
type SubagentUsage = { count: number; input: number; output: number; total: number; cost: number };

export function subagentUsageOf(runs: readonly SubagentRunView[]): SubagentUsage {
	const usage: SubagentUsage = { count: 0, input: 0, output: 0, total: 0, cost: 0 };
	for (const run of runs) {
		usage.count += 1;
		usage.input += run.tokens?.input ?? 0;
		usage.output += run.tokens?.output ?? 0;
		usage.total += run.tokens?.total ?? 0;
		usage.cost += run.cost ?? 0;
	}
	return usage;
}

/**
 * 把运行记录按「轮次」分组（最新一轮在前）。
 *
 * 为什么要分：会话保留最近 30 条历史（跨轮次累积），但卡片条平铺出来会让人
 * 误以为「一次开了 8 个」——并发上限其实只有 4。同一轮并行派发的几个开始时间
 * 几乎同时（几秒内），所以用「开始时间间隔超过 30 秒」切组就够了。
 */
const BATCH_GAP_MS = 30_000;

export function batchesOf(runs: readonly SubagentRunView[], gapMs = BATCH_GAP_MS): SubagentRunView[][] {
	const sorted = [...runs].sort((a, b) => b.startedAt - a.startedAt);
	const groups: SubagentRunView[][] = [];
	for (const run of sorted) {
		const current = groups[groups.length - 1];
		const anchor = current?.[current.length - 1];
		if (current && anchor && anchor.startedAt - run.startedAt <= gapMs) current.push(run);
		else groups.push([run]);
	}
	return groups;
}

/**
 * 本轮的开始时间 = **最后一条用户消息**的时间。
 *
 * 子代理记录在快照里是**跨轮次累积**的（每会话留最近 30 条）。以前顶栏徽标与卡片条
 * 都直接铺「最近一批」，于是发完新问题之后，上一问的子代理还挂在那儿 ——
 * 看起来像是「这一问又跑了一遍」。按「用户消息之后」切，问题一换它们就自然退场。
 */
export function turnStartedAtOf(messages: readonly { role: string; ts: number }[]): number | null {
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const item = messages[index];
		if (item && item.role === "user") return Number.isFinite(item.ts) ? item.ts : null;
	}
	return null;
}

/**
 * 把运行记录分配给「它属于的那条助手消息」。
 *
 * 为什么要分配而不是全都铺在最后一条消息上：后一轮再派子代理时，卡片必须在对话流里
 * **新长出一块**，而不是把上一轮那块挪过来 / 顶掉。分配保证「一条运行只属于一条消息」，
 * 旧轮次的卡片就永久留在它当时的位置（历史），新一轮自然在下面新开一块。
 *
 * 找宿主消息分两步（以前只有第二步，于是**重开历史会话后已完成的卡片会整块消失**）：
 *   1. 轮次配对（主）：最后一条开始时间不晚于这个运行的**用户消息**之后的第一条助手消息 ——
 *      这一轮的回答就是它的宿主。历史会话里的助手 `ts` 是整条消息的**完成时间**，
 *      可能晚于子代理开始时间，只按时间戳比就配不上，卡片会掉到上一轮或干脆不渲染。
 *   2. 时间戳兜底：用户消息被分页切掉时，取开始时间不晚于它的最后一条助手消息。
 *
 * 两步都不成立（运行早于所有已加载消息，且前面连一条用户消息都没有）→ 不渲染，
 * 免得卡片凭空出现在第一条消息下面。
 */
export function assignRunsToMessages(
	runs: readonly SubagentRunView[],
	messages: readonly { id: string; role: string; ts: number }[],
): Map<string, SubagentRunView[]> {
	const assigned = new Map<string, SubagentRunView[]>();
	if (runs.length === 0) return assigned;
	const timed = messages.filter((item) => Number.isFinite(item.ts));
	const assistants = timed.filter((item) => item.role === "assistant");

	/**
	 * 这一轮的回答：最后一条不晚于 `at` 的用户消息之后、下一条用户消息之前的那批助手消息。
	 *
	 * 取**最后一条**：一轮里如果拆成了多条助手消息（历史上未合并的会话），卡片落在本轮末尾
	 * 才稳定 —— 挂中间那条时，下一条一出现卡片就往下“游”，看着像凭空冒出来。
	 */
	const answerOfTurnAt = (at: number): { id: string; ts: number } | null => {
		let userIndex = -1;
		for (let index = timed.length - 1; index >= 0; index -= 1) {
			const item = timed[index];
			if (item && item.role === "user" && item.ts <= at) {
				userIndex = index;
				break;
			}
		}
		// 没有这一轮的用户消息（分页 / 隐藏回合）：交给时间戳兜底，别猜
		if (userIndex < 0) return null;
		let answer: { id: string; ts: number } | null = null;
		for (let index = userIndex + 1; index < timed.length; index += 1) {
			const item = timed[index];
			if (!item || item.role === "user") break;
			if (item.role === "assistant") answer = item;
		}
		return answer;
	};

	for (const run of runs) {
		let host = answerOfTurnAt(run.startedAt);
		if (host === null) {
			for (const item of assistants) {
				if (item.ts > run.startedAt) continue;
				if (host === null || item.ts >= host.ts) host = item;
			}
		}
		if (host === null) continue;
		const list = assigned.get(host.id);
		if (list) list.push(run);
		else assigned.set(host.id, [run]);
	}
	return assigned;
}

/** 只留**本轮**派出去的：顶栏徽标、卡片条、消息内嵌卡片全都用这一口径 */
export function runsOfCurrentTurn(runs: readonly SubagentRunView[], turnStartedAt: number | null): SubagentRunView[] {
	if (turnStartedAt === null) return [];
	return runs.filter((run) => run.startedAt >= turnStartedAt);
}

/**
 * 卡片条 / 徽标上那句「几个在跑」：口径统一，别两处各写一套文案。
 *
 * 只报**本轮**（最近一批）：会话保留的是历史记录（每会话 30 条，跨轮次累积），
 * 把总数写进标题会被读成「一次开了 8 个」。旧轮次不在这条横条上翻，去「子代理」面板里看。
 */
export function countsLabel(active: number, latest: number): string {
	if (active > 0) return `${active} 个在跑`;
	return `${latest} 个已结束`;
}

/** 毫秒 → `1m57s`（合计行用，和单条同样的读法） */
export function durationMs(ms: number): string {
	const seconds = Math.max(0, Math.round(ms / 1000));
	if (seconds < 60) return `${seconds}s`;
	const minutes = Math.floor(seconds / 60);
	if (minutes < 60) return `${minutes}m${String(seconds % 60).padStart(2, "0")}s`;
	return `${Math.floor(minutes / 60)}h${String(minutes % 60).padStart(2, "0")}m`;
}

/** 状态点：运行中/排队转圈，完成对勾，失败/中止叉 */
export function StatusDot({ status }: { status: SubagentStatus }) {
	if (isActiveStatus(status)) {
		return (
			<svg className="agents-spin" viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
				<circle cx="8" cy="8" r="6.2" fill="none" stroke="currentColor" strokeWidth="1.6" opacity="0.28" />
				<path
					d="M14.2 8A6.2 6.2 0 0 0 8 1.8"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.6"
					strokeLinecap="round"
				/>
			</svg>
		);
	}
	return (
		<svg viewBox="0 0 16 16" width="13" height="13" aria-hidden="true">
			{status === "completed" ? (
				<path
					d="m3.6 8.4 3 3 5.4-6.4"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.7"
					strokeLinecap="round"
					strokeLinejoin="round"
				/>
			) : (
				<path
					d="M4.6 4.6l6.8 6.8M11.4 4.6l-6.8 6.8"
					fill="none"
					stroke="currentColor"
					strokeWidth="1.7"
					strokeLinecap="round"
				/>
			)}
		</svg>
	);
}

function isActiveStatus(status: SubagentStatus): boolean {
	return ACTIVE_STATUSES.includes(status);
}
