/**
 * pi 会话列表的刷新节奏（ADR-0021 §1）——从 runtime 拆出（400 行护栏第七次咬人）。
 *
 * 为什么要有最小间隔：扫描 247 个会话（首扫 ~1s）不能每次刷新页面都跑一遍；
 * 但首次必须立刻扫（否则侧栏空白）。缓存由扫描器负责（path+mtime），这里只管节奏。
 */
import type { PiProject } from "../protocol.js";
import { setPiProjects } from "../snapshot/state.js";
import type { ServerState } from "../snapshot/state.js";

type PiRefresher = {
	/** force = 忽略最小间隔（启动与 get_state 用） */
	refresh: (force?: boolean) => Promise<void>;
	/** 最近一次扫描时间（诊断用） */
	lastScannedAt: () => number;
};

type PiRefresherOptions = {
	list: () => Promise<PiProject[]>;
	minIntervalMs?: number;
	now: () => number;
	onLoaded: (projects: PiProject[]) => void;
	onError: (message: string) => void;
};

function createPiRefresher(options: PiRefresherOptions): PiRefresher {
	const minIntervalMs = options.minIntervalMs ?? 10_000;
	let lastScannedAt = Number.NEGATIVE_INFINITY;
	let inFlight: Promise<void> | null = null;

	return {
		async refresh(force = false) {
			const stamp = options.now();
			if (!force && stamp - lastScannedAt < minIntervalMs) return;
			if (inFlight) return inFlight; // 并发刷新合并成一次
			lastScannedAt = stamp;
			inFlight = (async () => {
				try {
					options.onLoaded(await options.list());
				} catch (error) {
					// 扫不到（pi 没装 / 目录被删）不该影响主流程
					options.onError(`读取历史会话失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					inFlight = null;
				}
			})();
			return inFlight;
		},
		lastScannedAt: () => lastScannedAt,
	};
}

/**
 * 会话清单刷新器（ADR-0021 §1）+ 可替换的「清单来源」。
 *
 * 切引擎时来源要跟着换（pi 扫磁盘 / 未来 codex 问 app-server），但**刷新节奏与缓存逻辑
 * 完全相同**，所以来源放进一个可变槽，refresher 本身只建一次。
 */
export function createSessionsRefresher(options: {
	initial: (() => Promise<PiProject[]>) | null;
	state: ServerState;
	minIntervalMs?: number;
	now: () => number;
	remember: (projects: PiProject[]) => void;
	onChanged: () => void;
	onError: (message: string) => void;
}): { slot: { current: (() => Promise<PiProject[]>) | null }; refresh: (force?: boolean) => Promise<void> } {
	const slot: { current: (() => Promise<PiProject[]>) | null } = { current: options.initial };
	const refresher = createPiRefresher({
		list: () => slot.current?.() ?? Promise.resolve([]),
		minIntervalMs: options.minIntervalMs,
		now: options.now,
		onLoaded: (projects) => {
			setPiProjects(options.state, projects);
			options.remember(projects); // 记下每个会话的文件路径（ADR-0021 §2）
			options.onChanged();
		},
		onError: options.onError,
	});
	return { slot, refresh: (force) => refresher.refresh(force) };
}
