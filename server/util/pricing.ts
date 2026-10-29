/**
 * 分时价格（模型计费的扩展，ADR-0026 D 期）。
 *
 * 为什么需要：有的厂商按时段定价（高峰期 / 低峰期），一天里切成好几段，
 * 同一百万 tokens 的钱在不同时段不一样。pi 的模型表只认「一个模型一套价」，
 * 它算出来的 cost 在这些厂商身上必然是错的 —— 所以这里多存一张「时段 → 价格」表，
 * 由**我们自己**按调用发生的时刻挑价格（引擎给的 cost 只在没配时段时兜底）。
 *
 * 约定（都写进界面提示里，别让用户猜）：
 *   - `start` 必填，`end` 可空：空 = 一直用到**下一段**开始（最后一段跨零点回到最早那段）；
 *   - `start > end` 表示跨零点（22:00–02:00）；
 *   - 段内的价格字段可以留空：留空 = 沿用模型的「全天价格」（配置里那份 cost）；
 *   - 时间按**本机时区**解释（界面显示什么就是什么，不做 UTC 换算）；
 *   - 没配时段 = 全天一个价（既有行为完全不变）。
 *
 * 这一层是纯函数：不读文件、不看时钟（时间一律由调用方传 `atMs`），结果完全确定。
 */

/** 每百万 tokens 的价格（美元）—— 与 pi 的 `cost` 字段同口径 */
export type PricePerMillion = { input: number; output: number; cacheRead: number; cacheWrite: number };
type PriceField = keyof PricePerMillion;

const PRICE_FIELDS: PriceField[] = ["input", "output", "cacheRead", "cacheWrite"];

/** 一段分时价格：从 `start` 起用这套价；段内空着的字段沿用全天价 */
export type PriceSegment = {
	/** 起始时间 `HH:MM`（本机时区） */
	start: string;
	/** 结束时间 `HH:MM`；不填 = 到下一段开始（最后一段跨零点） */
	end?: string;
	input?: number;
	output?: number;
	cacheRead?: number;
	cacheWrite?: number;
};

/** 一个模型的时段表（按 start 升序） */
export type CostSchedule = PriceSegment[];

const MAX_PRICE_SEGMENTS = 32;
const MINUTES_PER_DAY = 1440;

/** 纯函数：`HH:MM`（也认 `H:MM` / `HH:MM:SS`，秒直接丢掉）→ 当天第几分钟；不合法返回 null */
function parseClock(raw: unknown): number | null {
	if (typeof raw !== "string") return null;
	// 秒可有可无：浏览器 / 系统给的 time 值不统一（有的会带秒），
	// 在这儿报「必须是 HH:MM」只会让用户莫名其妙
	const match = /^(\d{1,2}):(\d{2})(?::\d{2}(?:\.\d+)?)?$/.exec(raw.trim());
	if (!match) return null;
	const hours = Number(match[1]);
	const minutes = Number(match[2]);
	if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
	if (hours > 23 || minutes > 59) return null;
	return hours * 60 + minutes;
}

/** 纯函数：分钟 → `HH:MM`（界面/日志用） */
function formatClock(minutes: number): string {
	const normalized = ((Math.round(minutes) % MINUTES_PER_DAY) + MINUTES_PER_DAY) % MINUTES_PER_DAY;
	const hours = Math.floor(normalized / 60);
	return `${String(hours).padStart(2, "0")}:${String(normalized % 60).padStart(2, "0")}`;
}

/** 纯函数：某一时刻是当天第几分钟（本机时区） */
function minutesOfDay(atMs: number): number {
	const date = new Date(atMs);
	return date.getHours() * 60 + date.getMinutes();
}

/** 展开后的一段（end 已换算成「start 之后的分钟数」，可以 > 1440） */
type PriceWindow = { segment: PriceSegment; start: number; end: number };

/**
 * 纯函数：把时段表展开成 `[start, end)` 窗口。
 *
 * 没填 end 的段落到下一段开始；**最后一段**落到最早那段的开始（跨零点回去），
 * 这样「只填几个低峰窗口的起点」也能表达完整的 24 小时。
 */
function windowsOf(schedule: CostSchedule): PriceWindow[] {
	const parsed: Array<{ segment: PriceSegment; start: number }> = [];
	for (const segment of schedule) {
		const start = parseClock(segment.start);
		if (start === null) continue;
		parsed.push({ segment, start });
	}
	parsed.sort((left, right) => left.start - right.start);
	return parsed.map((item, index) => {
		const explicit = parseClock(item.segment.end);
		if (item.segment.end !== undefined && item.segment.end !== "" && explicit !== null) {
			// 结束早于/等于开始 = 跨零点（22:00–02:00）
			return { ...item, end: explicit > item.start ? explicit : explicit + MINUTES_PER_DAY };
		}
		const next =
			index + 1 < parsed.length
				? (parsed[index + 1] as { start: number }).start
				: (parsed[0] as { start: number }).start + MINUTES_PER_DAY;
		return { ...item, end: next > item.start ? next : next + MINUTES_PER_DAY };
	});
}

/**
 * 纯函数：`atMs` 这一刻生效的那一段。
 *
 * 没配时段 / 这一刻没有任何段覆盖 → null（调用方用全天价）。
 * 段与段重叠时**起点更晚的那段优先**（更具体的配置赢）。
 */
function activeSegment(schedule: CostSchedule | null | undefined, atMs: number): PriceSegment | null {
	if (!schedule || schedule.length === 0) return null;
	const minutes = minutesOfDay(atMs);
	let best: PriceWindow | null = null;
	let bestOrder = Number.NEGATIVE_INFINITY;
	for (const window of windowsOf(schedule)) {
		// 跨零点的窗口（end > 1440）要把「明天的这份分钟数」也算一遍
		const covered =
			(minutes >= window.start && minutes < window.end) ||
			(minutes + MINUTES_PER_DAY >= window.start && minutes + MINUTES_PER_DAY < window.end);
		if (!covered) continue;
		const order = window.start <= minutes ? window.start : window.start - MINUTES_PER_DAY;
		if (order > bestOrder) {
			bestOrder = order;
			best = window;
		}
	}
	return best ? best.segment : null;
}

/** 纯函数：把 cost 字段收敛成价格（驼峰 / 下划线都认；一个数都没有 → null） */
export function normalizePrice(raw: unknown): PricePerMillion | null {
	if (typeof raw !== "object" || raw === null) return null;
	const record = raw as Record<string, unknown>;
	const number = (field: PriceField): number | null => {
		const snake = field.replace(/[A-Z]/g, (char) => `_${char.toLowerCase()}`);
		const value = record[field] ?? record[snake];
		return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : null;
	};
	const input = number("input");
	const output = number("output");
	const cacheRead = number("cacheRead");
	const cacheWrite = number("cacheWrite");
	if (input === null && output === null && cacheRead === null && cacheWrite === null) return null;
	return { input: input ?? 0, output: output ?? 0, cacheRead: cacheRead ?? 0, cacheWrite: cacheWrite ?? 0 };
}

/**
 * 纯函数：`atMs` 这一刻该用的价格。
 *
 * 段内没填的字段 → 全天价（`base`）；全天价也没有 → 0（这一项不收费，和 pi 的口径一致）。
 * 段表和全天价都拿不到 → null（调用方保留引擎给的 cost）。
 */
export function priceAt(
	schedule: CostSchedule | null | undefined,
	base: PricePerMillion | null | undefined,
	atMs: number,
): PricePerMillion | null {
	const segment = activeSegment(schedule, atMs);
	if (!segment && !base) return null;
	const pick = (field: PriceField): number => {
		const value = segment?.[field];
		if (typeof value === "number" && Number.isFinite(value) && value >= 0) return value;
		return base?.[field] ?? 0;
	};
	return { input: pick("input"), output: pick("output"), cacheRead: pick("cacheRead"), cacheWrite: pick("cacheWrite") };
}

export type UsageTokens = { input: number; output: number; cacheRead: number; cacheWrite: number };

/** 纯函数：一次调用（或一轮合计）花多少钱（美元）。价格是「每百万 tokens」 */
export function costOfUsage(usage: UsageTokens, price: PricePerMillion): number {
	const tokens = (value: number) => (Number.isFinite(value) && value > 0 ? value : 0);
	const total =
		tokens(usage.input) * price.input +
		tokens(usage.output) * price.output +
		tokens(usage.cacheRead) * price.cacheRead +
		tokens(usage.cacheWrite) * price.cacheWrite;
	return total / 1_000_000;
}

/**
 * 纯函数：把配置里的原始值校验 + 收敛成时段表。
 *
 * 一次收集**全部**问题（前端的表单是手填的，挤牙膏式试错太烦）。
 * 空数组 / 没填 = null（= 全天一个价）。
 */
export function validateSchedule(
	raw: unknown,
	label = "分时价格",
): { ok: true; value: CostSchedule | null } | { ok: false; errors: string[] } {
	if (raw === undefined || raw === null) return { ok: true, value: null };
	if (!Array.isArray(raw)) return { ok: false, errors: [`${label}必须是数组`] };
	if (raw.length === 0) return { ok: true, value: null };
	if (raw.length > MAX_PRICE_SEGMENTS) return { ok: false, errors: [`${label}最多 ${MAX_PRICE_SEGMENTS} 段`] };

	const errors: string[] = [];
	const seen = new Set<number>();
	const segments: CostSchedule = [];

	raw.forEach((item, index) => {
		const position = index + 1;
		if (typeof item !== "object" || item === null) {
			errors.push(`第 ${position} 段不是对象`);
			return;
		}
		const record = item as Record<string, unknown>;
		const start = parseClock(record.start);
		if (start === null) {
			errors.push(`第 ${position} 段起始时间必须是 HH:MM`);
			return;
		}
		if (seen.has(start)) errors.push(`${formatClock(start)} 这个起始时间填了两次`);
		seen.add(start);

		const segment: PriceSegment = { start: formatClock(start) };
		const rawEnd = record.end;
		if (rawEnd !== undefined && rawEnd !== null && rawEnd !== "") {
			const end = parseClock(rawEnd);
			if (end === null) errors.push(`第 ${position} 段结束时间必须是 HH:MM（留空 = 到下一段开始）`);
			else if (end === start) errors.push(`第 ${position} 段结束时间和起始时间相同`);
			else segment.end = formatClock(end);
		}
		for (const field of PRICE_FIELDS) {
			const value = record[field];
			if (value === undefined || value === null || value === "") continue;
			const number = typeof value === "number" ? value : Number(String(value).trim());
			if (!Number.isFinite(number) || number < 0) {
				errors.push(`第 ${position} 段${PRICE_LABELS[field]}必须是非负数（留空 = 沿用全天价）`);
				continue;
			}
			segment[field] = number;
		}
		segments.push(segment);
	});

	if (errors.length > 0) return { ok: false, errors };
	segments.sort((left, right) => (parseClock(left.start) ?? 0) - (parseClock(right.start) ?? 0));
	return { ok: true, value: segments.length > 0 ? segments : null };
}

const PRICE_LABELS: Record<PriceField, string> = {
	input: "输入价格",
	output: "输出价格",
	cacheRead: "缓存读价格",
	cacheWrite: "缓存写价格",
};
