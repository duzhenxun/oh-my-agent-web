import assert from "node:assert/strict";
import { afterEach, describe, it, mock } from "node:test";
import {
	cronDraft,
	cronDraftReady,
	cronExpression,
	cronPreset,
	deleteCron,
	fetchCron,
	newCronDraft,
	previewCron,
	runCron,
	saveCron,
	watchCron,
	type CronJob,
	type CronSchedule,
	type CronState,
} from "../../web/src/cron.ts";

const job: CronJob = {
	id: "job /?#",
	name: "Daily check",
	workspace: "/registered",
	prompt: "Report status",
	expression: "15 9 * * *",
	timezone: "Asia/Shanghai",
	enabled: true,
	mode: "text",
	allowWrites: false,
	sessionId: "",
	model: "",
	nextRunAt: null,
};
const state: CronState = { jobs: [job], runs: [], workspaces: [job.workspace] };

afterEach(() => mock.restoreAll());

describe("Cron presets and drafts", () => {
	const schedule = (patch: Partial<CronSchedule> = {}): CronSchedule => ({
		preset: "daily",
		time: "09:00",
		weekday: "1",
		every: "5",
		dayOfMonth: "1",
		...patch,
	});

	it("钟点类预设的往返：每天 / 工作日 / 每周 / 每月", () => {
		assert.equal(cronExpression(schedule({ preset: "daily", time: "09:05" })), "5 9 * * *");
		assert.equal(cronExpression(schedule({ preset: "weekday", time: "08:30" })), "30 8 * * 1-5");
		assert.equal(cronExpression(schedule({ preset: "weekly", time: "23:45", weekday: "0" })), "45 23 * * 0");
		assert.equal(cronExpression(schedule({ preset: "monthly", time: "07:00", dayOfMonth: "15" })), "0 7 15 * *");

		assert.deepEqual(cronPreset("5 9 * * *"), schedule({ preset: "daily", time: "09:05" }));
		assert.deepEqual(cronPreset("30 8 * * 1-5"), schedule({ preset: "weekday", time: "08:30" }));
		assert.deepEqual(cronPreset("45 23 * * 0"), schedule({ preset: "weekly", time: "23:45", weekday: "0" }));
		assert.deepEqual(cronPreset("0 7 15 * *"), schedule({ preset: "monthly", time: "07:00", dayOfMonth: "15" }));
	});

	it("间隔模式：每隔 N 分钟 / 每隔 N 小时能生成并反解", () => {
		assert.equal(cronExpression(schedule({ preset: "minutes", every: "15" })), "*/15 * * * *");
		assert.equal(cronExpression(schedule({ preset: "hours", every: "2" })), "0 */2 * * *");
		assert.deepEqual(cronPreset("*/15 * * * *"), schedule({ preset: "minutes", every: "15" }));
		assert.deepEqual(cronPreset("0 */2 * * *"), schedule({ preset: "hours", every: "2" }));
	});

	it("间隔数值越界被夹取，而不是生成非法表达式", () => {
		assert.equal(cronExpression(schedule({ preset: "minutes", every: "0" })), "*/1 * * * *");
		assert.equal(cronExpression(schedule({ preset: "minutes", every: "999" })), "*/59 * * * *");
		assert.equal(cronExpression(schedule({ preset: "hours", every: "-3" })), "0 */1 * * *");
		assert.equal(cronExpression(schedule({ preset: "hours", every: "48" })), "0 */23 * * *");
		assert.equal(cronExpression(schedule({ preset: "monthly", dayOfMonth: "99", time: "09:00" })), "0 9 31 * *");
	});

	it("认不出的表达式保持 advanced，不会被预设静默改掉", () => {
		for (const expression of ["0 9 * * 7", "60 24 * * *", "0 0 9 * * *", "0 9 1 6 *", "*/0 * * * *", "0 */99 * * *"])
			assert.equal(cronPreset(expression).preset, "advanced", expression);
		assert.equal(cronExpression(schedule({ preset: "advanced" }), "0 9 1 6 *"), "0 9 1 6 *");
	});

	it("only registered workspaces and nonempty five-field drafts can be submitted", () => {
		assert.equal(cronDraftReady(job, state.workspaces), true);
		for (const patch of [
			{ workspace: "/arbitrary" },
			{ name: " " },
			{ prompt: " " },
			{ timezone: "" },
			{ expression: "0 0 9 * * *" },
		])
			assert.equal(cronDraftReady({ ...job, ...patch }, state.workspaces), false);
		assert.equal(cronDraftReady(job, []), false);
		assert.equal(newCronDraft("/registered").workspace, "/registered");
		assert.equal(newCronDraft().expression, "0 9 * * *");
		assert.ok(newCronDraft().timezone);
		assert.deepEqual(Object.keys(cronDraft(job)), [
			"name",
			"workspace",
			"prompt",
			"expression",
			"timezone",
			"enabled",
			"mode",
			"allowWrites",
			"sessionId",
			"model",
		]);
		assert.equal(newCronDraft().mode, "text", "新任务默认是文本任务（不碰仓库）");
		assert.equal(newCronDraft().allowWrites, false, "agent 任务默认只读");
	});
});

describe("Cron HTTP contract", () => {
	it("uses same-origin authenticated requests, full drafts, encoded IDs and accepts empty mutation responses", async () => {
		const calls: { url: string; init: RequestInit }[] = [];
		mock.method(globalThis, "fetch", async (url: string, init: RequestInit) => {
			calls.push({ url, init });
			if (init.method === "GET") return Response.json(state);
			if (url.endsWith("/preview")) return Response.json({ times: ["2026-11-20T01:15:00Z"] });
			return new Response(null, { status: 204 });
		});
		assert.deepEqual(await fetchCron(), state);
		assert.deepEqual(await previewCron(job.expression, job.timezone), ["2026-11-20T01:15:00Z"]);
		await saveCron(job);
		await saveCron({ ...job, enabled: false }, job.id);
		await deleteCron(job.id);
		await runCron(job.id);
		assert.deepEqual(
			calls.map(({ url, init }) => [init.method, url]),
			[
				["GET", "/api/cron"],
				["POST", "/api/cron/preview"],
				["POST", "/api/cron/jobs"],
				["PUT", "/api/cron/jobs/job%20%2F%3F%23"],
				["DELETE", "/api/cron/jobs/job%20%2F%3F%23"],
				["POST", "/api/cron/jobs/job%20%2F%3F%23/run"],
			],
		);
		for (const { init } of calls) {
			assert.equal(init.credentials, "same-origin");
			assert.equal(init.cache, "no-store");
		}
		assert.deepEqual(JSON.parse(calls[1]!.init.body as string), { expression: job.expression, timezone: job.timezone });
		assert.deepEqual(JSON.parse(calls[2]!.init.body as string), cronDraft(job));
		assert.deepEqual(JSON.parse(calls[3]!.init.body as string), { ...cronDraft(job), enabled: false });
		assert.equal(calls[4]!.init.body, undefined);
		assert.equal(calls[5]!.init.body, undefined);
	});

	it("surfaces API errors, HTTP failures and network errors instead of treating them as success", async () => {
		mock.method(globalThis, "fetch", async () => Response.json({ error: "Unregistered workspace" }, { status: 400 }));
		await assert.rejects(saveCron(job), /Unregistered workspace/);
		mock.restoreAll();
		mock.method(globalThis, "fetch", async () => new Response("Login required", { status: 401 }));
		await assert.rejects(fetchCron(), /HTTP 401/);
		mock.restoreAll();
		mock.method(globalThis, "fetch", async () => {
			throw new TypeError("Failed to fetch");
		});
		await assert.rejects(runCron(job.id), /Failed to fetch/);
	});

	it("forwards abort signals for previews and panel requests", async () => {
		const controller = new AbortController();
		const signals: (AbortSignal | null | undefined)[] = [];
		mock.method(globalThis, "fetch", async (_url: string, init: RequestInit) => {
			signals.push(init.signal);
			return Response.json({ times: [] });
		});
		await previewCron(job.expression, job.timezone, controller.signal);
		await saveCron(job, job.id, controller.signal);
		assert.deepEqual(signals, [controller.signal, controller.signal]);
	});
});

describe("Cron polling lifecycle", () => {
	it("polls serially, recovers from failures, and stops when closed", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		let calls = 0;
		const updates: CronState[] = [];
		const errors: unknown[] = [];
		mock.method(globalThis, "fetch", async () => {
			calls++;
			if (calls === 1) throw new Error("offline");
			return Response.json(state);
		});
		const stop = watchCron(
			(value) => updates.push(value),
			(error) => errors.push(error),
			100,
		);
		const settle = () => new Promise<void>((resolve) => setImmediate(resolve));
		try {
			await settle();
			assert.equal(errors.length, 1);
			context.mock.timers.tick(100);
			await settle();
			assert.deepEqual(updates, [state]);
			stop();
			context.mock.timers.tick(1_000);
			await settle();
			assert.equal(calls, 2);
		} finally {
			stop();
		}
	});

	it("does not overlap slow requests or publish a late response after closing", async (context) => {
		context.mock.timers.enable({ apis: ["setTimeout"] });
		let complete!: (value: Response) => void;
		let signal: AbortSignal | null | undefined;
		let calls = 0;
		mock.method(globalThis, "fetch", (_url: string, init: RequestInit) => {
			calls++;
			signal = init.signal;
			return new Promise<Response>((resolve) => {
				complete = resolve;
			});
		});
		const updates: CronState[] = [];
		const stop = watchCron(
			(value) => updates.push(value),
			() => assert.fail("aborted request reported"),
			100,
		);
		context.mock.timers.tick(1_000);
		assert.equal(calls, 1);
		stop();
		assert.equal(signal?.aborted, true);
		complete(Response.json(state));
		await new Promise<void>((resolve) => setImmediate(resolve));
		assert.deepEqual(updates, []);
		context.mock.timers.tick(1_000);
		assert.equal(calls, 1);
	});
});
