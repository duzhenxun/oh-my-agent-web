/**
 * 已安装应用索引：给「解除保护的应用」输入框做模糊搜索。
 *
 * 用户想写的是 `微信`，而名单要的是 `com.tencent.xinWeChat` —— 中间隔着一层 bundle id。
 * 这里扫描应用目录，把「目录名 / 显示名 / bundle id」三样都当成可搜索的别名。
 *
 * 只读，且带缓存：扫描一次约几百毫秒，没必要每次按键都重扫。
 */
import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { homedir } from "node:os";
import { basename, join } from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export type InstalledApp = {
	/** 用户看到的名字，如「微信」 */
	name: string;
	/** 可能的别名：目录名、CFBundleDisplayName、CFBundleName */
	aliases: string[];
	bundleId: string;
	path: string;
};

const CACHE_TTL_MS = 60_000;
let cache: { at: number; apps: InstalledApp[] } | null = null;

function appDirs(home: string): string[] {
	return [join("/Applications"), join(home, "Applications"), join("/System/Applications")];
}

/** 读 plist（多为二进制）→ 只取需要的键；失败返回空 */
async function readPlistName(plistPath: string): Promise<{ display?: string; name?: string; bundleId?: string }> {
	try {
		const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", plistPath], {
			timeout: 4_000,
			maxBuffer: 2 * 1024 * 1024,
		});
		const parsed = JSON.parse(stdout) as Record<string, unknown>;
		const pick = (key: string) => (typeof parsed[key] === "string" ? (parsed[key] as string) : undefined);
		return { display: pick("CFBundleDisplayName"), name: pick("CFBundleName"), bundleId: pick("CFBundleIdentifier") };
	} catch {
		return {};
	}
}

/**
 * 本地化的显示名。
 *
 * `WeChat.app` 的 Info.plist 里只有 `WeChat`，中文名「微信」在
 * `Contents/Resources/zh-Hans.lproj/InfoPlist.strings` 里 —— 不读这个，
 * 用户搜「微信」就什么都搜不到。
 */
async function localizedNames(appPath: string): Promise<string[]> {
	const resources = join(appPath, "Contents", "Resources");
	const names: string[] = [];
	for (const language of ["zh-Hans", "zh_CN", "zh-Hant", "en"]) {
		const file = join(resources, `${language}.lproj`, "InfoPlist.strings");
		if (!existsSync(file)) continue;
		const info = await readPlistName(file);
		if (info.display) names.push(info.display);
		names.push(...(info.name && info.name !== info.display ? [info.name] : []));
	}
	return names;
}

/** 扫目录（含一层子目录，覆盖 /System/Applications/Utilities、Adobe 这类文件夹）→ 返回 .app 路径 */
async function scanDir(dir: string, depth = 2): Promise<string[]> {
	if (!existsSync(dir)) return [];
	let entries: { name: string; isDirectory(): boolean }[];
	try {
		entries = await readdir(dir, { withFileTypes: true });
	} catch {
		return [];
	}
	const bundles = entries.filter((e) => e.name.endsWith(".app")).map((e) => join(dir, e.name));
	if (depth > 1) {
		// 只往下走一层文件夹（跳过 .app 内部的 Contents）
		const folders = entries.filter((e) => e.isDirectory() && !e.name.endsWith(".app") && !e.name.startsWith("."));
		for (const folder of folders) {
			bundles.push(...(await scanDir(join(dir, folder.name), depth - 1)));
		}
	}
	return bundles;
}

/** 读取一个 bundle 的元信息（名字、别名、bundle id） */
async function describeApp(bundle: string): Promise<InstalledApp | null> {
	const info = await readPlistName(join(bundle, "Contents", "Info.plist"));
	if (!info.bundleId) return null;
	const dirName = basename(bundle, ".app");
	const localized = await localizedNames(bundle);
	const aliases = [...new Set([dirName, info.display, info.name, ...localized].filter((x): x is string => Boolean(x)))];
	// 名字优先用本地化显示名：用户平时看到的是「微信」，不是 WeChat
	return { name: localized[0] ?? info.display ?? dirName, aliases, bundleId: info.bundleId, path: bundle };
}

export async function listInstalledApps(options: { home?: string; force?: boolean } = {}): Promise<InstalledApp[]> {
	const now = Date.now();
	if (!options.force && cache && now - cache.at < CACHE_TTL_MS) return cache.apps;

	const home = options.home ?? homedir();
	const groups = await Promise.all(appDirs(home).map((dir) => scanDir(dir)));
	const bundles = [...new Set(groups.flat())];

	// plutil 是外部进程：限制并发，避免一次开出几百个
	const described: (InstalledApp | null)[] = [];
	const queue = [...bundles];
	const workers = Array.from({ length: 12 }, async () => {
		for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
			described.push(await describeApp(next));
		}
	});
	await Promise.all(workers);
	// 同一个 bundle id 可能出现在多个目录（比如 /Applications 与 ~/Applications 都有）：去重
	const byId = new Map<string, InstalledApp>();
	for (const app of described) {
		if (app && !byId.has(app.bundleId)) byId.set(app.bundleId, app);
	}
	const apps = [...byId.values()].sort((a, b) => a.name.localeCompare(b.name, "zh-Hans-CN"));
	cache = { at: now, apps };
	return apps;
}

/**
 * 模糊匹配：名称/别名/bundle id 都参与。
 *
 * 排序规则（越靠前越可能是用户想要的）：
 *   1. 名称前缀匹配（输入「微」→「微信」）
 *   2. 名称包含
 *   3. bundle id 包含
 * 同分时名字短的优先（「微信」比「微信开发者工具」更可能是目标）。
 */
export function searchApps(apps: InstalledApp[], query: string, limit = 12): InstalledApp[] {
	const needle = query.trim().toLowerCase();
	if (!needle) return [];
	const scored: { app: InstalledApp; score: number }[] = [];
	for (const app of apps) {
		const names = [app.name, ...app.aliases].map((value) => value.toLowerCase());
		const bundle = app.bundleId.toLowerCase();
		let score = 0;
		for (const name of names) {
			if (name === needle) score = Math.max(score, 100);
			else if (name.startsWith(needle)) score = Math.max(score, 80);
			else if (name.includes(needle)) score = Math.max(score, 60);
		}
		if (bundle.includes(needle)) score = Math.max(score, 40);
		if (score === 0) continue;
		// 名字越短越可能是用户想输入的那个
		scored.push({ app, score: score - Math.min(20, app.name.length) / 10 });
	}
	return scored
		.sort((a, b) => b.score - a.score)
		.slice(0, limit)
		.map((entry) => entry.app);
}
