/**
 * 「在聊天里直接建定时任务」的宿主端口（ADR-0049）。
 *
 * 为什么要单开一层：`cron/index.ts` 里的服务认的是 HTTP 的 draft ——
 * `name` / `workspace` / `expression` / `timezone` 一个都不能少，`workspace` 还必须
 * 是已登记的目录。而 agent 在会话里听到的只是「每 10 分钟看一眼这个群」：
 * 名字、时区、工作区、跑在哪条会话里，都得由宿主补默认值。补齐的规则写在这里
 * （纯函数，能单测），引擎侧只负责把模型给的字面参数递进来。
 *
 * 这一层也是**引擎与 express 的隔离带**：`cron/index.ts` 里有 Router，
 * 引擎（会被单测直接 import）不该为了一个接口把 express 一起拖进去。
 */
import type { CronJob, CronRun, CronService } from "./index.js";

/** 工具看到的任务视图：比 `CronJob` 多一个算好的下次时间，少一些内部细节 */
export type CronToolJob = {
	id: string;
	name: string;
	prompt: string;
	expression: string;
	timezone: string;
	enabled: boolean;
	mode: "text" | "agent";
	allowWrites: boolean;
	workspace: string;
	sessionId?: string;
	model?: string;
	nextRunAt: string | null;
};

export type CronToolPort = {
	create(draft: Record<string, unknown>): Promise<CronToolJob>;
	list(): Promise<CronToolJob[]>;
	update(id: string, patch: Record<string, unknown>): Promise<CronToolJob>;
	setEnabled(id: string, enabled: boolean): Promise<CronToolJob>;
	remove(id: string): Promise<void>;
	runNow(id: string): Promise<CronRun>;
	preview(expression: string, timezone?: string): string[];
};

/** 建/改任务时能替模型补上的上下文（由引擎侧的会话给出） */
export type CronToolContext = {
	/** 当前会话：默认就是「任务跑在哪」 */
	conversationId: string;
	/** 当前会话的工作区：默认就是任务的工作区 */
	workspace: string;
	/** 宿主所在地时区：模型没说时区时用它 */
	timezone: string;
};

/** 任务名上限：界面上是一行标题，太长会把表格撑坏 */
const MAX_NAME_CHARS = 24;
/** 提示词上限：cron.json 是整份读写的，单条别塞成一篇文档 */
const MAX_PROMPT_CHARS = 4000;

function text(value: unknown): string {
	return typeof value === "string" ? value.trim() : "";
}

/** 没给名字就从提示词第一行截一段：总比在面板里看到「未命名」强 */
function nameFromPrompt(prompt: string): string {
	const first = prompt
		.split("\n")
		.map((line) => line.trim())
		.find((line) => line !== "");
	return first ? [...first].slice(0, MAX_NAME_CHARS).join("") : "定时任务";
}

/**
 * 工具参数 → `service.create` 的 draft。
 *
 * 两个刻意的默认：
 *   - `mode` 默认 `agent`：用户说「在会话里建个任务」要的就是能读文件、能干活的；
 *     纯文本任务（直连模型）得显式要；
 *   - `sessionId` 默认 = **当前会话**：任务跑的时候续到同一条会话里，
 *     上下文、模型、工作区都还在。要独立会话就显式 `scope: "new"`。
 */
export function cronDraftFromArgs(args: Record<string, unknown>, ctx: CronToolContext): Record<string, unknown> {
	const prompt = text(args.prompt).slice(0, MAX_PROMPT_CHARS);
	const schedule = text(args.schedule) || text(args.expression);
	if (prompt === "") throw new Error("prompt 必填：说清楚每次要做什么");
	if (schedule === "") throw new Error("schedule 必填：5 段 cron 表达式，例如 `0 9 * * *`（每天 9:00）");
	const mode = text(args.mode) === "text" ? "text" : "agent";
	const openNew = text(args.scope) === "new";
	return {
		name: text(args.name) || nameFromPrompt(prompt),
		workspace: text(args.workspace) || ctx.workspace,
		prompt,
		expression: schedule,
		timezone: text(args.timezone) || ctx.timezone,
		// 建的时候就停用是少见需求，但还是给个口子（模型可以先建再确认）
		enabled: args.enabled !== false,
		mode,
		// 文本任务不碰磁盘，写入开关对它没有意义（服务侧也会规范化成 false）
		allowWrites: mode === "agent" && args.allow_writes === true,
		sessionId: mode === "agent" && !openNew ? ctx.conversationId : undefined,
		model: mode === "agent" ? text(args.model) || undefined : undefined,
	};
}

/**
 * 工具参数 → `service.update` 的 patch（只带用户真正说过的那几项）。
 *
 * `scope: "new"` 传的是空串：服务的 `optionalText` 会把空串规范成 `undefined`，
 * 也就是「每次新开会话」—— 这样「改成独立会话跑」也有明确入口。
 */
export function cronPatchFromArgs(args: Record<string, unknown>, ctx: CronToolContext): Record<string, unknown> {
	const patch: Record<string, unknown> = {};
	const name = text(args.name);
	const prompt = text(args.prompt);
	const schedule = text(args.schedule) || text(args.expression);
	const timezone = text(args.timezone);
	const mode = text(args.mode);
	const model = text(args.model);
	const scope = text(args.scope);
	if (name !== "") patch.name = name;
	if (prompt !== "") patch.prompt = prompt.slice(0, MAX_PROMPT_CHARS);
	if (schedule !== "") patch.expression = schedule;
	if (timezone !== "") patch.timezone = timezone;
	if (mode === "agent" || mode === "text") patch.mode = mode;
	if (typeof args.allow_writes === "boolean") patch.allowWrites = args.allow_writes;
	if (model !== "") patch.model = model;
	if (scope === "session") patch.sessionId = ctx.conversationId;
	if (scope === "new") patch.sessionId = "";
	return patch;
}

export function createCronToolPort(service: CronService): CronToolPort {
	/** 下次触发时间：算不出来（表达式被手改坏）就当没有，不要因此让整次调用失败 */
	const nextOf = (job: CronJob): string | null => {
		if (!job.enabled) return null;
		try {
			return service.preview(job.expression, job.timezone)[0] ?? null;
		} catch {
			return null;
		}
	};
	const view = (job: CronJob): CronToolJob => ({
		id: job.id,
		name: job.name,
		prompt: job.prompt,
		expression: job.expression,
		timezone: job.timezone,
		enabled: job.enabled,
		mode: job.mode ?? "text",
		allowWrites: job.allowWrites === true,
		workspace: job.workspace,
		...(job.sessionId ? { sessionId: job.sessionId } : {}),
		...(job.model ? { model: job.model } : {}),
		nextRunAt: nextOf(job),
	});
	/**
	 * 先查一次再操作：服务自己的 `not found` 不带「可能是哪个 id」的提示，
	 * 模型多半会紧接着再问用户一遍，不如在这里一次把话说清楚。
	 */
	const requireJob = async (id: string): Promise<CronJob> => {
		if (id.trim() === "") throw new Error("job_id 必填（先用 action=list 查 id）");
		const snapshot = await service.snapshot();
		const found = snapshot.jobs.find((job) => job.id === id);
		if (!found) throw new Error(`找不到定时任务 ${id}（用 action=list 看现有 id）`);
		return found;
	};
	const setEnabled = async (id: string, enabled: boolean): Promise<CronToolJob> => {
		const job = await requireJob(id);
		// update 要求整份 draft：把现有字段原样带上，只改 enabled
		return view(await service.update(id, { ...job, enabled }));
	};
	return {
		async create(draft) {
			return view(await service.create(draft));
		},
		async list() {
			const snapshot = await service.snapshot();
			return snapshot.jobs.map((job) => view(job));
		},
		async update(id, patch) {
			const job = await requireJob(id);
			return view(await service.update(id, { ...job, ...patch, id }));
		},
		setEnabled,
		async remove(id) {
			await requireJob(id);
			await service.remove(id);
		},
		async runNow(id) {
			await requireJob(id);
			return service.run(id);
		},
		preview(expression, timezone) {
			if (expression.trim() === "") throw new Error("schedule 必填，例如 `*/10 * * * *`");
			return service.preview(expression, timezone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC");
		},
	};
}
