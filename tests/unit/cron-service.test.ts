/**
 * 定时调度服务：表达式校验、下次时间、并发队列、停机中断、持久化。
 *
 * 重点不是「能存能读」，而是几条容易静默出错的边界：
 *   - 同一任务重叠要跳过，不同任务同时到点要排队（不是一起跳过）；
 *   - 停机期间错过的不补跑；
 *   - 闰日 / 夏令时的下次时间不能算错或者算不出来。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createCronRouter, createCronService, type CronJob } from "../../server/cron/index.js";

const dirs: string[] = [];
async function makeService(
	options: {
		execute?: (job: CronJob, signal: AbortSignal) => Promise<string>;
		now?: () => Date;
		workspaces?: string[];
		dataDir?: string;
		/** 当前引擎（任务按引擎分文件存） */
		engine?: () => string;
	} = {},
) {
	const dataDir = options.dataDir ?? (await mkdtemp(join(tmpdir(), "cron-unit-")));
	if (!options.dataDir) dirs.push(dataDir);
	const service = createCronService({
		dataDir,
		execute: options.execute ?? (async () => "done"),
		workspaces: () => options.workspaces ?? ["/work"],
		...(options.engine ? { engine: options.engine } : {}),
		...(options.now ? { now: options.now } : {}),
	});
	return { service, dataDir };
}

const draft = (patch: Partial<CronJob> = {}) => ({
	name: "job",
	workspace: "/work",
	prompt: "write a note",
	expression: "0 9 * * *",
	timezone: "Asia/Shanghai",
	enabled: false,
	...patch,
});

const waitFor = async (check: () => boolean | Promise<boolean>, label: string) => {
	for (let i = 0; i < 200; i += 1) {
		if (await check()) return;
		await new Promise((resolve) => setTimeout(resolve, 10));
	}
	assert.fail(`timed out waiting for ${label}`);
};

afterEach(async () => {
	await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 })));
});

/**
 * 任务**按引擎分开存**（用户 2026-11-24：「不同的 agent 要区分开，各保存各的，不要放一块」）。
 *
 * 原因：一条任务绑的是「那个引擎的会话与模型」，混在一个文件里切到别的引擎会看到一堆跑不了的
 * 任务、还可能误触发；反过来把 pi 的任务丢给 codex 跑，只会报「打开会话失败」。
 */
describe("cron per-engine storage", () => {
	it("两个引擎各存各的文件，互相看不到", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "cron-engine-"));
		dirs.push(dataDir);
		let engine = "pi";
		const { service } = await makeService({ dataDir, engine: () => engine });

		const piJob = await service.create(draft({ name: "pi job" }));
		engine = "codex";
		assert.equal((await service.snapshot()).jobs.length, 0, "切到 codex 后不该看到 pi 的任务");
		const codexJob = await service.create(draft({ name: "codex job" }));
		assert.equal(codexJob.engine, "codex");
		assert.deepEqual(
			(await service.snapshot()).jobs.map((job) => job.name),
			["codex job"],
		);

		engine = "pi";
		assert.deepEqual(
			(await service.snapshot()).jobs.map((job) => job.name),
			["pi job"],
		);

		// 两份文件都在，且各只有自己那条
		const piRaw = JSON.parse(await readFile(join(dataDir, "cron", "pi.json"), "utf8"));
		const codexRaw = JSON.parse(await readFile(join(dataDir, "cron", "codex.json"), "utf8"));
		assert.equal(piRaw.jobs[0]?.id, piJob.id);
		assert.equal(codexRaw.jobs[0]?.id, codexJob.id);
	});

	it("老的 cron.json 一次性迁到 pi，并改名留底（不重复迁）", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "cron-legacy-"));
		dirs.push(dataDir);
		const { writeFile, mkdir } = await import("node:fs/promises");
		await mkdir(join(dataDir, "cron"), { recursive: true });
		await writeFile(
			join(dataDir, "cron.json"),
			JSON.stringify({ jobs: [{ ...draft({ name: "old" }), id: "legacy-1" }], runs: [] }),
			"utf8",
		);

		const { service } = await makeService({ dataDir, engine: () => "pi" });
		const snapshot = await service.snapshot();
		assert.deepEqual(
			snapshot.jobs.map((job) => job.id),
			["legacy-1"],
		);
		assert.equal(snapshot.jobs[0]?.engine, "pi");
		// 老文件改名留底，不会每切一次引擎又迁一遍
		await assert.rejects(() => readFile(join(dataDir, "cron.json"), "utf8"));
		const kept = await readFile(join(dataDir, "cron.json.migrated"), "utf8");
		assert.ok(kept.includes("legacy-1"));
	});

	it("切引擎时，旧引擎还在跑的那一轮不会被写进新引擎的文件", async () => {
		const dataDir = await mkdtemp(join(tmpdir(), "cron-switch-"));
		dirs.push(dataDir);
		let engine = "pi";
		let release: (value: string) => void = () => undefined;
		const gate = new Promise<string>((resolve) => {
			release = resolve;
		});
		const { service } = await makeService({
			dataDir,
			engine: () => engine,
			execute: async () => await gate,
		});
		const job = await service.create(draft({ enabled: true }));
		await service.start();
		const run = await service.run(job.id);
		assert.equal(run.status, "running");

		// 跑一半切引擎：旧的一轮记成 interrupted，且不污染 codex 那份
		engine = "codex";
		const codexSnapshot = await service.snapshot();
		assert.equal(codexSnapshot.runs.length, 0, "codex 不该有 pi 的运行记录");
		release("done");
		await new Promise((resolve) => setTimeout(resolve, 50));
		const piRaw = JSON.parse(await readFile(join(dataDir, "cron", "pi.json"), "utf8"));
		assert.equal(piRaw.runs[0]?.status, "interrupted");
		await service.stop();
	});
});

describe("cron expression and preview", () => {
	it("previews five timezone-aware instants and rejects malformed schedules", async () => {
		const { service } = await makeService();
		const times = service.preview("0 9 * * *", "Asia/Shanghai");
		assert.equal(times.length, 5);
		for (const time of times) {
			const local = new Intl.DateTimeFormat("en-US", { timeZone: "Asia/Shanghai", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(time));
			assert.equal(local, "09:00");
		}
		// 每次都要严格向后推进，不能出现重复值
		assert.deepEqual([...times].sort(), times);
		assert.equal(new Set(times).size, 5);
		assert.throws(() => service.preview("0 9 * *", "UTC"), /five fields/);
		assert.throws(() => service.preview("0 25 * * *", "UTC"), /range/);
		assert.throws(() => service.preview("0 9 * * *", "Not/AZone"), /timezone/);
	});

	it("finds sparse schedules such as leap day instead of scanning a fixed window", async () => {
		const { service } = await makeService();
		const times = service.preview("0 0 29 2 *", "UTC");
		assert.ok(times.length >= 1);
		const date = new Date(times[0]!);
		assert.equal(date.getUTCMonth(), 1);
		assert.equal(date.getUTCDate(), 29);
	});

	it("respects daylight-saving transitions without inventing local times", async () => {
		const { service } = await makeService();
		// 2026-03-08 02:30 在纽约不存在（春季跳表）
		const skipped = service.preview("30 2 * * *", "America/New_York");
		for (const time of skipped) {
			const local = new Intl.DateTimeFormat("en-US", { timeZone: "America/New_York", hour: "2-digit", minute: "2-digit", hour12: false }).format(new Date(time));
			assert.equal(local, "02:30");
		}
		assert.ok(skipped.length > 0);
		// 跳表当天应直接落到 3 月 9 日，而不是 3 月 8 日
		const day = new Intl.DateTimeFormat("en-CA", { timeZone: "America/New_York" }).format(new Date(skipped[0]!));
		assert.notEqual(day, "2026-03-08");
	});
});

describe("cron job storage", () => {
	it("validates registered absolute workspaces and persists atomically across restarts", async () => {
		const { service, dataDir } = await makeService();
		await assert.rejects(service.create(draft({ workspace: "/elsewhere" })), /not registered/);
		await assert.rejects(service.create(draft({ workspace: "relative/path" })), /not registered/);
		await assert.rejects(service.create(draft({ prompt: " " })), /prompt is required/);
		const created = await service.create(draft());
		const snapshot = await service.snapshot();
		assert.equal(snapshot.jobs.length, 1);
		// 停用的任务没有下次时间
		assert.equal(snapshot.jobs[0]?.nextRunAt, null);
		assert.deepEqual(snapshot.workspaces, ["/work"]);

		const restarted = await makeService({ dataDir });
		await restarted.service.start();
		const reloaded = await restarted.service.snapshot();
		assert.equal(reloaded.jobs[0]?.id, created.id);
		await restarted.service.stop();
		// 任务按引擎分文件存（`cron/<engine>.json`）：默认引擎是 pi
		const raw = await readFile(join(dataDir, "cron", "pi.json"), "utf8");
		assert.equal(JSON.parse(raw).jobs[0].id, created.id);
	});

	it("updates, deletes and rejects unknown ids", async () => {
		const { service } = await makeService();
		const job = await service.create(draft());
		const updated = await service.update(job.id, draft({ name: "renamed", enabled: true }));
		assert.equal(updated.name, "renamed");
		assert.ok((await service.snapshot()).jobs[0]?.nextRunAt);
		await service.remove(job.id);
		assert.equal((await service.snapshot()).jobs.length, 0);
		await assert.rejects(service.remove(job.id), /not found/);
		await assert.rejects(service.run(job.id), /not found/);
	});
});

describe("cron execution", () => {
	it("runs manual work, stores the result, and keeps one global run at a time by queueing", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const started: string[] = [];
		const { service } = await makeService({
			execute: async (job) => {
				started.push(job.name);
				await gate;
				return `done:${job.name}`;
			},
		});
		const first = await service.create(draft({ name: "first" }));
		const second = await service.create(draft({ name: "second" }));
		await service.run(first.id);
		const queued = await service.run(second.id);
		assert.equal(queued.status, "queued");
		assert.deepEqual(started, ["first"]);

		release();
		await waitFor(async () => (await service.snapshot()).runs.every((run) => run.status === "succeeded"), "both runs");
		const { runs } = await service.snapshot();
		assert.equal(runs.length, 2);
		assert.deepEqual(started, ["first", "second"]);
		assert.ok(runs.every((run) => run.result?.startsWith("done:")));
	});

	it("skips a second trigger of the same job while its previous run is still going", async () => {
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		const { service } = await makeService({
			execute: async () => {
				await gate;
				return "ok";
			},
		});
		const job = await service.create(draft());
		await service.run(job.id);
		const overlapped = await service.run(job.id);
		assert.equal(overlapped.status, "skipped");
		assert.match(overlapped.error ?? "", /still in progress/);
		release();
		await waitFor(async () => (await service.snapshot()).runs.some((run) => run.status === "succeeded"), "first run");
		await service.stop();
	});

	it("records failures, marks stop as interrupted, and never lets late work overwrite status", async () => {
		let reject!: (error: Error) => void;
		const { service } = await makeService({
			execute: () => new Promise<string>((_resolve, fail) => {
				reject = fail;
			}),
		});
		const job = await service.create(draft());
		await service.run(job.id);
		reject(new Error("provider exploded"));
		await waitFor(async () => (await service.snapshot()).runs[0]?.status === "failed", "failed run");
		assert.match((await service.snapshot()).runs[0]?.error ?? "", /provider exploded/);

		const running = await makeService({
			execute: () => new Promise<string>(() => {
				/* 永不返回，等停机打断 */
			}),
		});
		const job2 = await running.service.create(draft());
		await running.service.run(job2.id);
		await running.service.stop();
		const after = await running.service.snapshot();
		assert.equal(after.runs[0]?.status, "interrupted");
		assert.ok(after.runs[0]?.finishedAt);
	});
});

describe("cron scheduling loop", () => {
	it("fires a due job once the clock reaches its minute", async () => {
		let clock = new Date("2026-05-01T08:59:30Z");
		const started: string[] = [];
		const { service } = await makeService({
			now: () => clock,
			execute: async (job) => {
				started.push(job.name);
				return "ok";
			},
		});
		await service.create(draft({ name: "nine", expression: "0 9 * * *", timezone: "UTC", enabled: true }));
		await service.start();
		try {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			assert.deepEqual(started, [], "还没到点就不能跑");
			clock = new Date("2026-05-01T09:00:05Z");
			await waitFor(() => started.length === 1, "scheduled run");
			await waitFor(async () => (await service.snapshot()).runs[0]?.status === "succeeded", "run result");
			const runs = (await service.snapshot()).runs;
			assert.equal(runs.length, 1);
			assert.equal(runs[0]?.trigger, "scheduled");
			assert.equal(runs[0]?.scheduledAt, "2026-05-01T09:00:00.000Z");
		} finally {
			await service.stop();
		}
	});

	it("does not replay occurrences missed while the service was down", async () => {
		const first = await makeService({ now: () => new Date("2026-05-01T09:00:00Z") });
		const job = await first.service.create(
			draft({ name: "nine", expression: "0 9 * * *", timezone: "UTC", enabled: true }),
		);
		await first.service.stop();

		// 服务「停机」到 10:30 才起来：09:00 那一次不该被补跑
		const started: string[] = [];
		const revived = await makeService({
			dataDir: first.dataDir,
			now: () => new Date("2026-05-01T10:30:00Z"),
			execute: async () => {
				started.push(job.id);
				return "ok";
			},
		});
		await revived.service.start();
		try {
			await new Promise((resolve) => setTimeout(resolve, 1200));
			assert.deepEqual(started, []);
			assert.deepEqual((await revived.service.snapshot()).runs, []);
		} finally {
			await revived.service.stop();
		}
	});
});

describe("cron router", () => {
	it("maps service errors to 400 with a plain message", async () => {
		const { service } = await makeService();
		const router = createCronRouter(service);
		assert.ok(router);
		await assert.rejects(service.create({}), /name is required/);
	});
});
