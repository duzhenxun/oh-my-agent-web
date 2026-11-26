import { tNow } from "./use-language.ts";

/** Frontend-only contract for the independently mounted /api/cron API. */
/** 任务类型：文本任务（直连模型，无工具）/ agent 任务（工作区里真跑一个会话） */
export type CronMode = "text" | "agent";
export type CronDraft = {
	name: string;
	workspace: string;
	prompt: string;
	expression: string;
	timezone: string;
	enabled: boolean;
	mode: CronMode;
	/** 仅 agent 任务：允许改动工作区（默认 false = 只读） */
	allowWrites: boolean;
	/** 仅 agent 任务：续跑哪个会话；空 = 每次新开一个 */
	sessionId: string;
	/** 仅 agent 任务：指定模型；空 = 跟随默认（续跑时沿用该会话原来的模型） */
	model: string;
};

/** 表单里的候选：已有会话 / 可选模型（`GET /api/cron/options`） */
export type CronOptions = {
	sessions: Array<{ id: string; title: string; workspace: string; model: string | null }>;
	models: Array<{ id: string; label: string }>;
};
export type CronJob = CronDraft & { id: string; nextRunAt: string | null };
export type CronRun = {
	id: string;
	jobId: string;
	status: "queued" | "running" | "succeeded" | "failed" | "interrupted" | "skipped";
	trigger: "manual" | "scheduled";
	scheduledAt?: string;
	startedAt?: string;
	finishedAt?: string;
	result?: string;
	error?: string;
};
/** 任务与运行历史是**按引擎分开存**的：这份快照只包含当前引擎那一份 */
export type CronState = { engine: string; jobs: CronJob[]; runs: CronRun[]; workspaces: string[] };
/**
 * 编辑器里的「计划」选项：既包括「具体钟点」（每天 / 工作日 / 每周 / 每月），
 * 也包括「隔多久跑一次」（每隔几分钟 / 几小时）。它们最终都落成**一个五字段表达式**，
 * 服务端因此仍然只有一条规则可依，不需要第二套调度模型。
 */
export type CronPreset = "minutes" | "hours" | "daily" | "weekday" | "weekly" | "monthly" | "advanced";

export type CronSchedule = {
	preset: CronPreset;
	/** `HH:MM`（每天 / 每周 / 工作日 / 每月用） */
	time: string;
	/** 0-6，周日为 0（每周用） */
	weekday: string;
	/** 间隔步长：几分钟 / 几小时（间隔模式用） */
	every: string;
	/** 1-31（每月用） */
	dayOfMonth: string;
};

export const CRON_POLL_MS = 5_000;

/** 间隔模式的合法范围：与表达式字段的边界一致（分钟 1-59、小时 1-23） */
export const CRON_EVERY_MIN = 1;
export const CRON_EVERY_MAX_MINUTES = 59;
export const CRON_EVERY_MAX_HOURS = 23;

/** Explicitly pick draft fields: PUT also needs the entire draft when toggling enabled. */
export function cronDraft(job: CronDraft): CronDraft {
	const { name, workspace, prompt, expression, timezone, enabled, mode, allowWrites, sessionId, model } = job;
	return { name, workspace, prompt, expression, timezone, enabled, mode, allowWrites, sessionId, model };
}

export function newCronDraft(workspace = ""): CronDraft {
	return {
		name: "",
		workspace,
		prompt: "",
		expression: "0 9 * * *",
		timezone: Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC",
		enabled: true,
		mode: "text",
		allowWrites: false,
		sessionId: "",
		model: "",
	};
}

const pad2 = (value: number): string => String(value).padStart(2, "0");

/**
 * 从一个五字段表达式反推编辑器该用哪种预设。
 *
 * 认不出来的就是 `advanced` —— 宁可让用户看到原始表达式，也不要「猜」成某个预设后
 * 把他的任务改掉（保存时会用预设重新生成表达式，猜错就是静默改任务）。
 */
export function cronPreset(expression: string): CronSchedule {
	const empty: CronSchedule = { preset: "advanced", time: "09:00", weekday: "1", every: "5", dayOfMonth: "1" };
	const [minute, hour, day, month, weekday, extra] = expression.trim().split(/\s+/);
	if (extra || minute === undefined || hour === undefined || day === undefined || month === undefined || weekday === undefined)
		return empty;
	if (month !== "*") return empty;
	const isNum = (value: string) => /^\d{1,2}$/.test(value);

	// 每隔 N 分钟：`*/N * * * *`
	if (/^\*\/\d{1,2}$/.test(minute) && hour === "*" && day === "*" && weekday === "*") {
		const every = Number(minute.slice(2));
		if (every >= CRON_EVERY_MIN && every <= CRON_EVERY_MAX_MINUTES) return { ...empty, preset: "minutes", every: String(every) };
		return empty;
	}
	// 每隔 N 小时：`0 */N * * *`
	if (minute === "0" && /^\*\/\d{1,2}$/.test(hour) && day === "*" && weekday === "*") {
		const every = Number(hour.slice(2));
		if (every >= CRON_EVERY_MIN && every <= CRON_EVERY_MAX_HOURS) return { ...empty, preset: "hours", every: String(every) };
		return empty;
	}
	if (!isNum(minute) || !isNum(hour) || Number(minute) > 59 || Number(hour) > 23) return empty;
	const time = `${pad2(Number(hour))}:${pad2(Number(minute))}`;
	if (day === "*" && weekday === "*") return { ...empty, preset: "daily", time };
	if (day === "*" && weekday === "1-5") return { ...empty, preset: "weekday", time };
	if (day === "*" && /^[0-6]$/.test(weekday)) return { ...empty, preset: "weekly", time, weekday };
	if (isNum(day) && Number(day) >= 1 && Number(day) <= 31 && weekday === "*")
		return { ...empty, preset: "monthly", time, dayOfMonth: String(Number(day)) };
	return empty;
}

/** 预设 → 五字段表达式（`advanced` 返回 current，表示用户自己写，不覆盖） */
export function cronExpression(schedule: CronSchedule, current = ""): string {
	const { preset } = schedule;
	if (preset === "advanced") return current;
	if (preset === "minutes") {
		const every = clampStep(schedule.every, CRON_EVERY_MAX_MINUTES);
		return `*/${every} * * * *`;
	}
	if (preset === "hours") {
		const every = clampStep(schedule.every, CRON_EVERY_MAX_HOURS);
		return `0 */${every} * * *`;
	}
	const [hour, minute] = (schedule.time || "09:00").split(":");
	const head = `${Number(minute ?? 0)} ${Number(hour ?? 9)}`;
	if (preset === "daily") return `${head} * * *`;
	if (preset === "weekday") return `${head} * * 1-5`;
	if (preset === "weekly") return `${head} * * ${clsWeekday(schedule.weekday)}`;
	// monthly：日期夹在 1-31（32 号在表达式里是非法值，宁可夹取也不要存进去）
	const day = Math.min(31, Math.max(1, Math.round(Number(schedule.dayOfMonth)) || 1));
	return `${head} ${day} * *`;
}

function clampStep(raw: string, max: number): number {
	const value = Math.round(Number(raw));
	if (!Number.isFinite(value)) return 1;
	return Math.min(max, Math.max(CRON_EVERY_MIN, value));
}

function clsWeekday(raw: string): string {
	const value = Math.round(Number(raw));
	return String(Number.isFinite(value) && value >= 0 && value <= 6 ? value : 1);
}

export function cronDraftReady(draft: CronDraft, workspaces: readonly string[]): boolean {
	return Boolean(
		draft.name.trim() &&
		draft.prompt.trim() &&
		draft.timezone.trim() &&
		workspaces.includes(draft.workspace) &&
		draft.expression.trim().split(/\s+/).length === 5,
	);
}

async function request(path: string, method: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
	const response = await fetch(`/api/cron${path}`, {
		method,
		credentials: "same-origin",
		cache: "no-store",
		signal,
		...(body === undefined ? {} : { headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
	});
	if (!response.ok) {
		const payload = await response.json().catch(() => null);
		throw new Error(
			typeof payload?.error === "string" && payload.error
				? payload.error
				: tNow(`请求失败（HTTP ${response.status}）`, `Request failed (HTTP ${response.status})`),
		);
	}
	return response;
}

export async function fetchCron(signal?: AbortSignal): Promise<CronState> {
	return (await request("", "GET", undefined, signal)).json();
}

export async function fetchCronOptions(signal?: AbortSignal): Promise<CronOptions> {
	return (await request("/options", "GET", undefined, signal)).json();
}

export async function previewCron(expression: string, timezone: string, signal?: AbortSignal): Promise<string[]> {
	const response = await request("/preview", "POST", { expression, timezone }, signal);
	const body: { times: string[] } = await response.json();
	return body.times;
}

export async function saveCron(draft: CronDraft, id?: string, signal?: AbortSignal): Promise<void> {
	await request(
		id === undefined ? "/jobs" : `/jobs/${encodeURIComponent(id)}`,
		id === undefined ? "POST" : "PUT",
		cronDraft(draft),
		signal,
	);
}

export async function deleteCron(id: string, signal?: AbortSignal): Promise<void> {
	await request(`/jobs/${encodeURIComponent(id)}`, "DELETE", undefined, signal);
}

export async function runCron(id: string, signal?: AbortSignal): Promise<void> {
	await request(`/jobs/${encodeURIComponent(id)}/run`, "POST", undefined, signal);
}

/** 运行记录里的时间：`11-02 19:42`（本地时区，纯数字好扫，中英宽度一致） */
export function cronTime(iso: string | undefined, withWeekday = false): string {
	if (!iso) return "—";
	const date = new Date(iso);
	if (Number.isNaN(date.getTime())) return iso;
	const pad = (value: number) => String(value).padStart(2, "0");
	const weekday = withWeekday
		? ` ${new Intl.DateTimeFormat(undefined, { weekday: "short" }).format(date)}`
		: "";
	return `${pad(date.getMonth() + 1)}-${pad(date.getDate())}${weekday} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

/** Serial polling, scoped to the mounted panel. Abort prevents closed/stale panels receiving updates. */
export function watchCron(
	onState: (state: CronState) => void,
	onError: (error: unknown) => void,
	interval = CRON_POLL_MS,
): () => void {
	const controller = new AbortController();
	let timer: ReturnType<typeof setTimeout> | undefined;
	const poll = async () => {
		try {
			const state = await fetchCron(controller.signal);
			if (!controller.signal.aborted) onState(state);
		} catch (error) {
			if (!controller.signal.aborted) onError(error);
		} finally {
			if (!controller.signal.aborted) timer = setTimeout(() => void poll(), interval);
		}
	};
	void poll();
	return () => {
		controller.abort();
		clearTimeout(timer);
	};
}
