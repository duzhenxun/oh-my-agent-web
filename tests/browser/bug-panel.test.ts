import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser, type Page } from "playwright-core";
import { createServer, type ViteDevServer } from "vite";
import react from "@vitejs/plugin-react";

/**
 * 「提 Bug」面板：填一句话 → 点按钮 → 打开的是**带预填参数的 GitHub 新建 issue 页**。
 *
 * 隔离的前端夹具（`tests/fixtures/bug-panel.tsx`），不碰真实后端。
 * 本机 playwright 自带的 chromium 可能没装，用系统 Chrome 跑：
 *   BUG_TEST_BROWSER_CHANNEL=chrome node --import tsx --test tests/browser/bug-panel.test.ts
 */
describe("Bug report panel", { timeout: 120_000 }, () => {
	let vite: ViteDevServer;
	let browser: Browser;
	let base: string;
	let cacheDir: string;
	before(async () => {
		cacheDir = await mkdtemp(join(tmpdir(), "bug-panel-test-"));
		vite = await createServer({
			cacheDir,
			configFile: false,
			root: fileURLToPath(new URL("../../", import.meta.url)),
			plugins: [
				react(),
				{
					name: "bug-test-fixture",
					configureServer(server) {
						server.middlewares.use("/__bug-test", (_req, res) => {
							res.setHeader("content-type", "text/html");
							res.end(
								'<!doctype html><html><head><script type="module">import RefreshRuntime from "/@react-refresh"; RefreshRuntime.injectIntoGlobalHook(window); window.$RefreshReg$ = () => {}; window.$RefreshSig$ = () => (type) => type; window.__vite_plugin_react_preamble_installed__ = true;</script></head><body><div id="root"></div><script type="module" src="/tests/fixtures/bug-panel.tsx"></script></body></html>',
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
		browser = await chromium.launch({ headless: true, channel: process.env.BUG_TEST_BROWSER_CHANNEL });
	});
	after(async () => {
		await browser?.close();
		await vite?.close();
		if (cacheDir) await rm(cacheDir, { recursive: true, force: true });
	});

	/** 每次开一页：把 `window.open` 换成记账版（真开标签会去 github.com，测试里只关心 URL） */
	async function open(lang = "en", width = 1200): Promise<{ page: Page; opened: string[] }> {
		const page = await browser.newPage({ viewport: { width, height: 900 } });
		await page.addInitScript(() => {
			(window as unknown as { __opened: string[] }).__opened = [];
			window.open = ((url: string) => {
				(window as unknown as { __opened: string[] }).__opened.push(String(url));
				return null;
			}) as typeof window.open;
		});
		await page.goto(`${base}/__bug-test?lang=${lang}`);
		await page.waitForSelector(".bug-panel");
		return { page, opened: [] };
	}

	it("没写标题时提交按钮是灰的，写了才亮", async () => {
		const { page } = await open();
		const submit = page.getByRole("button", { name: "Open a GitHub issue" });
		assert.equal(await submit.isDisabled(), true);
		await page.locator(".bug-input").fill("my message is hidden behind the top bar");
		assert.equal(await submit.isDisabled(), false);
		await page.close();
	});

	it("点提交打开的是本仓库 issues/new，标题和正文都预填好了", async () => {
		const { page } = await open();
		await page.locator(".bug-input").fill("message hidden behind top bar");
		await page.locator(".bug-textarea").fill("expected: below the bar\nactual: cut in half");
		await page.getByRole("button", { name: "Open a GitHub issue" }).click();
		const opened = await page.evaluate(() => (window as unknown as { __opened: string[] }).__opened);
		assert.equal(opened.length, 1);
		const url = new URL(opened[0]!);
		assert.equal(url.origin + url.pathname, "https://github.com/duzhenxun/oh-my-agent-web/issues/new");
		assert.equal(url.searchParams.get("title"), "message hidden behind top bar");
		assert.equal(url.searchParams.get("labels"), "bug");
		const body = url.searchParams.get("body") ?? "";
		assert.match(body, /## 发生了什么/);
		assert.match(body, /expected: below the bar/);
		assert.match(body, /## 环境/);
		await page.close();
	});

	it("预览里能看见「会带出去什么」，且家目录已经换成 ~", async () => {
		const { page } = await open("zh");
		await page.locator(".bug-input").fill("日志里带路径");
		await page.locator(".bug-textarea").fill("/Users/someone/work/project 崩了");
		await page.locator(".bug-preview summary").click();
		const preview = (await page.locator(".bug-preview pre").innerText()).replace(/\s+/g, " ");
		assert.match(preview, /~\/work\/project/);
		assert.doesNotMatch(preview, /Users\/someone/);
		await page.close();
	});
});
