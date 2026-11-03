/**
 * 生成 og 图（社交分享卡片 1280×630）。
 *
 * 唯一事实源是 `docs/site/assets/og.svg`（版式、文案、配色都在那儿改）与
 * `docs/screenshots/01-chat.png`（卡片右边那张真实界面）：
 * 改设计 → 跑一次这个脚本 → 提交生成的 `docs/site/assets/og.png`。**不要手改 PNG**。
 *
 * 为什么要多这一步「把截图内联成 base64」：SVG 里写相对路径的 `<image>` 时，
 * rsvg-convert 会**静默跳过**外部位图（渲染出来右边是个空框，不报错），
 * Chromium 也会因 file:// 的同源限制拿不到。内联成 data URI 两边都稳。
 *
 * 用法：
 *   node scripts/make-og.mjs
 *
 * 渲染后端：优先 `rsvg-convert`（librsvg）；没有就回落到仓库已依赖的 playwright-core。
 */
import { existsSync, statSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const run = promisify(execFile);
/** 仓库根（相对本文件，而不是 cwd：从哪里调用都一样） */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const SVG = join(REPO_ROOT, "docs/site/assets/og.svg");
const SHOT = join(REPO_ROOT, "docs/screenshots/01-chat.png");
const OUT = join(REPO_ROOT, "docs/site/assets/og.png");
const W = 1280;
const H = 630;

const svg = await readFile(SVG, "utf8");
const shotB64 = (await readFile(SHOT)).toString("base64");

// 把 SVG 里所有指向截图的 href 换成 data URI（xlink:href 与 href 两种写法都照顾到）
const inlined = svg.replace(
	/(xlink:href|href)="(\.\.\/)+screenshots\/[^"]+"/g,
	`$1="data:image/png;base64,${shotB64}"`,
);
if (inlined === svg) throw new Error(`og.svg 里没找到截图引用（期望 ../../screenshots/*.png），检查一下路径`);

async function viaRsvg() {
	// 不能把 SVG 从 stdin 喂给 rsvg-convert：`execFile` 没有 input 选项（那是 spawnSync 的），
	// 会静默挂在那里等 stdin。写临时文件最省事。
	const dir = await mkdtemp(join(tmpdir(), "og-"));
	const tmp = join(dir, "og.svg");
	await writeFile(tmp, inlined);
	try {
		await run("rsvg-convert", ["-w", String(W), "-h", String(H), "-o", OUT, tmp]);
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function viaChromium() {
	const { chromium } = await import("playwright-core");
	const browser = await chromium.launch({ executablePath: process.env.CHROME_PATH || undefined });
	try {
		const page = await browser.newPage({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
		// 直接把内联好的 <svg> 塞进 HTML：data URI 的位图不会被当成跨源资源拦掉
		const body = inlined.replace(/^<\?xml[^>]*\?>\s*/, "");
		await page.setContent(
			`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:#0a0e18}svg{display:block}</style></head><body>${body}</body></html>`,
			{ waitUntil: "load" },
		);
		await page.screenshot({ path: OUT, type: "png" });
	} finally {
		await browser.close();
	}
}

const hasRsvg = await (async () => {
	try {
		await run("rsvg-convert", ["--version"]);
		return true;
	} catch {
		return false;
	}
})();

if (hasRsvg) await viaRsvg();
else if (existsSync(join(REPO_ROOT, "node_modules/playwright-core"))) {
	console.warn("没装 rsvg-convert，回落到 Chromium 渲染（要能拿到浏览器：CHROME_PATH 或 playwright 自带的）");
	await viaChromium();
} else {
	throw new Error(
		"需要 rsvg-convert（brew install librsvg / apt install librsvg2-bin），或装回 devDependencies 用 Chromium 渲染",
	);
}

console.log(`写好了 ${OUT.slice(REPO_ROOT.length)}（${W}×${H}，${Math.round(statSync(OUT).size / 1024)}KB）`);
