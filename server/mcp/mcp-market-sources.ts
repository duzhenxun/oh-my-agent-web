/**
 * 三个市场源各自的「原始 JSON → 市场条目」映射。
 *
 * 从 `mcp-market.ts` 拆出来（那个负责抓取与缓存，这个只管数据形状）：
 * 每个源给的字段都不一样，改一个源的映射不该顺手把抓取逻辑也搅一遍。
 *
 * 共同的取舍：**拼不出 command / url 的条目直接丢掉**（比如只有 OCI 镜像的），
 * 因为「一键添加」写进去的东西必须能真的连上，不能只是列表里好看。
 */
import { sanitizeServerName } from "./mcp-command.js";
import type { McpServerConfig } from "./pi-mcp-config.js";
import type { MarketEntry } from "./mcp-market-types.js";

type Item = Record<string, unknown>;

function str(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

function record(value: unknown): Item | null {
	return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Item) : null;
}

function arr(value: unknown): unknown[] {
	return Array.isArray(value) ? value : [];
}

// ---------------------------------------------------------------------------
// 三个源 → MarketEntry
// ---------------------------------------------------------------------------

/** `ac.inference.sh/mcp` → `mcp`；`com.pulsemcp/remote-filesystem` → `remote-filesystem` */
function nameFromRegistryName(raw: string): string {
	const tail = raw.split("/").pop() ?? raw;
	return sanitizeServerName(tail);
}

export function registryEntries(payload: unknown): MarketEntry[] {
	const servers = arr(record(payload)?.servers);
	const byName = new Map<string, MarketEntry>();
	for (const item of servers) {
		const server = record(record(item)?.server);
		if (!server) continue;
		const officialName = str(server.name) ?? "";
		if (officialName === "") continue;
		const meta = record(record(item)?._meta)?.["io.modelcontextprotocol.registry/official"];
		// 同一个服务器会列出多个版本：只留最新的那条
		const isLatest = record(meta)?.isLatest !== false;
		const name = nameFromRegistryName(officialName);
		if (!isLatest && byName.has(name)) continue;

		const remotes = arr(server.remotes)
			.map(record)
			.filter((entry): entry is Item => entry !== null);
		const remote = remotes.find((entry) => (str(entry.type) ?? "streamable-http").includes("http"));
		const packages = arr(server.packages)
			.map(record)
			.filter((entry): entry is Item => entry !== null);
		const npm = packages.find((entry) => str(entry.registryType) === "npm");
		const pypi = packages.find((entry) => str(entry.registryType) === "pypi");
		const repo = record(server.repository);

		let config: McpServerConfig | undefined;
		let pkg: string | undefined;
		const environment = arr((npm ?? pypi)?.environmentVariables)
			.map(record)
			.filter((entry): entry is Item => entry !== null);
		const needsEnv = environment
			.filter((entry) => entry.isRequired === true)
			.map((entry) => str(entry.name))
			.filter((value): value is string => value !== undefined);

		if (remote && str(remote.url)) {
			config = { url: str(remote.url)! };
		} else if (npm && str(npm.identifier)) {
			pkg = str(npm.identifier)!;
			const version = str(npm.version);
			const runtime = str(npm.runtimeHint) ?? "npx";
			// 顺序很要紧：运行时的参数（`-y`）在包名**前面**，包自己的参数在后面。
			// 反过来写就成了 `npx pkg -y`（npx 会把 -y 当包参数，装包时直接卡在确认上）。
			const runtimeArgs = arr(npm.runtimeArguments)
				.map((entry) => str(record(entry)?.value))
				.filter((value): value is string => value !== undefined);
			const packageArgs = arr(npm.packageArguments)
				.map((entry) => str(record(entry)?.value))
				.filter((value): value is string => value !== undefined);
			const leading = runtime === "npx" && !runtimeArgs.includes("-y") ? ["-y"] : [];
			config = {
				command: runtime,
				args: [...leading, ...runtimeArgs, version ? `${pkg}@${version}` : pkg, ...packageArgs],
			};
		} else if (pypi && str(pypi.identifier)) {
			pkg = str(pypi.identifier)!;
			const version = str(pypi.version);
			const runtimeArgs = arr(pypi.runtimeArguments)
				.map((entry) => str(record(entry)?.value))
				.filter((value): value is string => value !== undefined);
			config = {
				command: str(pypi.runtimeHint) ?? "uvx",
				args: [...runtimeArgs, version ? `${pkg}@${version}` : pkg],
			};
		}
		if (!config) continue; // 只有 OCI 镜像 / 拼不出来的：不列，免得点了装不上

		byName.set(name, {
			id: `registry:${officialName}`,
			name,
			title: str(server.title) ?? name,
			description: str(server.description) ?? "",
			source: "registry",
			...(str(repo?.url) ? { homepage: str(repo?.url)! } : {}),
			...(pkg ? { pkg } : {}),
			...(str(server.version) ? { note: `版本 ${str(server.version)}` } : {}),
			verified: true,
			config,
			...(needsEnv.length > 0 ? { needsEnv } : {}),
			...(config.url ? {} : { note: "装好后会以 npx / uvx 起本地进程" }),
		});
	}
	return [...byName.values()];
}

export function smitheryEntries(payload: unknown): MarketEntry[] {
	const servers = arr(record(payload)?.servers)
		.map(record)
		.filter((entry): entry is Item => entry !== null);
	const out: MarketEntry[] = [];
	for (const item of servers) {
		// 只取托管在 Smithery 上的远程条目：本地 stdio 那些没有可直接用的包名
		if (item.remote !== true || item.isDeployed === false) continue;
		const qualified = str(item.qualifiedName);
		if (!qualified) continue;
		const name = sanitizeServerName(qualified.split("/").pop() ?? qualified);
		out.push({
			id: `smithery:${qualified}`,
			name,
			title: str(item.displayName) ?? qualified,
			description: str(item.description) ?? "",
			source: "smithery",
			homepage: str(item.homepage) ?? `https://smithery.ai/server/${encodeURIComponent(qualified)}`,
			...(typeof item.useCount === "number" ? { downloads: item.useCount } : {}),
			...(item.verified === true ? { verified: true } : {}),
			config: { url: `https://server.smithery.ai/${qualified}/mcp` },
			note: "远程服务器：添加后回详情点「登录」完成 OAuth（或用 pi mcp login）",
		});
	}
	return out;
}

export function githubEntries(payload: unknown): MarketEntry[] {
	const dirs = arr(payload)
		.map(record)
		.filter((entry): entry is Item => entry !== null);
	const out: MarketEntry[] = [];
	for (const dir of dirs) {
		const name = str(dir.name);
		if (!name || dir.type !== "dir" || name.startsWith(".")) continue;
		const pkg = `@modelcontextprotocol/server-${name}`;
		out.push({
			id: `github:${name}`,
			name: sanitizeServerName(name),
			title: pkg,
			description: `modelcontextprotocol/servers 官方参考服务器（${name}）`,
			source: "github",
			homepage: str(dir.html_url),
			pkg,
			verified: true,
			config: { command: "npx", args: ["-y", pkg] },
			note: "装好后会以 npx 起本地进程",
		});
	}
	return out;
}

/** 同名去重：保留「更可信 / 用得更多」的那条，免得列表里出现 notion 和 notion-2 */
export function dedupeByName(entries: MarketEntry[]): MarketEntry[] {
	const best = new Map<string, MarketEntry>();
	for (const entry of entries) {
		const current = best.get(entry.name);
		if (current === undefined || score(entry) > score(current)) best.set(entry.name, entry);
	}
	// 保持原顺序（Map 的插入顺序 = 第一次出现的位置）
	return [...best.values()];
}

function score(entry: MarketEntry): number {
	return (entry.verified ? 1_000_000_000 : 0) + (entry.downloads ?? 0);
}

/** 搜索过滤：名字 / 标题 / 描述 / 包名，任一命中即可（本地过滤，不额外打网络） */
export function filterEntries(entries: MarketEntry[], query: string): MarketEntry[] {
	const q = query.trim().toLowerCase();
	if (q === "") return entries;
	// 空格分词，全部要命中：`google 日历` 这种组合才有意义
	const words = q.split(/\s+/);
	return entries.filter((entry) => {
		const haystack = `${entry.name} ${entry.title} ${entry.description} ${entry.pkg ?? ""}`.toLowerCase();
		return words.every((word) => haystack.includes(word));
	});
}
