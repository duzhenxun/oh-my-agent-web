#!/usr/bin/env node
/**
 * update-check.mjs — 轻量级「有新版本就提示」检查（无第三方依赖）。
 *
 * 设计要点：
 *  - 结果缓存到 ~/.cache/open-web-app/update-check.json，默认 24h 才联网检查一次，
 *    避免每次运行都等网络；已知有新版时，每次运行都会提示（读缓存，0 延迟）。
 *  - 任何失败都静默忽略，绝不阻塞 / 影响 CLI 正常功能。
 *  - 可通过 OWA_NO_UPDATE_CHECK=1 关闭；CI 环境自动跳过。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

const PKG = "open-web-app";
const REGISTRY = `https://registry.npmjs.org/${PKG.replace("/", "%2f")}/latest`;
const DEFAULT_INTERVAL_MS = 24 * 60 * 60 * 1000; // 24h
const DEFAULT_TIMEOUT_MS = 1500;

function cacheFile() {
	const base = process.env.XDG_CACHE_HOME || join(homedir(), ".cache");
	return join(base, "open-web-app", "update-check.json");
}

/** Should the check be skipped entirely? */
export function isDisabled() {
	const off = (process.env.OWA_NO_UPDATE_CHECK ?? "").toLowerCase();
	if (off === "1" || off === "true" || off === "yes") return true;
	if (process.env.NO_UPDATE_NOTIFIER) return true;
	if (process.env.CI) return true;
	return false;
}

/** Compare two semver-ish versions. Returns 1 (a>b), -1 (a<b), 0 (equal). */
export function compareVersions(a, b) {
	const parse = (v) =>
		String(v)
			.split("-")[0]
			.split(".")
			.map((n) => parseInt(n, 10) || 0);
	const A = parse(a);
	const B = parse(b);
	for (let i = 0; i < Math.max(A.length, B.length); i += 1) {
		const d = (A[i] || 0) - (B[i] || 0);
		if (d !== 0) return d > 0 ? 1 : -1;
	}
	const pre = (v) => String(v).includes("-");
	if (pre(a) && !pre(b)) return -1;
	if (!pre(a) && pre(b)) return 1;
	return 0;
}

async function readCache(file) {
	try {
		const data = JSON.parse(await readFile(file, "utf8"));
		return data && typeof data === "object" ? data : null;
	} catch {
		return null;
	}
}

async function writeCache(file, data) {
	try {
		await mkdir(dirname(file), { recursive: true });
		await writeFile(file, JSON.stringify(data), "utf8");
	} catch {
		/* ignore */
	}
}

async function fetchLatest(timeoutMs) {
	const ctrl = new AbortController();
	const timer = setTimeout(() => ctrl.abort(), timeoutMs);
	try {
		const res = await fetch(REGISTRY, {
			signal: ctrl.signal,
			headers: { accept: "application/json", "user-agent": `${PKG} update-check` },
		});
		if (!res.ok) return null;
		const json = await res.json();
		return typeof json?.version === "string" ? json.version : null;
	} catch {
		return null;
	} finally {
		clearTimeout(timer);
	}
}

/**
 * Check for a newer published version.
 * @returns {Promise<string|null>} the newer version, or null if up to date / unknown.
 */
export async function checkForUpdate(current, opts = {}) {
	if (isDisabled()) return null;
	const file = opts.cacheFile || cacheFile();
	const interval = Number(process.env.OWA_UPDATE_CHECK_INTERVAL_MS ?? opts.intervalMs ?? DEFAULT_INTERVAL_MS);
	const timeout = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
	const now = Date.now();

	const cache = await readCache(file);
	let latest = typeof cache?.latest === "string" ? cache.latest : null;

	const lastCheck = typeof cache?.lastCheck === "number" ? cache.lastCheck : 0;
	if (now - lastCheck >= interval) {
		const fetched = await fetchLatest(timeout);
		if (fetched) latest = fetched;
		await writeCache(file, { lastCheck: now, latest });
	}

	return latest && compareVersions(latest, current) > 0 ? latest : null;
}

/** Format the update notice (plain, no ANSI). */
export function formatNotice(current, latest) {
	const lines = [
		"",
		`  Update available: open-web-app ${current} -> ${latest}`,
		`      npm install -g ${PKG}@latest`,
		`      (disable this check with OWA_NO_UPDATE_CHECK=1)`,
		"",
	];
	return lines.join("\n") + "\n";
}

/** Check and print the notice to stderr. Never throws. */
export async function notifyUpdate(current, opts = {}) {
	try {
		const latest = await checkForUpdate(current, opts);
		if (!latest) return null;
		let text = formatNotice(current, latest);
		if (process.stderr.isTTY) {
			text = text.replace(
				`Update available: open-web-app ${current} -> ${latest}`,
				`\x1b[33mUpdate available: open-web-app ${current} \u2192 ${latest}\x1b[0m`,
			);
		}
		process.stderr.write(text);
		return latest;
	} catch {
		return null;
	}
}
