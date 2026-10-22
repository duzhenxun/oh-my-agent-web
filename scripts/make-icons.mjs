/**
 * 生成全站图标（浏览器标签 / PWA / iOS 主屏 / 推送通知）。
 *
 * 唯一事实源是 `web/public/favicon.svg`（圆角砖）与 `web/public/maskable.svg`（满幅砖）：
 * 改图案 → 跑一次这个脚本 → 提交生成的 PNG/ICO。**不要手改 PNG**。
 *
 * 为什么用 Chromium 截图而不是引图片处理库：仓库里已经有 playwright-core（smoke 测试用），
 * 再装 sharp/resvg 就是多一个生产无关的重依赖；而 SVG 渲染这件事 Chromium 最准。
 *
 * 用法：
 *   node scripts/make-icons.mjs
 *   CHROME_PATH=/path/to/chrome node scripts/make-icons.mjs   # 装在非标准位置时
 *
 * 输出（与 index.html / manifest / sw.js 里的引用一一对应）：
 *   web/public/favicon-{16,32,48}.png  圆角、透明角（标签页）
 *   web/public/favicon.ico             16/32/48 三尺寸打包
 *   web/public/icons/icon-{192,512}.png        满幅（PWA any）
 *   web/public/icons/icon-maskable-512.png     满幅 + 安全圈（PWA maskable）
 *   web/public/icons/apple-touch-icon-180.png  iOS 主屏（满幅，系统自己切圆角）
 *   web/public/apple-touch-icon{,-precomposed}.png  同上，iOS 会探这两个惯例路径
 */
import { existsSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright-core";

/** 仓库根（相对本文件，而不是 cwd：从哪里调用都一样） */
const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));

const PUBLIC_DIR = join(REPO_ROOT, "web", "public");
const ICONS_DIR = join(PUBLIC_DIR, "icons");

/** 依次找可用的 Chromium 内核（本机 Chrome 最省事，CI 上给 CHROME_PATH） */
const CHROME_CANDIDATES = [
	process.env.CHROME_PATH,
	"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
	"/Applications/Chromium.app/Contents/MacOS/Chromium",
	"/usr/bin/google-chrome",
	"/usr/bin/chromium",
	"/usr/bin/chromium-browser",
].filter(Boolean);

function findChrome() {
	const found = CHROME_CANDIDATES.find((candidate) => existsSync(candidate));
	if (!found) {
		throw new Error(`找不到 Chromium 内核，用 CHROME_PATH 指定：\n  ${CHROME_CANDIDATES.join("\n  ")}`);
	}
	return found;
}

/** 把 SVG 拉成指定边长的位图（transparent=false 时底色就是砖块本身，不带透明像素） */
async function rasterize(page, svg, size, transparent) {
	const markup = svg.includes("<svg")
		? svg.replace("<svg", `<svg width="${size}" height="${size}" style="display:block"`)
		: "";
	await page.setViewportSize({ width: size, height: size });
	await page.setContent(
		`<!doctype html><html><head><meta charset="utf-8"><style>html,body{margin:0;padding:0;background:transparent}</style></head><body>${markup}</body></html>`,
	);
	return page.screenshot({ omitBackground: transparent, animations: "disabled" });
}

/**
 * 把若干 PNG 打成 `favicon.ico`。
 *
 * ICO 容器很简单：6 字节头 + 每张图 16 字节目录项 + 各自的 PNG 原始字节
 * （Vista 之后允许直接内嵌 PNG，不需要 BMP）。
 */
function buildIco(images) {
	const header = Buffer.alloc(6);
	header.writeUInt16LE(0, 0); // reserved
	header.writeUInt16LE(1, 2); // type=1（图标）
	header.writeUInt16LE(images.length, 4);

	let offset = 6 + images.length * 16;
	const entries = images.map(({ size, data }) => {
		const entry = Buffer.alloc(16);
		entry.writeUInt8(size >= 256 ? 0 : size, 0); // 宽
		entry.writeUInt8(size >= 256 ? 0 : size, 1); // 高
		entry.writeUInt8(0, 2); // 调色板数
		entry.writeUInt8(0, 3); // reserved
		entry.writeUInt16LE(1, 4); // color planes
		entry.writeUInt16LE(32, 6); // bits per pixel
		entry.writeUInt32LE(data.length, 8);
		entry.writeUInt32LE(offset, 12);
		offset += data.length;
		return entry;
	});
	return Buffer.concat([header, ...entries, ...images.map((image) => image.data)]);
}

async function main() {
	const roundedSvg = await readFile(join(PUBLIC_DIR, "favicon.svg"), "utf8");
	const maskableSvg = await readFile(join(PUBLIC_DIR, "maskable.svg"), "utf8");
	// 满幅版：把圆角砖的 rx 去掉，图案尺寸不变 —— 系统（Android 启动器 / iOS）自己加圆角，
	// 我们再加一层就会出现「白角」。图案本身仍以 favicon.svg 为唯一事实源。
	const fullBleedSvg = roundedSvg.replace(/<rect width="32" height="32" rx="[\d.]+"/, '<rect width="32" height="32"');
	if (fullBleedSvg === roundedSvg) throw new Error("favicon.svg 的底砖写法变了：满幅版替换失败，先改 make-icons.mjs");
	await mkdir(ICONS_DIR, { recursive: true });

	const browser = await chromium.launch({ executablePath: findChrome() });
	const page = await browser.newPage({ deviceScaleFactor: 1 });
	const written = [];

	const save = async (path, buffer) => {
		await writeFile(path, buffer);
		written.push(`${relative(REPO_ROOT, path)}  ${(buffer.length / 1024).toFixed(1)} KB`);
	};

	try {
		// 标签页图标：圆角砖 + 透明角，16px 也要能认出「一个里有个 > 」
		const faviconSizes = [16, 32, 48];
		const faviconPngs = [];
		for (const size of faviconSizes) {
			const data = await rasterize(page, roundedSvg, size, true);
			faviconPngs.push({ size, data });
			await save(join(PUBLIC_DIR, `favicon-${size}.png`), data);
		}
		await save(join(PUBLIC_DIR, "favicon.ico"), buildIco(faviconPngs));

		// PWA any：满幅、不透明（启动器会把它当整张图展示，透明角反而显脏）
		for (const size of [192, 512]) {
			await save(join(ICONS_DIR, `icon-${size}.png`), await rasterize(page, fullBleedSvg, size, false));
		}

		// PWA maskable：满幅 + 图案缩到安全圈内
		await save(join(ICONS_DIR, "icon-maskable-512.png"), await rasterize(page, maskableSvg, 512, false));

		// iOS 主屏：满幅正方形，圆角由系统加
		const appleSizes = [
			[join(PUBLIC_DIR, "apple-touch-icon.png"), 180],
			[join(PUBLIC_DIR, "apple-touch-icon-precomposed.png"), 180],
			[join(ICONS_DIR, "apple-touch-icon-180.png"), 180],
		];
		for (const [path, size] of appleSizes) {
			await save(path, await rasterize(page, fullBleedSvg, size, false));
		}
	} finally {
		await browser.close();
	}

	console.log(`图标已生成（${written.length} 个文件）：`);
	for (const line of written) console.log(`  ${line}`);
	console.log(
		"\n提醒：图案变了要同时更新 index.html / manifest / sw.js 里的 ?v= 版本号（iOS 会按 URL 缓存主屏图标）。",
	);
}

await main();
