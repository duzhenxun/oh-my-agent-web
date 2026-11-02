/**
 * 登录失败节流（挡在线爆破）：**同一来源连续输错 N 次 → 暂停 M 分钟**。
 *
 * 用户 2026-11-02 的要求：默认「3 次 / 30 分钟」，次数与时长可以在 设置 → 远程 里改。
 *
 * 为什么单独成一个模块（而不是继续写在 `auth-routes.ts` 里）：
 *   1. 这块逻辑要能单测 —— 时间注入进来，不用真的等 30 分钟；
 *   2. 它要**落盘**（重启之后锁还在），而路由文件里已经混着密码、cookie、HTML 登录页三件事；
 *   3. 语义要说清：以前的实现是「10 分钟内失败 20 次就拒收」，等于**不会锁**，只是把门槛抬高；
 *      现在是真的锁一段时间。
 *
 * 规则细节（都是刻意的）：
 *   - **按来源（IP）分开记**：一个人输错不该把别人挡在外面；反过来，隧道/反代后面所有请求
 *     可能是同一个 IP，那就一起锁 —— 这是 `auth.ts` 早就有的取舍（它就是这么算来源的）；
 *   - 计数窗口 = 锁定时长：所谓「连续」就是这段时间里累计的次数，过期自动归零；
 *   - **到达上限的那一次就锁**（第 3 次输错返回的不再是 401，而是「已暂停 30 分钟」）；
 *   - 登录成功、改密码 → 清掉这个来源的计数与锁；
 *   - 失败计数只在内存（重启归零可以接受），但**锁落盘** —— 否则被爆破时把进程搞挂一次就解锁了。
 */
import { existsSync } from "node:fs";
import { readJsonObject, writeJsonObject } from "../util/json-file.js";

export type LoginGuardPolicy = { maxFailures: number; lockMinutes: number };

/** 默认：连续错 3 次，暂停 30 分钟（用户定的默认值） */
export const DEFAULT_LOGIN_GUARD: LoginGuardPolicy = { maxFailures: 3, lockMinutes: 30 };

/** 可填范围（挡住「0 次」「暂停 100 年」这类把服务锁死的输入） */
export const LOGIN_GUARD_RANGE = {
	maxFailures: { min: 1, max: 20 },
	lockMinutes: { min: 1, max: 1440 },
} as const;

/** 同时跟踪的来源上限：只挡脏 IP 把 Map 撑大，不清会把内存吃光 */
const MAX_TRACKED_SOURCES = 512;
const STORE_VERSION = 1;

export type LoginGuardStatus = {
	locked: boolean;
	/** 还要等多少秒（没锁就是 0） */
	retryAfterSeconds: number;
	/** 当前窗口内已经错了几次 */
	failures: number;
	/** 再错几次就被锁（锁住时是 0） */
	remainingAttempts: number;
};

type FailureRecord = { count: number; resetAt: number };

function clampInt(value: unknown, range: { min: number; max: number }): number | null {
	if (typeof value !== "number" || !Number.isFinite(value)) return null;
	const rounded = Math.round(value);
	return rounded < range.min || rounded > range.max ? null : rounded;
}

/** 把任意输入收敛成合法策略（读坏文件 / 老版本文件时用；**不**给用户看这个宽松行为） */
export function normalizeLoginGuardPolicy(
	input: unknown,
	fallback: LoginGuardPolicy = DEFAULT_LOGIN_GUARD,
): LoginGuardPolicy {
	const source = input !== null && typeof input === "object" ? (input as Record<string, unknown>) : {};
	return {
		maxFailures: clampInt(source.maxFailures, LOGIN_GUARD_RANGE.maxFailures) ?? fallback.maxFailures,
		lockMinutes: clampInt(source.lockMinutes, LOGIN_GUARD_RANGE.lockMinutes) ?? fallback.lockMinutes,
	};
}

export type LoginGuard = {
	policy(): LoginGuardPolicy;
	/** 校验 + 落盘。给了非法值就报错（不静默改成默认值 —— 用户会以为存上了） */
	setPolicy(patch: unknown): { ok: true; policy: LoginGuardPolicy } | { ok: false; error: string };
	status(address: string): LoginGuardStatus;
	/** 记一次失败；到上限就锁，返回**记账之后**的状态 */
	noteFailure(address: string): LoginGuardStatus;
	/** 这个来源登录成功 / 已经放行：计数与锁一起清掉 */
	clear(address: string): void;
	/** 改密码这类全局动作：所有来源一起放开 */
	clearAll(): void;
};

export function createLoginGuard(options: { file?: string; now?: () => number } = {}): LoginGuard {
	const clock = options.now ?? (() => Date.now());
	let policy: LoginGuardPolicy = { ...DEFAULT_LOGIN_GUARD };
	const failures = new Map<string, FailureRecord>();
	let locks = new Map<string, number>();

	/** 读一次盘：策略 + 仍在生效的锁（过期锁顺手丢掉） */
	if (options.file && existsSync(options.file)) {
		const loaded = readJsonObject(options.file);
		if ("json" in loaded) {
			policy = normalizeLoginGuardPolicy(loaded.json);
			const now = clock();
			const raw = loaded.json.locks;
			if (Array.isArray(raw)) {
				for (const entry of raw) {
					if (entry === null || typeof entry !== "object") continue;
					const record = entry as Record<string, unknown>;
					const address = typeof record.address === "string" ? record.address : "";
					const until = typeof record.until === "number" && Number.isFinite(record.until) ? record.until : 0;
					if (address !== "" && until > now) locks.set(address, until);
				}
			}
		}
		// 坏文件不硬修（`json-file` 的规矩）：这次就当默认值用，等真正保存策略时才覆盖它
	}

	const persist = (): void => {
		if (!options.file) return;
		try {
			writeJsonObject(options.file, {
				version: STORE_VERSION,
				maxFailures: policy.maxFailures,
				lockMinutes: policy.lockMinutes,
				locks: [...locks].map(([address, until]) => ({ address, until })),
			});
		} catch {
			// 落盘失败不该让登录流程挂掉：内存里的策略与锁照常生效，只是「重启后还记得」这条丢了
		}
	};

	const windowMs = (): number => policy.lockMinutes * 60_000;

	/** 过期锁顺手清掉（Map 只增不减的话，长时间运行会越积越多） */
	const prune = (now: number): void => {
		for (const [address, until] of locks) if (until <= now) locks.delete(address);
	};

	const status = (address: string): LoginGuardStatus => {
		const now = clock();
		prune(now);
		const until = locks.get(address);
		if (until !== undefined && until > now) {
			return {
				locked: true,
				retryAfterSeconds: Math.ceil((until - now) / 1000),
				failures: policy.maxFailures,
				remainingAttempts: 0,
			};
		}
		const record = failures.get(address);
		if (!record || now > record.resetAt) {
			failures.delete(address);
			return { locked: false, retryAfterSeconds: 0, failures: 0, remainingAttempts: policy.maxFailures };
		}
		return {
			locked: false,
			retryAfterSeconds: 0,
			failures: record.count,
			remainingAttempts: Math.max(0, policy.maxFailures - record.count),
		};
	};

	return {
		policy: () => ({ ...policy }),
		status,

		setPolicy(patch) {
			const source = patch !== null && typeof patch === "object" ? (patch as Record<string, unknown>) : {};
			const next = { ...policy };
			if (source.maxFailures !== undefined) {
				const value = clampInt(source.maxFailures, LOGIN_GUARD_RANGE.maxFailures);
				if (value === null) {
					const { min, max } = LOGIN_GUARD_RANGE.maxFailures;
					return { ok: false, error: `失败次数要在 ${min}–${max} 之间` };
				}
				next.maxFailures = value;
			}
			if (source.lockMinutes !== undefined) {
				const value = clampInt(source.lockMinutes, LOGIN_GUARD_RANGE.lockMinutes);
				if (value === null) {
					const { min, max } = LOGIN_GUARD_RANGE.lockMinutes;
					return { ok: false, error: `暂停时长要在 ${min}–${max} 分钟之间` };
				}
				next.lockMinutes = value;
			}
			policy = next;
			// 策略变了，已经数到一半的计数按新窗口重算没有意义：直接清空，避免「改完更严了还留着旧次数」
			failures.clear();
			persist();
			return { ok: true, policy: { ...policy } };
		},

		noteFailure(address) {
			const now = clock();
			const current = failures.get(address);
			const record: FailureRecord =
				!current || now > current.resetAt
					? { count: 1, resetAt: now + windowMs() }
					: { count: current.count + 1, resetAt: current.resetAt };
			failures.set(address, record);
			if (failures.size > MAX_TRACKED_SOURCES) {
				for (const [key, value] of failures) if (now > value.resetAt) failures.delete(key);
			}
			if (record.count >= policy.maxFailures) {
				failures.delete(address);
				locks.set(address, now + windowMs());
				persist();
			}
			return status(address);
		},

		clear(address) {
			const hadLock = locks.delete(address);
			failures.delete(address);
			if (hadLock) persist();
		},

		clearAll() {
			const hadLock = locks.size > 0;
			locks = new Map();
			failures.clear();
			if (hadLock) persist();
		},
	};
}

/** 「还要等多久」给人看的写法（登录页 / 429 文案共用） */
export function describeLockout(status: LoginGuardStatus): string {
	const minutes = Math.ceil(status.retryAfterSeconds / 60);
	const unit = minutes >= 60 ? `${Math.ceil(minutes / 60)} 小时` : `${minutes} 分钟`;
	return `密码错误次数过多，请 ${unit}后再试`;
}
