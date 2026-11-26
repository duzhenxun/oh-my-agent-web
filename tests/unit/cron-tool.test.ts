import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, it } from "node:test";
import { createCronService } from "../../server/cron/index.ts";
import { createCronToolPort, cronDraftFromArgs, cronPatchFromArgs, type CronToolContext } from "../../server/cron/tool.ts";

const dirs: string[] = [];
async function makeDataDir(): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), "cron-tool-"));
	dirs.push(dir);
	return dir;
}
afterEach(async () => {
	// run_now 类用例会在后台继续写 cron.json，删目录可能撞上「刚写了一半」
	for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 });
});

const ctx: CronToolContext = { conversationId: "conv-1", workspace: "/work", timezone: "Asia/Shanghai" };

async function makePort() {
	const dataDir = await makeDataDir();
	const service = createCronService({ dataDir, execute: async () => "ok", workspaces: () => ["/work"] });
	return { dataDir, service, port: createCronToolPort(service) };
}

describe("cron 工具的默认值（在会话里说「建个定时任务」时要什么）", () => {
	it("默认是 agent 任务、跑在当前这条会话里、只读", () => {
		const draft = cronDraftFromArgs({ prompt: "看一眼群里有没有要改的 bug", schedule: "*/10 * * * *" }, ctx);
		assert.equal(draft.mode, "agent");
		assert.equal(draft.sessionId, "conv-1");
		assert.equal(draft.allowWrites, false);
		assert.equal(draft.workspace, "/work");
		assert.equal(draft.timezone, "Asia/Shanghai");
		assert.equal(draft.enabled, true);
		assert.equal(draft.expression, "*/10 * * * *");
	});

	it("没给名字就用提示词第一行，太长的截断", () => {
		const draft = cronDraftFromArgs({ prompt: "\n\n每天汇总一下\n第二行\n", schedule: "0 9 * * *" }, ctx);
		assert.equal(draft.name, "每天汇总一下");
		const long = cronDraftFromArgs({ prompt: "一".repeat(50), schedule: "0 9 * * *" }, ctx);
		assert.equal([...(long.name as string)].length, 24);
	});

	it("显式要独立会话 / 文本任务时，不绑会话", () => {
		const fresh = cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *", scope: "new" }, ctx);
		assert.equal(fresh.sessionId, undefined);
		const text = cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *", mode: "text", allow_writes: true }, ctx);
		assert.equal(text.sessionId, undefined);
		assert.equal(text.allowWrites, false); // 文本任务不碰磁盘，开关没有意义
	});

	it("缺 prompt / schedule 时直接说清楚缺什么（而不是建出一个空任务）", () => {
		assert.throws(() => cronDraftFromArgs({ schedule: "0 9 * * *" }, ctx), /prompt 必填/);
		assert.throws(() => cronDraftFromArgs({ prompt: "p" }, ctx), /schedule 必填/);
	});

	it("改造时只带上用户真正说过的那几项；scope 决定会话绑定", () => {
		assert.deepEqual(cronPatchFromArgs({ job_id: "x" }, ctx), {});
		assert.deepEqual(cronPatchFromArgs({ prompt: "新提示词", scope: "new" }, ctx), {
			prompt: "新提示词",
			sessionId: "",
		});
		assert.deepEqual(cronPatchFromArgs({ scope: "session", schedule: "0 10 * * *" }, ctx), {
			expression: "0 10 * * *",
			sessionId: "conv-1",
		});
	});
});

describe("cron 工具端口：建 / 查 / 改 / 停 / 删", () => {
	it("建出来的任务带 id 和下次时间，并且真写进了 cron/pi.json", async () => {
		const { dataDir, port } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "看一眼群", schedule: "*/10 * * * *" }, ctx));
		assert.ok(job.id);
		assert.equal(job.sessionId, "conv-1");
		assert.equal(job.mode, "agent");
		assert.ok(job.nextRunAt);
		const raw = JSON.parse(await readFile(join(dataDir, "cron", "pi.json"), "utf8")) as {
			jobs: Array<{ id: string; sessionId?: string }>;
		};
		assert.equal(raw.jobs[0]?.id, job.id);
		assert.equal(raw.jobs[0]?.sessionId, "conv-1");
	});

	it("list 让模型看到 id / 频率 / 下次时间；停用后下次时间变空", async () => {
		const { port } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *" }, ctx));
		const [listed] = await port.list();
		assert.equal(listed?.id, job.id);
		assert.equal(listed?.expression, "0 9 * * *");
		assert.ok(listed?.nextRunAt);
		const off = await port.setEnabled(job.id, false);
		assert.equal(off.enabled, false);
		assert.equal(off.nextRunAt, null);
		assert.equal((await port.list())[0]?.enabled, false);
	});

	it("update 只改传进来的字段，会话绑定还在", async () => {
		const { port } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "老提示词", schedule: "0 9 * * *" }, ctx));
		const updated = await port.update(job.id, cronPatchFromArgs({ prompt: "新提示词" }, ctx));
		assert.equal(updated.prompt, "新提示词");
		assert.equal(updated.sessionId, "conv-1");
		assert.equal(updated.expression, "0 9 * * *");
	});

	it("scope: new 能把已有任务改成每次新开会话", async () => {
		const { port } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *" }, ctx));
		const detached = await port.update(job.id, cronPatchFromArgs({ scope: "new" }, ctx));
		assert.equal(detached.sessionId, undefined);
	});

	it("删掉之后 list 为空；再操作同一个 id 会提示去看 id", async () => {
		const { port } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *" }, ctx));
		await port.remove(job.id);
		assert.deepEqual(await port.list(), []);
		await assert.rejects(port.remove(job.id), /找不到定时任务/);
		await assert.rejects(port.remove(""), /job_id 必填/);
	});

	it("非法 cron 表达式在建的时候就失败，不会留下半成品任务", async () => {
		const { port } = await makePort();
		await assert.rejects(
			port.create(cronDraftFromArgs({ prompt: "p", schedule: "每天九点" }, ctx)),
			/invalid|must have five fields/,
		);
		assert.deepEqual(await port.list(), []);
	});

	it("非法/未登记的工作区被拒绝（不让人在任意目录里排任务）", async () => {
		const { port } = await makePort();
		await assert.rejects(
			port.create(cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *", workspace: "/elsewhere" }, ctx)),
			/workspace is not registered/,
		);
	});

	it("preview 给前 5 次时间，表达式为空时直接报错", async () => {
		const { port } = await makePort();
		const times = port.preview("0 9 * * *", "Asia/Shanghai");
		assert.equal(times.length, 5);
		for (const iso of times) assert.ok(!Number.isNaN(new Date(iso).getTime()));
		assert.throws(() => port.preview("  ", "Asia/Shanghai"), /schedule 必填/);
	});

	it("run_now 把任务排进队列，运行记录里能看到", async () => {
		const { port, service } = await makePort();
		const job = await port.create(cronDraftFromArgs({ prompt: "p", schedule: "0 9 * * *" }, ctx));
		const run = await port.runNow(job.id);
		assert.equal(run.jobId, job.id);
		assert.equal(run.trigger, "manual");
		const snapshot = await service.snapshot();
		assert.equal(snapshot.runs.length, 1);
		// 等后台那次执行真正写完再返回，否则 cleanup 会和写盘撞车
		await service.stop();
	});
});
