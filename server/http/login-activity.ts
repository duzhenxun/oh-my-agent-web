/**
 * 登录活动记录（设置 → 远程 里那一列）：谁从哪个 IP 试过、成没成、错了几次、什么时候被锁。
 *
 * 用户 2026-11-02：「远程里可以显示哪个 ip 登陆过、登错几次、登陆成功等信息，按时间最新的在最前面」。
 *
 * 几条刻意的取舍：
 *   1. **只记「真的比对过密码」的那两次结果**（成功 / 失败）和「刚被锁」这一件事。
 *      锁住之后的 429 不再入账 —— 否则爆破时每来一个请求就写一条，日志立刻变成噪音；
 *   2. 落盘（`<dataDir>/login-activity.json`，保留最近 N 条）：重启后还能看见「昨晚谁在试我的密码」；
 *   3. 写盘是同步的：这些事件的数量被登录锁**天然限制**（每个来源一个窗口最多 N 次），
 *      不会出现洪水式写盘 —— 换来的好处是不用调试时还要等一个 debounce 定时器。
 */
import { existsSync } from "node:fs";
import { readJsonObject, writeJsonObject } from "../util/json-file.js";

export type LoginActivityKind = "success" | "failure" | "locked";

export type LoginActivityEntry = {
	/** 毫秒时间戳 */
	at: number;
	/** 来源地址（可能是 X-Forwarded-For 里那个） */
	address: string;
	kind: LoginActivityKind;
	/** 失败时：这是连续第几次错 */
	attempts?: number;
	/** 被锁时：暂停多少分钟 */
	lockMinutes?: number;
};

const STORE_VERSION = 1;
/** 最多留多少条：一屏能看十几条，200 条够回溯好几天了 */
export const MAX_LOGIN_ACTIVITY = 200;

export type LoginActivity = {
	/** 记一条（时间默认取当下；测试里可以给） */
	record(entry: Omit<LoginActivityEntry, "at"> & { at?: number }): void;
	/** **最新的在最前面**（界面直接照着画） */
	list(): LoginActivityEntry[];
};

function readEntries(raw: unknown, limit: number): LoginActivityEntry[] {
	if (!Array.isArray(raw)) return [];
	const out: LoginActivityEntry[] = [];
	for (const item of raw) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const at = typeof record.at === "number" && Number.isFinite(record.at) ? record.at : 0;
		const address = typeof record.address === "string" ? record.address : "";
		const kind = record.kind;
		if (at <= 0 || address === "") continue;
		if (kind !== "success" && kind !== "failure" && kind !== "locked") continue;
		out.push({
			at,
			address,
			kind,
			...(typeof record.attempts === "number" ? { attempts: record.attempts } : {}),
			...(typeof record.lockMinutes === "number" ? { lockMinutes: record.lockMinutes } : {}),
		});
	}
	// 文件里是「新 → 旧」存的，读回来也按时间倒序，别信写入顺序
	return out.sort((a, b) => b.at - a.at).slice(0, limit);
}

export function createLoginActivity(
	options: { file?: string; now?: () => number; limit?: number } = {},
): LoginActivity {
	const clock = options.now ?? (() => Date.now());
	const limit = options.limit ?? MAX_LOGIN_ACTIVITY;
	/** 内存里始终是「新 → 旧」 */
	let entries: LoginActivityEntry[] = [];

	if (options.file && existsSync(options.file)) {
		const loaded = readJsonObject(options.file);
		if ("json" in loaded) entries = readEntries(loaded.json.entries, limit);
		// 坏文件不硬修（`json-file` 的规矩）：这次当空表用，下次记录时才覆盖
	}

	return {
		record(entry) {
			const next: LoginActivityEntry = {
				at: entry.at ?? clock(),
				address: entry.address,
				kind: entry.kind,
				...(entry.attempts !== undefined ? { attempts: entry.attempts } : {}),
				...(entry.lockMinutes !== undefined ? { lockMinutes: entry.lockMinutes } : {}),
			};
			entries = [next, ...entries].slice(0, limit);
			if (!options.file) return;
			try {
				writeJsonObject(options.file, { version: STORE_VERSION, entries });
			} catch {
				// 写不进去不该影响登录本身：内存里这份照样能在界面上看到
			}
		},
		list: () => entries.map((entry) => ({ ...entry })),
	};
}
