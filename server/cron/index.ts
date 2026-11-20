import express, { type Response, type Router } from "express";
import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join, isAbsolute } from "node:path";

export type CronStatus = "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped";
export type CronTrigger = "manual" | "scheduled";
/**
 * 任务类型：
 *   - `text`：直连模型做一次文本补全（无工具、不读文件、不改仓库）；
 *   - `agent`：在工作区里真开一个会话跑一遍提示词（能读文件、跑命令、改代码）。
 *
 * 老任务没有这个字段时按 `text` 处理（新建时会被规范化写入）。
 */
export type CronMode = "text" | "agent";
export type CronJob = {
	id: string;
	name: string;
	workspace: string;
	prompt: string;
	expression: string;
	timezone: string;
	enabled: boolean;
	mode?: CronMode;
	/** 只有 agent 任务有意义：允许改动工作区（默认 false = 只读） */
	allowWrites?: boolean;
	/**
	 * 续跑哪个会话（agent 任务）。空 = 每次**新开**一个会话。
	 * 不在这里校验存在性：会话随时可能被删，保存时挡住反而让人没法先建任务；
	 * 真正跑的时候找不到就报一条清楚的错。
	 */
	sessionId?: string;
	/** 指定模型（agent 任务）；空 = 新建会话跟随项目默认、续跑则沿用该会话原来的模型 */
	model?: string;
};
export type CronRun = {
	id: string;
	jobId: string;
	status: CronStatus;
	trigger: CronTrigger;
	scheduledAt?: string;
	startedAt?: string;
	finishedAt?: string;
	result?: string;
	error?: string;
};
export type CronSnapshot = {
	jobs: Array<CronJob & { nextRunAt: string | null }>;
	runs: CronRun[];
	workspaces: string[];
};
export type CronService = ReturnType<typeof createCronService>;
export type CronOptions = {
	dataDir: string;
	execute: (job: CronJob, signal: AbortSignal) => Promise<string>;
	workspaces?: () => string[] | Promise<string[]>;
	now?: () => Date;
	historyCap?: number;
	/** 调度循环自身的异常（不应该让进程静默停摆） */
	onError?: (error: unknown) => void;
};

type State = { jobs: CronJob[]; runs: CronRun[] };
type ParsedField = { values: Set<number>; restricted: boolean };
const FILE = "cron.json";
const DEFAULT_CAP = 500;
const QUEUE_CAP = 20;
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function errorText(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}
function bad(message: string): never {
	throw new Error(message);
}
function parseField(raw: string, min: number, max: number, names?: Record<string, number>): ParsedField {
	const values = new Set<number>();
	const text = raw.trim();
	// 给「日期」和「星期」同时限定时用：cron 的经典语义是两者都限定时取「或」
	const restricted = text !== "*" && text !== "?";
	for (const item of text.toLowerCase().split(",")) {
		if (!item) bad("invalid cron expression");
		const [base, stepText] = item.split("/");
		const step = stepText === undefined ? 1 : Number(stepText);
		if (!Number.isInteger(step) || step < 1) bad("invalid cron step");
		let lo: number;
		let hi: number;
		if (base === "*") {
			lo = min;
			hi = max;
		} else if (base.includes("-")) {
			const parts = base.split("-");
			if (parts.length !== 2) bad("invalid cron range");
			lo = parseValue(parts[0], names);
			hi = parseValue(parts[1], names);
			if (lo > hi) bad("invalid cron range");
		} else {
			lo = parseValue(base, names);
			hi = lo;
		}
		if (lo < min || hi > max) bad("cron value out of range");
		for (let n = lo; n <= hi; n += step) values.add(n);
	}
	if (!values.size) bad("invalid cron field");
	return { values, restricted };
}
function parseValue(value: string, names?: Record<string, number>): number {
	const named = names?.[value];
	const n = named ?? Number(value);
	if (!Number.isInteger(n)) bad("invalid cron value");
	return n;
}
function parseExpression(expression: string): [ParsedField, ParsedField, ParsedField, ParsedField, ParsedField] {
	const fields = expression.trim().split(/\s+/);
	if (fields.length !== 5) bad("cron expression must have five fields");
	return [
		parseField(fields[0], 0, 59),
		parseField(fields[1], 0, 23),
		parseField(fields[2], 1, 31),
		parseField(fields[3], 1, 12),
		parseField(fields[4], 0, 7, { sun: 0, mon: 1, tue: 2, wed: 3, thu: 4, fri: 5, sat: 6 }),
	];
}
function formatter(timezone: string): Intl.DateTimeFormat {
	try {
		return new Intl.DateTimeFormat("en-US", {
			timeZone: timezone,
			hour12: false,
			year: "numeric",
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			weekday: "short",
		});
	} catch {
		bad("invalid timezone");
	}
}
function localParts(
	date: Date,
	format: Intl.DateTimeFormat,
): { year: number; minute: number; hour: number; day: number; month: number; weekday: number } {
	const p = Object.fromEntries(format.formatToParts(date).map((x) => [x.type, x.value]));
	return {
		year: Number(p.year),
		minute: Number(p.minute),
		hour: Number(p.hour) % 24,
		day: Number(p.day),
		month: Number(p.month),
		weekday: WEEKDAYS.indexOf(p.weekday),
	};
}
type Parsed = ReturnType<typeof parseExpression>;
type Parts = ReturnType<typeof localParts>;
/** 日期字段与星期字段都限定时取「或」，否则两者都要满足（Vixie cron 的经典语义） */
function dayMatches(parsed: Parsed, parts: Parts): boolean {
	const dayOk = parsed[2].values.has(parts.day);
	const weekOk = parsed[4].values.has(parts.weekday) || (parts.weekday === 0 && parsed[4].values.has(7));
	if (parsed[2].restricted && parsed[4].restricted) return dayOk || weekOk;
	return dayOk && weekOk;
}
function timeMatches(parsed: Parsed, parts: Parts): boolean {
	return parsed[0].values.has(parts.minute) && parsed[1].values.has(parts.hour) && parsed[3].values.has(parts.month);
}
/** 某时刻在该时区相对 UTC 的偏移（毫秒） */
function offsetAt(ms: number, format: Intl.DateTimeFormat): number {
	const p = localParts(new Date(ms), format);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) - Math.floor(ms / 60000) * 60000;
}
/**
 * 本地墙钟时间 → 真实时刻。夏令时「跳过」的钟点不存在（返回 null），
 * 回拨造成的重复钟点取较早那一次。
 */
function instantOf(wall: number, format: Intl.DateTimeFormat): number | null {
	let guess = wall;
	for (let i = 0; i < 3; i += 1) {
		const next = wall - offsetAt(guess, format);
		if (next === guess) break;
		guess = next;
	}
	const p = localParts(new Date(guess), format);
	return Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute) === wall ? guess : null;
}
/**
 * 下一次触发时间：按**本地日期**逐日推进，命中的那一天里再枚举表达式给出的钟点。
 * 不逐分钟暴力扫 —— 闰日（`0 0 29 2 *`）这类稀疏表达式要扫 4 年，会拖住整个进程。
 */
function nextOccurrence(expression: string, timezone: string, after: Date): string | null {
	const parsed = parseExpression(expression);
	const format = formatter(timezone);
	const start = Math.floor(after.getTime() / 60000) * 60000 + 60000;
	const first = localParts(new Date(start), format);
	const hours = [...parsed[1].values].sort((a, b) => a - b);
	const minutes = [...parsed[0].values].sort((a, b) => a - b);
	// 4 年足够跨过一个完整闰年周期，也够处理只有 2 月 29 日才跑的任务
	for (let offset = 0; offset <= 366 * 4; offset += 1) {
		const day = new Date(Date.UTC(first.year, first.month - 1, first.day + offset));
		const parts: Parts = {
			year: day.getUTCFullYear(),
			month: day.getUTCMonth() + 1,
			day: day.getUTCDate(),
			hour: 0,
			minute: 0,
			weekday: day.getUTCDay(),
		};
		if (!parsed[3].values.has(parts.month) || !dayMatches(parsed, parts)) continue;
		const wallDay = Date.UTC(parts.year, parts.month - 1, parts.day);
		for (const hour of hours) {
			for (const minute of minutes) {
				const instant = instantOf(wallDay + (hour * 60 + minute) * 60000, format);
				if (instant === null || instant < start) continue;
				// 回读本地字段再验一次：夏令时边界上墙钟与实际时刻可能对不上
				const actual = localParts(new Date(instant), format);
				if (timeMatches(parsed, actual) && dayMatches(parsed, actual)) return new Date(instant).toISOString();
			}
		}
	}
	return null;
}
function validateDraft(input: unknown, workspaces: string[], existingId?: string): CronJob {
	if (!input || typeof input !== "object") bad("job body is required");
	const value = input as Record<string, unknown>;
	const id = existingId ?? (typeof value.id === "string" && value.id ? value.id : randomUUID());
	for (const key of ["name", "workspace", "prompt", "expression", "timezone"])
		if (typeof value[key] !== "string" || !(value[key] as string).trim()) bad(`${key} is required`);
	if (!isAbsolute(value.workspace as string) || !workspaces.includes(value.workspace as string))
		bad("workspace is not registered");
	if (typeof value.enabled !== "boolean") bad("enabled must be boolean");
	parseExpression(value.expression as string);
	formatter(value.timezone as string);
	const mode: CronMode = value.mode === undefined ? "text" : value.mode === "agent" ? "agent" : "text";
	const optionalText = (key: string): string | undefined => {
		const raw = value[key];
		if (raw === undefined || raw === null || raw === "") return undefined;
		if (typeof raw !== "string") bad(`${key} must be a string`);
		return raw.trim() === "" ? undefined : raw.trim();
	};
	if (value.mode !== undefined && value.mode !== "text" && value.mode !== "agent") bad("mode must be text or agent");
	if (value.allowWrites !== undefined && typeof value.allowWrites !== "boolean") bad("allowWrites must be boolean");
	return {
		id,
		name: value.name as string,
		workspace: value.workspace as string,
		prompt: value.prompt as string,
		expression: value.expression as string,
		timezone: value.timezone as string,
		enabled: value.enabled as boolean,
		mode,
		// 文本任务不写盘，留一个恒 false 的字段反而会让人误会「它也能改文件」
		allowWrites: mode === "agent" ? (value.allowWrites as boolean | undefined) === true : false,
		sessionId: mode === "agent" ? optionalText("sessionId") : undefined,
		model: mode === "agent" ? optionalText("model") : undefined,
	};
}

export function createCronService(options: CronOptions) {
	const now = options.now ?? (() => new Date());
	const cap = options.historyCap ?? DEFAULT_CAP;
	let state: State = { jobs: [], runs: [] };
	let loaded = false;
	let timer: ReturnType<typeof setTimeout> | undefined;
	let stopped = true;
	/** 是否正在停服务（与「还没 start」区分：后者照样可以把排队任务跑完） */
	let stopping = false;
	let active: { run: CronRun; controller: AbortController; job: CronJob } | undefined;
	/** 别的任务正在跑时，到点的任务在这里等着（全局只同时跑一个） */
	const pending: { run: CronRun; job: CronJob }[] = [];
	let mutation: Promise<void> = Promise.resolve();
	const lastScheduled = new Map<string, string>();
	let lastCheck = now().getTime();
	const path = join(options.dataDir, FILE);
	const serialize = <T>(operation: () => Promise<T>): Promise<T> => {
		const result = mutation.then(operation);
		mutation = result.then(
			() => undefined,
			() => undefined,
		);
		return result;
	};
	async function load(): Promise<void> {
		if (loaded) return;
		try {
			const raw = JSON.parse(await readFile(path, "utf8")) as Partial<State>;
			state = { jobs: Array.isArray(raw.jobs) ? raw.jobs : [], runs: Array.isArray(raw.runs) ? raw.runs : [] };
		} catch (e) {
			if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
		}
		loaded = true;
	}
	async function save(): Promise<void> {
		await mkdir(dirname(path), { recursive: true });
		const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
		await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, "utf8");
		await rename(temporary, path);
	}
	async function workspaces(): Promise<string[]> {
		return [
			...new Set(
				((await options.workspaces?.()) ?? []).filter((x): x is string => typeof x === "string" && isAbsolute(x)),
			),
		];
	}
	function schedule(): void {
		if (stopped) return;
		if (timer) clearTimeout(timer);
		timer = setTimeout(() => void tick(), 1000);
	}
	async function tick(): Promise<void> {
		if (stopped) return;
		try {
			await load();
			const current = now();
			// 用「上次检查到现在」的窗口取一次下次时间：tick 被拖慢时也不会漏掉
			// （窗口放宽两分钟 + lastScheduled 去重，避免分钟边界上漏拍或重复）
			const windowStart = new Date(Math.min(lastCheck, current.getTime()) - 120000);
			for (const job of state.jobs.filter((x) => x.enabled)) {
				const due = nextOccurrence(job.expression, job.timezone, windowStart);
				if (due && new Date(due) <= current && lastScheduled.get(job.id) !== due) {
					lastScheduled.set(job.id, due);
					await launch(job, "scheduled", due);
				}
			}
			lastCheck = current.getTime();
		} catch (e) {
			// 一次失败不能把调度器弄死：下个 tick 继续试
			options.onError?.(e);
		} finally {
			schedule();
		}
	}
	async function skip(run: CronRun, reason: string): Promise<CronRun> {
		run.status = "skipped";
		run.error = reason;
		run.finishedAt = now().toISOString();
		await save();
		return run;
	}
	async function launch(job: CronJob, trigger: CronTrigger, scheduledAt?: string): Promise<CronRun> {
		const run: CronRun = {
			id: randomUUID(),
			jobId: job.id,
			status: "queued",
			trigger,
			...(scheduledAt ? { scheduledAt } : {}),
		};
		state.runs.push(run);
		state.runs = state.runs.slice(-cap);
		// 同一个任务上一轮还没跑完：跳过这一轮，不叠加
		if (active && active.job.id === job.id) return skip(run, "previous run is still in progress");
		if (active) {
			// 别的任务在跑：排队，一轮跑完接着跑（上限防病态排期把内存撑爆）
			if (pending.length >= QUEUE_CAP) return skip(run, "queue is full");
			pending.push({ run, job });
			await save();
			return run;
		}
		await begin(run, job);
		return run;
	}
	async function begin(run: CronRun, job: CronJob): Promise<void> {
		run.status = "running";
		run.startedAt = now().toISOString();
		const controller = new AbortController();
		active = { run, controller, job };
		await save();
		// 后台跑的这一轮没人 await：落盘/执行出错必须自己接住，不能变成未处理拒绝
		void executeRun(run, controller, job).catch((e: unknown) => options.onError?.(e));
	}
	async function executeRun(run: CronRun, controller: AbortController, job: CronJob): Promise<void> {
		try {
			const result = await options.execute(job, controller.signal);
			if (run.status === "running") {
				run.status = "succeeded";
				run.result = result;
			}
		} catch (e) {
			if (run.status === "running") {
				run.status = controller.signal.aborted ? "interrupted" : "failed";
				run.error = errorText(e);
			}
		}
		run.finishedAt ??= now().toISOString();
		active = undefined;
		state.runs = state.runs.slice(-cap);
		await save();
		// 一轮跑完再放行排队中的下一个（全局同时只跑一个）
		const next = pending.shift();
		if (!next) return;
		if (stopping) await skip(next.run, "service is stopping");
		else await begin(next.run, next.job);
	}
	async function snapshot(): Promise<CronSnapshot> {
		await load();
		const ws = await workspaces();
		const current = now();
		return {
			jobs: state.jobs.map((job) => ({
				...job,
				nextRunAt: job.enabled ? nextOccurrence(job.expression, job.timezone, current) : null,
			})),
			runs: [...state.runs].reverse(),
			workspaces: ws,
		};
	}
	return {
		async start() {
			await serialize(async () => {
				await load();
				stopped = false;
				stopping = false;
				// 重置检查窗口：停机期间错过的不补跑
				lastCheck = now().getTime();
				for (const job of state.jobs) {
					try {
						parseExpression(job.expression);
						formatter(job.timezone);
					} catch (e) {
						// 手改坏了 cron.json 也不能让整个服务起不来：只停用这一条
						job.enabled = false;
						options.onError?.(e);
					}
				}
				await save();
				schedule();
			});
		},
		async stop() {
			await serialize(async () => {
				stopped = true;
				stopping = true;
				if (timer) clearTimeout(timer);
				timer = undefined;
				// 排队中的任务不再启动，如实记成跳过
				while (pending.length > 0) {
					const queued = pending.shift();
					if (!queued) break;
					queued.run.status = "skipped";
					queued.run.error = "service is stopping";
					queued.run.finishedAt = now().toISOString();
				}
				if (active) {
					active.run.status = "interrupted";
					active.run.finishedAt = now().toISOString();
					active.controller.abort();
				}
				await save();
			});
			await mutation;
		},
		async snapshot() {
			return snapshot();
		},
		async create(input: unknown) {
			return serialize(async () => {
				await load();
				const job = validateDraft(input, await workspaces());
				if (state.jobs.some((x) => x.id === job.id)) bad("job id already exists");
				state.jobs.push(job);
				await save();
				return job;
			});
		},
		async update(id: string, input: unknown) {
			return serialize(async () => {
				await load();
				if (!state.jobs.some((x) => x.id === id)) bad("job not found");
				const job = validateDraft(input, await workspaces(), id);
				state.jobs = state.jobs.map((x) => (x.id === id ? job : x));
				await save();
				return job;
			});
		},
		async remove(id: string) {
			return serialize(async () => {
				await load();
				if (!state.jobs.some((x) => x.id === id)) bad("job not found");
				state.jobs = state.jobs.filter((x) => x.id !== id);
				await save();
			});
		},
		async run(id: string) {
			return serialize(async () => {
				await load();
				const job = state.jobs.find((x) => x.id === id);
				if (!job) bad("job not found");
				return launch(job, "manual");
			});
		},
		preview(expression: string, timezone: string) {
			const result: string[] = [];
			let cursor = now();
			for (let i = 0; i < 5; i++) {
				const next = nextOccurrence(expression, timezone, cursor);
				if (!next) break;
				result.push(next);
				cursor = new Date(next);
			}
			return result;
		},
	};
}

export type CronOptionsData = {
	sessions: Array<{ id: string; title: string; workspace: string; model: string | null }>;
	models: Array<{ id: string; label: string }>;
};

export function createCronRouter(service: CronService, extras: { options?: () => CronOptionsData } = {}): Router {
	const router = express.Router();
	const failure = (res: Response, error: unknown) => res.status(400).json({ error: errorText(error) });
	router.get("/", async (_req, res) => {
		try {
			res.json(await service.snapshot());
		} catch (e) {
			failure(res, e);
		}
	});
	/** 编辑器里的「会话 / 模型」候选（agent 任务用）；没注入就给空表，界面自然只显示「新建会话」 */
	router.get("/options", (_req, res) => {
		try {
			res.json(extras.options?.() ?? { sessions: [], models: [] });
		} catch (e) {
			failure(res, e);
		}
	});
	router.post("/preview", (req, res) => {
		try {
			res.json({ times: service.preview(req.body?.expression, req.body?.timezone) });
		} catch (e) {
			failure(res, e);
		}
	});
	router.post("/jobs", async (req, res) => {
		try {
			res.status(201).json(await service.create(req.body));
		} catch (e) {
			failure(res, e);
		}
	});
	router.put("/jobs/:id", async (req, res) => {
		try {
			res.json(await service.update(req.params.id, req.body));
		} catch (e) {
			failure(res, e);
		}
	});
	router.delete("/jobs/:id", async (req, res) => {
		try {
			await service.remove(req.params.id);
			res.status(204).end();
		} catch (e) {
			failure(res, e);
		}
	});
	router.post("/jobs/:id/run", async (req, res) => {
		try {
			res.status(202).json(await service.run(req.params.id));
		} catch (e) {
			failure(res, e);
		}
	});
	return router;
}
