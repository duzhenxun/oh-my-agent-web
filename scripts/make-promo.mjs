/**
 * 生成**广告 / 品牌图**（K6 图标 + 真实界面截图 + 石墨黑底）。
 *
 * 唯一事实源：
 *   - 图标：`web/public/favicon.svg`（就是 App 用的那枚，改图 → 重跑 `npm run icons` → 再跑本脚本）
 *   - 截图：`docs/screenshots/*.png`（真实运行留下的界面，不是拼图）
 *   - 版式：本文件里的 `TEMPLATES`（每张图一个函数，改文案/尺寸就改这里）
 *
 * 产物（都写进 `docs/brand/`）：
 *   og-1200x630.png      社交分享卡片（微信 / X / Slack 预览）
 *   banner-1500x500.png  GitHub / X 主页横幅
 *   square-1080x1080.png 方形贴图（朋友圈 / 小红书 / 群分享）
 *   hero-1600x900.png    落地页首屏
 *   logo-lockup-dark.svg / logo-lockup-light.svg  图标 + 字标横排（README / 站点用）
 *
 * 用法：node scripts/make-promo.mjs
 * 渲染：Chromium（仓库已依赖 playwright-core），2x 出图 → 文件大一点但缩到任何尺寸都清楚。
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

const ROOT = fileURLToPath(new URL("..", import.meta.url));
const OUT_DIR = join(ROOT, "docs", "brand");

const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
].filter(Boolean);

const dataUri = async (path, type) => `data:${type};base64,${(await readFile(path)).toString("base64")}`;

/** 品牌字标：K6 图标 + 「oh-my-agent-web」 */
const LOCKUP = (iconUri, opts = {}) => `
<div class="lockup" style="${opts.style ?? ""}">
	<img class="mark" src="${iconUri}" alt="" />
	<span class="wordmark">oh-my-agent-web</span>
</div>`;

const BASE_CSS = (ink, dim, accent) => `
* { box-sizing: border-box; margin: 0; padding: 0; }
html, body { background: #0b1220; }
body {
	font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Helvetica Neue", Arial, sans-serif;
	color: ${ink};
	-webkit-font-smoothing: antialiased;
}
.stage { position: relative; overflow: hidden; background:
	radial-gradient(900px 500px at 12% -10%, #1d3a63 0%, transparent 60%),
	radial-gradient(800px 520px at 110% 120%, #1b2a4a 0%, transparent 55%),
	linear-gradient(160deg, #0e1726 0%, #0b1220 55%, #080e18 100%); }
.grid { position: absolute; inset: 0;
	background-image:
		linear-gradient(rgba(255,255,255,.045) 1px, transparent 1px),
		linear-gradient(90deg, rgba(255,255,255,.045) 1px, transparent 1px);
	background-size: 48px 48px;
	mask-image: radial-gradient(70% 70% at 30% 30%, #000 0%, transparent 100%);
	-webkit-mask-image: radial-gradient(70% 70% at 30% 30%, #000 0%, transparent 100%); }
.lockup { display: inline-flex; align-items: center; gap: 18px; }
.mark { display: block; border-radius: 26%; }
.wordmark { font-weight: 700; letter-spacing: -0.02em; }
.eyebrow { font-weight: 600; color: ${accent}; letter-spacing: .16em; text-transform: uppercase; }
.muted { color: ${dim}; }
.shot { position: relative; border-radius: 18px; overflow: hidden; border: 1px solid rgba(255,255,255,.14);
	box-shadow: 0 40px 80px -30px rgba(0,0,0,.75), 0 0 0 1px rgba(0,0,0,.35) inset; background: #0e1726; }
.shot img { display: block; width: 100%; height: 100%; object-fit: cover; object-position: top left; }
.pill { display: inline-flex; align-items: center; gap: 8px; padding: 10px 18px; border-radius: 999px;
	border: 1px solid rgba(255,255,255,.16); color: ${ink}; font-weight: 500; background: rgba(255,255,255,.05); }
.dot { width: 8px; height: 8px; border-radius: 50%; background: ${accent}; }
`;

const TEMPLATES = [
	{
		file: "og-1200x630.png",
		width: 1200,
		height: 630,
		body: ({ icon, shot }) => `
		<div class="stage" style="width:1200px;height:630px;padding:56px 60px;display:flex;gap:44px">
			<div class="grid"></div>
			<div style="position:relative;flex:1 1 48%;display:flex;flex-direction:column;justify-content:space-between">
				${LOCKUP(icon, { style: "font-size:40px" }).replace('class="mark"', 'class="mark" style="width:64px;height:64px"')}
				<div>
					<div class="eyebrow" style="font-size:14px;margin-bottom:16px">多 Agent 工作台</div>
					<h1 style="font-size:52px;line-height:1.16;font-weight:700;letter-spacing:-0.02em">
						给正在跑的 agent<br/>配一个外部操作页
					</h1>
					<p style="margin-top:20px;font-size:20px;line-height:1.6" class="muted">
						多引擎 · 看得见的过程 · 随时插话纠正
					</p>
				</div>
				<div style="display:flex;gap:10px">
					<span class="pill" style="font-size:15px"><i class="dot"></i>pi · Codex · Claude</span>
					<span class="pill" style="font-size:15px">localhost · 单用户</span>
				</div>
			</div>
			<div class="shot" style="flex:1 1 52%;align-self:center;height:470px">
				<img src="${shot}" alt="" />
			</div>
		</div>`,
	},
	{
		file: "banner-1500x500.png",
		width: 1500,
		height: 500,
		body: ({ icon, shot }) => `
		<div class="stage" style="width:1500px;height:500px;display:flex;align-items:center">
			<div class="grid"></div>
			<div style="position:relative;padding-left:64px;flex:0 0 46%">
				${LOCKUP(icon, { style: "font-size:44px" }).replace('class="mark"', 'class="mark" style="width:72px;height:72px"')}
				<h2 style="margin-top:26px;font-size:34px;line-height:1.25;font-weight:600;letter-spacing:-0.01em">
					看它干活、管它的工具、<br/>随时插话
				</h2>
				<p class="muted" style="margin-top:14px;font-size:17px">会话事实源永远是引擎自己的落盘文件</p>
			</div>
			<div class="shot" style="position:absolute;right:-120px;top:56px;width:880px;height:520px;border-radius:20px">
				<img src="${shot}" alt="" />
			</div>
		</div>`,
	},
	{
		file: "square-1080x1080.png",
		width: 1080,
		height: 1080,
		body: ({ icon }) => `
		<div class="stage" style="width:1080px;height:1080px;display:flex;flex-direction:column;align-items:center;justify-content:center;text-align:center;padding:72px">
			<div class="grid"></div>
			<div style="position:relative;display:flex;flex-direction:column;align-items:center">
				<img src="${icon}" style="width:260px;height:260px" alt="" />
				<h1 style="margin-top:44px;font-size:96px;font-weight:700;letter-spacing:-0.03em">oh-my-agent-web</h1>
				<p style="margin-top:26px;font-size:30px;line-height:1.6;max-width:760px" class="muted">
					多引擎 agent 的统一工作台<br/>看得见思考与工具调用，随时插话
				</p>
				<div style="margin-top:44px;display:flex;gap:14px">
					<span class="pill" style="font-size:20px"><i class="dot"></i>pi</span>
					<span class="pill" style="font-size:20px">Codex</span>
					<span class="pill" style="font-size:20px">Claude Code</span>
					<span class="pill" style="font-size:20px">opencode</span>
				</div>
			</div>
		</div>`,
	},
	{
		file: "hero-1600x900.png",
		width: 1600,
		height: 900,
		body: ({ icon, shot }) => `
		<div class="stage" style="width:1600px;height:900px;padding:64px 80px 0;display:flex;flex-direction:column">
			<div class="grid"></div>
			<div style="position:relative;display:flex;align-items:center;justify-content:space-between">
				${LOCKUP(icon, { style: "font-size:34px" }).replace('class="mark"', 'class="mark" style="width:56px;height:56px"')}
				<div class="muted" style="font-size:16px">单用户 · 只听 127.0.0.1 · 不落自己的库</div>
			</div>
			<div style="position:relative;margin-top:44px;text-align:center">
				<h1 style="font-size:64px;line-height:1.14;font-weight:700;letter-spacing:-0.025em">
					你正在跑的 agent，<br/>值得一个能看的界面
				</h1>
				<p class="muted" style="margin-top:22px;font-size:22px">
					思考、工具调用、改动文件、token 与花费，全在一条时间线上
				</p>
			</div>
			<div class="shot" style="position:relative;margin:52px auto 0;width:1300px;height:420px;border-radius:20px 20px 0 0;border-bottom:none">
				<img src="${shot}" alt="" />
			</div>
		</div>`,
	},
];

const LOCKUP_SVG = (ink, accent, tileFrom, tileMid, tileTo) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 320 72" role="img" aria-label="oh-my-agent-web">
	<!-- oh-my-agent-web 横排字标（图标 + 文字）。图标与 App 同一枚（K6）；文字用系统无衬线的近似字形，
	     正式物料里要更精确，请单独取 docs/brand/logo-mark.svg 再叠字体。 -->
	<defs>
		<linearGradient id="tile" x1="0" y1="0" x2="64" y2="64" gradientUnits="userSpaceOnUse">
			<stop offset="0" stop-color="${tileFrom}" /><stop offset=".55" stop-color="${tileMid}" /><stop offset="1" stop-color="${tileTo}" />
		</linearGradient>
	</defs>
	<g transform="translate(4 4) scale(2)">
		<rect width="32" height="32" rx="7" fill="url(#tile)" />
		<g fill="#F8FAFC">
			<rect x="7.6" y="9" width="3.2" height="14" rx="1.6" />
			<path d="M10.8 9h4.4a4.4 4.4 0 0 1 0 8.8h-4.4v-2.8h4.2a1.6 1.6 0 0 0 0-3.2h-4.2z" />
		</g>
		<polygon points="26.81,18.4 26.81,22.8 23,25 19.19,22.8 19.19,18.4 23,16.2" fill="none" stroke="${accent}" stroke-width="1.8" stroke-linejoin="round" />
	</g>
	<text x="84" y="47" font-family="-apple-system, BlinkMacSystemFont, 'Helvetica Neue', Arial, sans-serif"
		font-size="34" font-weight="700" letter-spacing="-0.6" fill="${ink}">oh-my-agent-web</text>
</svg>`;

async function main() {
	const chrome = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
	if (!chrome) {
		throw new Error(`找不到 Chromium 内核，用 CHROME_PATH 指定：\n  ${CHROME_CANDIDATES.join("\n  ")}`);
	}
	await mkdir(OUT_DIR, { recursive: true });

	const iconSvg = await readFile(join(ROOT, "web/public/favicon.svg"), "utf8");
	const icon = `data:image/svg+xml;base64,${Buffer.from(iconSvg).toString("base64")}`;
	const shot = await dataUri(join(ROOT, "docs/screenshots/01-chat.png"), "image/png");
	const css = BASE_CSS("#F1F5F9", "#93A3B8", "#60A5FA");

	const browser = await chromium.launch({ executablePath: chrome });
	try {
		for (const template of TEMPLATES) {
			const page = await browser.newPage({ deviceScaleFactor: 2 });
			await page.setViewportSize({ width: template.width, height: template.height });
			await page.setContent(
				`<!doctype html><html><head><meta charset="utf-8"><style>${css}</style></head><body>${template.body({ icon, shot })}</body></html>`,
			);
			await page.waitForTimeout(250);
			const buffer = await page.screenshot({ type: "png" });
			await writeFile(join(OUT_DIR, template.file), buffer);
			console.log(`  docs/brand/${template.file}  ${template.width}×${template.height} @2x  ${(buffer.length / 1024).toFixed(0)} KB`);
			await page.close();
		}
	} finally {
		await browser.close();
	}

	await writeFile(join(OUT_DIR, "logo-lockup-dark.svg"), LOCKUP_SVG("#F1F5F9", "#60A5FA", "#1F2937", "#111827", "#0B1220"));
	await writeFile(join(OUT_DIR, "logo-lockup-light.svg"), LOCKUP_SVG("#111827", "#22B8CF", "#F8FAFC", "#F1F5F9", "#E2E8F0"));
	console.log("  docs/brand/logo-lockup-dark.svg / -light.svg");
	console.log("\n广告图已生成（docs/brand/）。改文案/尺寸改 scripts/make-promo.mjs 的 TEMPLATES。");
}

await main();
