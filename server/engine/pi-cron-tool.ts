/**
 * 会话里的 `cron` 工具（ADR-0049）：agent 在聊天里直接看/建/改定时任务。
 *
 * 这个工具补的是「用户懒得开面板」那条路：用户说一句「每天早上 9 点看一下这个群的 bug」，
 * 模型就能把任务建出来，而且**默认绑当前这条会话** —— 到点跑的时候续到同一条会话里，
 * 上下文、模型、工作区都还在，跑出来的东西用户回来就能接着聊。
 *
 * 三条边界：
 *   1. 建任务在审批层算「有副作用」（`approval/scope.ts`）：开着「问一下」时要用户点确认；
 *      定时任务自己跑起来是无人值守，那里的 cron 调用会被 `deny-writes` 策略直接拒 ——
 *      不让一个定时任务自己再造定时任务；
 *   2. 默认 `allow_writes: false`：无人值守的写入必须由用户显式打开（和编辑器里的勾选同义）；
 *   3. 只碰任务定义，不替用户「先跑一次看看」—— 要立刻跑用 `action: "run_now"` 明说。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import {
	cronDraftFromArgs,
	cronPatchFromArgs,
	type CronToolContext,
	type CronToolJob,
	type CronToolPort,
} from "../cron/tool.js";

type CronToolOptions = {
	/** 惰性取端口：宿主先建运行时、后建 cron 服务，建会话时两边都好了 */
	port: () => CronToolPort | null;
	conversationId: string;
	workspace: string;
};

const ACTIONS = "add | list | update | remove | enable | disable | run_now | preview";

/** 宿主时区：模型没说时区时用它（`cron` 只认 IANA 名字） */
function hostTimezone(): string {
	try {
		return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
	} catch {
		return "UTC";
	}
}

/** 下次时间按任务自己的时区显示：界面上看到的是「本地几点」，不是 ISO 的 UTC */
function formatAt(iso: string, timezone: string): string {
	try {
		return new Intl.DateTimeFormat("zh-CN", {
			timeZone: timezone,
			month: "2-digit",
			day: "2-digit",
			hour: "2-digit",
			minute: "2-digit",
			hour12: false,
		}).format(new Date(iso));
	} catch {
		return iso;
	}
}

function describeJob(job: CronToolJob, ctx: CronToolContext): string {
	const when = job.enabled
		? job.nextRunAt
			? `下次 ${formatAt(job.nextRunAt, job.timezone)}`
			: "下次时间算不出来（检查 cron 表达式）"
		: "已停用";
	const session =
		job.mode !== "agent"
			? "不占会话（直连模型）"
			: job.sessionId === ctx.conversationId
				? "在当前这个会话里跑"
				: job.sessionId
					? `续跑会话 ${job.sessionId}`
					: "每次新开会话";
	const lines = [
		`${job.name} · ${job.id}`,
		`${job.expression}（${job.timezone}）· ${when}`,
		`${job.mode === "agent" ? `agent 任务，${job.allowWrites ? "允许改文件" : "只读"}` : "文本任务"} · ${session}`,
	];
	if (job.mode === "agent" && job.model) lines.push(`模型 ${job.model}`);
	lines.push(`工作区 ${job.workspace}`);
	return lines.join("\n");
}

function previewText(schedule: string, times: string[], timezone: string): string {
	if (times.length === 0) return `${schedule}（${timezone}）：算不出下次时间，检查表达式`;
	return [
		`${schedule}（${timezone}）接下来 ${times.length} 次：`,
		...times.map((iso) => `- ${formatAt(iso, timezone)}`),
	].join("\n");
}

function failure(error: unknown): {
	content: Array<{ type: "text"; text: string }>;
	details: undefined;
	isError: true;
} {
	return {
		content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
		details: undefined,
		isError: true,
	};
}

export function makeCronToolExtension(options: CronToolOptions): InlineExtension {
	return {
		name: "oh-my-agent-web-cron",
		hidden: true,
		factory: (pi) => {
			pi.registerTool(
				defineTool({
					name: "cron",
					label: "cron",
					description: [
						"Create and manage scheduled tasks on this machine. A task is a prompt plus a cron expression; this workspace's scheduler runs it even when nobody is chatting.",
						"By default the task is an **agent** task that resumes THIS conversation (same context, model and workspace) — that is what users normally mean by 「在我这个会话里跑」.",
						"Actions:",
						`- \`${ACTIONS}\``,
						"- add: needs `prompt` (what to do each time) and `schedule`. Returns the new id.",
						"- list: show every task with its next run; check `job_id` before update/remove/enable/disable/run_now.",
						"- preview: only compute the next 5 run times for a `schedule` (no task created).",
						"Schedule is standard 5-field cron (minute hour day-of-month month day-of-week) in the task's timezone, e.g. `*/10 * * * *` (every 10 min), `0 9 * * *` (daily 09:00), `30 8 * * 1-5` (weekdays 08:30), `0 10 1 * *` (1st of month 10:00).",
					].join("\n"),
					promptSnippet: "Schedule a recurring task (cron) that runs in this conversation",
					promptGuidelines: [
						"When the user asks for something to happen on a schedule (每天/每周/每隔 N 分钟/提醒我), call `cron` with action=add instead of telling them to open the Tasks panel.",
						"Convert their wording into a 5-field cron expression, and echo the schedule back in plain words (e.g. 「每天 09:00」) so they can catch a mistake.",
						"Keep the default `scope: session` (the task resumes this conversation). Use `scope: new` only when the user explicitly wants a separate session.",
						"Leave `allow_writes` off unless the user says the task may modify files — unattended writes are a big deal.",
						"After add/update, report the task id, the schedule and the next run time from the tool result; do not invent them.",
					],
					executionMode: "parallel",
					parameters: Type.Object({
						action: Type.String({ description: `One of: ${ACTIONS}. Default: list.` }),
						job_id: Type.Optional(Type.String({ description: "Task id (from action=list or the add result)." })),
						name: Type.Optional(
							Type.String({ description: "Short title shown in the Tasks panel. Default: first line of prompt." }),
						),
						prompt: Type.Optional(
							Type.String({ description: "What the task should do on every run. Required for add." }),
						),
						schedule: Type.Optional(
							Type.String({
								description: "5-field cron expression, e.g. `0 9 * * *`. Required for add and preview.",
							}),
						),
						timezone: Type.Optional(
							Type.String({
								description: `IANA timezone, e.g. Asia/Shanghai. Default: this machine's (${hostTimezone()}).`,
							}),
						),
						mode: Type.Optional(
							Type.String({
								description:
									"`agent` (runs a real session, can use tools; default) or `text` (model only, no tools, no files).",
							}),
						),
						allow_writes: Type.Optional(
							Type.Boolean({ description: "Agent tasks only: allow changing files. Default false (read-only)." }),
						),
						scope: Type.Optional(
							Type.String({
								description: "`session` (default: resume this conversation) or `new` (fresh session each run).",
							}),
						),
						model: Type.Optional(
							Type.String({
								description: "Agent tasks only: model id. Default: this conversation's / project default.",
							}),
						),
						workspace: Type.Optional(
							Type.String({
								description: "Absolute directory the task works in. Default: this conversation's workspace.",
							}),
						),
					}),
					async execute(_toolCallId, params) {
						const port = options.port();
						if (!port) return failure(new Error("定时任务服务还没就绪，过一会儿再看"));
						const ctx: CronToolContext = {
							conversationId: options.conversationId,
							workspace: options.workspace,
							timezone: hostTimezone(),
						};
						const args = params as unknown as Record<string, unknown>;
						const action = (typeof params.action === "string" ? params.action.trim() : "") || "list";
						const jobId = typeof params.job_id === "string" ? params.job_id.trim() : "";
						try {
							if (action === "list") {
								const jobs = await port.list();
								if (jobs.length === 0) return ok("还没有定时任务。用 action=add 建一个。");
								return ok(
									[
										`共 ${jobs.length} 个定时任务（启用 ${jobs.filter((job) => job.enabled).length} 个）：`,
										...jobs.map((job) => `- ${describeJob(job, ctx)}`),
									].join("\n\n"),
								);
							}
							if (action === "preview") {
								const schedule = typeof params.schedule === "string" ? params.schedule : "";
								const timezone =
									typeof params.timezone === "string" && params.timezone.trim() !== ""
										? params.timezone.trim()
										: ctx.timezone;
								return ok(previewText(schedule, port.preview(schedule, timezone), timezone));
							}
							if (action === "add") {
								const job = await port.create(cronDraftFromArgs(args, ctx));
								const next = job.nextRunAt ? `下次 ${formatAt(job.nextRunAt, job.timezone)}` : "已停用";
								return ok([`已创建定时任务 ${job.id}：`, describeJob(job, ctx), next].join("\n"));
							}
							if (action === "update") {
								const job = await port.update(jobId, cronPatchFromArgs(args, ctx));
								return ok([`已更新定时任务 ${job.id}：`, describeJob(job, ctx)].join("\n"));
							}
							if (action === "enable" || action === "disable") {
								const job = await port.setEnabled(jobId, action === "enable");
								return ok([`已${action === "enable" ? "启用" : "停用"} ${job.id}：`, describeJob(job, ctx)].join("\n"));
							}
							if (action === "remove") {
								await port.remove(jobId);
								return ok(`已删除定时任务 ${jobId}。`);
							}
							if (action === "run_now") {
								const run = await port.runNow(jobId);
								return ok(`已把 ${jobId} 排进队列（run ${run.id}）。它跑完会出现在任务面板的运行记录里。`);
							}
							return failure(new Error(`未知 action：${action}（可用：${ACTIONS}）`));
						} catch (error) {
							return failure(error);
						}
					},
				}),
			);
		},
	};
}

function ok(text: string): { content: Array<{ type: "text"; text: string }>; details: undefined } {
	return { content: [{ type: "text", text }], details: undefined };
}
