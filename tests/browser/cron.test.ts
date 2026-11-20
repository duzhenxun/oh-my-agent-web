import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";
import type { CronDraft, CronJob, CronRun } from "../../web/src/cron.ts";

/**
 * Isolated frontend fixture + mocked HTTP contract. Never contacts the live backend.
 *
 * 本机 playwright-core 自带的 chromium 可能没装，用系统 Chrome 跑：
 *   CRON_TEST_BROWSER_CHANNEL=chrome node --import tsx --test tests/browser/cron.test.ts
 */
describe("Cron workbench panel", { timeout: 120_000 }, () => {
	let vite: ViteDevServer;
	let browser: Browser;
	let base: string;
	let cacheDir: string;
	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), "cron-panel-test-"));
		vite = await createServer({
			cacheDir,
			configFile: false,
			root: fileURLToPath(new URL("../../", import.meta.url)),
			plugins: [
				react(),
				{
					name: "cron-test-fixture",
					configureServer(server) {
						server.middlewares.use("/__cron-test", (_req, res) => {
							res.setHeader("content-type", "text/html");
							res.end(
								'<!doctype html><html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/tests/fixtures/cron-panel.tsx"></script></body></html>',
							);
						});
					},
				},
			],
			server: { host: "127.0.0.1", port: 0, watch: null },
		});
		await vite.listen();
		const address = vite.httpServer!.address();
		assert.ok(address && typeof address !== "string");
		base = `http://127.0.0.1:${address.port}`;
		browser = await chromium.launch({ headless: true, channel: process.env.CRON_TEST_BROWSER_CHANNEL });
	});
	after(async () => {
		await browser?.close();
		await vite?.close();
		if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
	});

	async function fixture(width = 1200, lang = "en", workspaces = ["/registered/project", "/registered/other"]) {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		let jobs: CronJob[] = [
			{
				id: "job-1",
				name: "Morning check",
				workspace: "/registered/project",
				prompt: "Inspect project",
				expression: "0 9 * * *",
				timezone: "UTC",
				enabled: true,
				nextRunAt: "2026-11-20T09:00:00Z",
			},
		];
		let runs: CronRun[] = [
			{
				id: "run-1",
				jobId: "job-1",
				status: "succeeded",
				trigger: "scheduled",
				scheduledAt: "2026-11-19T09:00:00Z",
				startedAt: "2026-11-19T09:00:01Z",
				finishedAt: "2026-11-19T09:00:02Z",
				result: "<script>window.cronUnsafe = true</script>\n**Plain text result**",
			},
		];
		const calls: { method: string; path: string; body: any }[] = [];
		let reads = 0;
		let failRun = false;
		await page.route("**/api/**", async (route) => {
			const request = route.request();
			const path = new URL(request.url()).pathname;
			const method = request.method();
			const body = request.postDataJSON();
			calls.push({ method, path, body });
			if (path === "/api/cron" && method === "GET") {
				reads++;
				await route.fulfill({ json: { jobs, runs, workspaces } });
			} else if (path === "/api/cron/preview") {
				if (body.timezone === "Invalid/Zone" || body.expression.startsWith("bad"))
					await route.fulfill({ status: 400, json: { error: "Invalid schedule or timezone" } });
				else await route.fulfill({ json: { times: ["2026-11-20T09:00:00Z"] } });
			} else if (path.endsWith("/run")) {
				if (failRun) await route.fulfill({ status: 409, json: { error: "Already running" } });
				else {
					runs = [{ id: `run-${runs.length + 1}`, jobId: "job-1", status: "queued", trigger: "manual" }, ...runs];
					await route.fulfill({ status: 204 });
				}
			} else if (method === "POST" && path === "/api/cron/jobs") {
				jobs = [...jobs, { ...(body as CronDraft), id: "job-2", nextRunAt: null }];
				await route.fulfill({ status: 204 });
			} else if (method === "PUT") {
				jobs = jobs.map((job) => (path.endsWith(job.id) ? { ...job, ...body } : job));
				await route.fulfill({ status: 204 });
			} else if (method === "DELETE") {
				jobs = jobs.filter((job) => !path.endsWith(job.id));
				await route.fulfill({ status: 204 });
			} else {
				await route.fulfill({ status: 404, json: { error: "Unexpected API request" } });
			}
		});
		await page.clock.install();
		await page.goto(`${base}/__cron-test?lang=${lang}`);
		await page.locator(".cron-job").first().waitFor();
		return {
			page,
			calls,
			reads: () => reads,
			failRun: () => {
				failRun = true;
			},
		};
	}
	const jobCard = (page: Page, name = "Morning check") =>
		page.locator(".cron-job").filter({ has: page.getByRole("heading", { name, exact: true }) });
	const waitFor = async (predicate: () => boolean) => {
		for (let i = 0; i < 100; i++) {
			if (predicate()) return;
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
		assert.ok(predicate());
	};

	it("is a first-level panel with safe text history, complete actions, errors, and polling only while open", async () => {
		const { page, calls, reads, failRun } = await fixture();
		try {
			assert.equal(await page.locator('.big-modal-head [data-panel-key="cron"]').count(), 1);
			await page.getByText("Succeeded", { exact: true }).click();
			assert.equal(
				await page.locator(".cron-result").textContent(),
				"<script>window.cronUnsafe = true</script>\n**Plain text result**",
			);
			assert.equal(await page.locator(".cron-result script, .cron-result strong").count(), 0);
			await jobCard(page).getByRole("button", { name: "Pause", exact: true }).click();
			await jobCard(page).getByText("Paused", { exact: true }).waitFor();
			assert.equal(calls.find((call) => call.method === "PUT")?.body.enabled, false);
			assert.deepEqual(
				Object.keys(calls.find((call) => call.method === "PUT")!.body).sort(),
				["name", "workspace", "prompt", "expression", "timezone", "enabled", "mode", "allowWrites", "sessionId", "model"].sort(),
			);
			await jobCard(page).getByRole("button", { name: "Enable", exact: true }).click();
			await jobCard(page).getByText("Enabled", { exact: true }).waitFor();
			await jobCard(page).getByRole("button", { name: "Run now" }).click();
			await page.getByText("Queued", { exact: true }).waitFor();
			failRun();
			await jobCard(page).getByRole("button", { name: "Run now" }).click();
			await page.getByRole("alert").filter({ hasText: "Already running" }).waitFor();
			await jobCard(page).getByRole("button", { name: "Delete", exact: true }).click();
			assert.equal(calls.filter((call) => call.method === "DELETE").length, 0);
			await jobCard(page).getByRole("button", { name: "Confirm deletion" }).click();
			await page.getByText("No scheduled jobs yet").waitFor();
			const beforePoll = reads();
			await page.clock.fastForward(5_001);
			await waitFor(() => reads() > beforePoll);
			await page.locator(".big-modal-close").click();
			const closedReads = reads();
			await page.clock.fastForward(20_000);
			assert.equal(reads(), closedReads);
			await page.locator('.side-foot-row [data-panel-key="cron"]').click();
			await page.getByText("No scheduled jobs yet").waitFor();
			assert.ok(reads() > closedReads);
			assert.equal(calls.filter((call) => !call.path.startsWith("/api/cron")).length, 0);
		} finally {
			await page.close();
		}
	});

	it("creates weekly and advanced drafts using registered workspaces and a server-validated preview", async () => {
		const { page, calls } = await fixture();
		try {
			await page.getByRole("button", { name: "New job", exact: true }).click();
			await page.getByLabel("Name", { exact: true }).fill("Weekly report");
			await page.getByLabel("Prompt", { exact: true }).fill("Summarize the project");
			const workspace = page.getByLabel("Workspace", { exact: true });
			assert.equal(await workspace.locator("option").count(), 3);
			await workspace.selectOption("/registered/other");
			await page.getByLabel("Schedule", { exact: true }).selectOption("weekly");
			await page.getByLabel("Weekday", { exact: true }).selectOption("5");
			await page.getByLabel("Time", { exact: true }).fill("18:30");
			await page.getByLabel("Timezone", { exact: true }).fill("Invalid/Zone");
			await page.getByRole("alert").filter({ hasText: "Invalid schedule or timezone" }).waitFor();
			assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
			await page.getByLabel("Timezone", { exact: true }).fill("Asia/Shanghai");
			await page.locator(".cron-preview li").waitFor();
			if (process.env.CRON_TEST_SCREENSHOT_DIR)
				await page.screenshot({ path: join(process.env.CRON_TEST_SCREENSHOT_DIR, "desktop.png"), fullPage: true });
			assert.equal(await page.getByLabel("Prompt", { exact: true }).count(), 1, await page.locator("body").innerText());
			const beforeRefresh = await page.getByLabel("Prompt", { exact: true }).inputValue();
			await page.clock.fastForward(5_001);
			assert.equal(await page.getByLabel("Prompt", { exact: true }).inputValue(), beforeRefresh);
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await jobCard(page, "Weekly report").waitFor();
			assert.deepEqual(calls.find((call) => call.method === "POST" && call.path === "/api/cron/jobs")?.body, {
				name: "Weekly report",
				workspace: "/registered/other",
				prompt: "Summarize the project",
				expression: "30 18 * * 5",
				timezone: "Asia/Shanghai",
				enabled: true,
				// 新任务默认是文本任务；agent 任务要用户在「任务类型」里显式选
				mode: "text",
				allowWrites: false,
				sessionId: "",
				model: "",
			});
			await jobCard(page, "Weekly report").getByRole("button", { name: "Edit", exact: true }).click();
			await page.getByLabel("Schedule", { exact: true }).selectOption("advanced");
			await page.getByLabel("Minute", { exact: true }).fill("*/10");
			await page.getByLabel("Hour", { exact: true }).fill("*");
			await page.locator(".cron-preview li").waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await waitFor(() => calls.some((call) => call.method === "PUT" && call.body.expression === "*/10 * * * 5"));
		} finally {
			await page.close();
		}
	});

	it("offers interval schedules and turns them into a valid cron expression", async () => {
		const { page, calls } = await fixture();
		try {
			await page.getByRole("button", { name: "New job", exact: true }).click();
			await page.getByLabel("Name", { exact: true }).fill("Frequent check");
			await page.getByLabel("Prompt", { exact: true }).fill("Check the build");
			await page.getByLabel("Workspace", { exact: true }).selectOption("/registered/project");
			// 每隔 N 分钟：表达式由预设生成，不是手写
			await page.getByLabel("Schedule", { exact: true }).selectOption("minutes");
			await page.getByLabel("Every (minutes)", { exact: true }).fill("15");
			assert.equal(await page.locator(".cron-expression").innerText(), "*/15 * * * *");
			await page.locator(".cron-preview li").waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await jobCard(page, "Frequent check").waitFor();
			assert.equal(
				calls.find((call) => call.method === "POST" && call.path === "/api/cron/jobs")?.body.expression,
				"*/15 * * * *",
			);
			// 每隔 N 小时：换成小时单位后表达式跟着变
			await jobCard(page, "Frequent check").getByRole("button", { name: "Edit", exact: true }).click();
			await page.getByLabel("Schedule", { exact: true }).selectOption("hours");
			await page.getByLabel("Every (hours)", { exact: true }).fill("6");
			assert.equal(await page.locator(".cron-expression").innerText(), "0 */6 * * *");
			await page.locator(".cron-preview li").waitFor();
			await page.getByRole("button", { name: "Save", exact: true }).click();
			await waitFor(() => calls.some((call) => call.method === "PUT" && call.body.expression === "0 */6 * * *"));
		} finally {
			await page.close();
		}
	});

	it("blocks saving an unregistered workspace and never offers arbitrary path entry", async () => {
		const { page, calls } = await fixture(1200, "en", []);
		try {
			await jobCard(page).getByRole("button", { name: "Edit", exact: true }).click();
			await page.getByText("Register a project workspace first.").waitFor();
			await page.locator(".cron-preview li").waitFor();
			assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
			assert.equal(
				await page.getByLabel("Workspace", { exact: true }).evaluate((element) => element.tagName),
				"SELECT",
			);
			assert.equal(await page.getByLabel("Workspace", { exact: true }).locator("option:enabled").count(), 0);
			assert.equal(calls.filter((call) => call.path === "/api/cron/jobs" && call.method === "POST").length, 0);
		} finally {
			await page.close();
		}
	});

	it("stacks the editor on mobile, stays within the viewport, and translates the Cron tab", async () => {
		const { page } = await fixture(390, "zh");
		try {
			await page.getByRole("button", { name: "新建任务", exact: true }).click();
			await page.getByText("任务设置", { exact: true }).waitFor();
			if (process.env.CRON_TEST_SCREENSHOT_DIR)
				await page.screenshot({ path: join(process.env.CRON_TEST_SCREENSHOT_DIR, "mobile.png"), fullPage: true });
			assert.equal(await page.locator('.big-modal-head [data-panel-key="cron"]').textContent(), "定时任务");
			const boxes = await page.locator(".cron-layout, .cron-jobs, .cron-detail, .cron-editor").evaluateAll((elements) =>
				elements.map((element) => {
					const rect = element.getBoundingClientRect();
					return { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom };
				}),
			);
			for (const box of boxes) {
				assert.ok(box.left >= 0);
				assert.ok(box.right <= 390);
			}
			assert.ok(boxes[2]!.top >= boxes[1]!.bottom);
		} finally {
			await page.close();
		}
	});
});
