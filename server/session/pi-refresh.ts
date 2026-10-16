/**
 * pi 会话列表的刷新节奏（ADR-0021 §1）——从 runtime 拆出（400 行护栏第七次咬人）。
 *
 * 为什么要有最小间隔：扫描 247 个会话（首扫 ~1s）不能每次刷新页面都跑一遍；
 * 但首次必须立刻扫（否则侧栏空白）。缓存由扫描器负责（path+mtime），这里只管节奏。
 */
import type { PiProject } from "../protocol.js";

export type PiRefresher = {
	/** force = 忽略最小间隔（启动与 get_state 用） */
	refresh: (force?: boolean) => Promise<void>;
	/** 最近一次扫描时间（诊断用） */
	lastScannedAt: () => number;
};

export type PiRefresherOptions = {
	list: () => Promise<PiProject[]>;
	minIntervalMs?: number;
	now: () => number;
	onLoaded: (projects: PiProject[]) => void;
	onError: (message: string) => void;
};

export function createPiRefresher(options: PiRefresherOptions): PiRefresher {
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
					options.onError(`读取 pi 已有会话失败：${error instanceof Error ? error.message : String(error)}`);
				} finally {
					inFlight = null;
				}
			})();
			return inFlight;
		},
		lastScannedAt: () => lastScannedAt,
	};
}
