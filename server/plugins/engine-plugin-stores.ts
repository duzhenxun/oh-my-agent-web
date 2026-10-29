/**
 * 非 pi 引擎的「插件」面板后端（ADR-0045）：**照各家自己的口径显示**，不硬套 pi 的 package 概念。
 *
 * 三家现实（决定了 `can` 那张表，界面据此隐藏按不出来的按钮）：
 *   - **codex**：0.16x 起有真正的插件系统（marketplace + plugin，`~/.codex/config.toml` 的
 *     `[plugins."id@market"]`）。app-server 直接给了 `plugin/list`（含 installed / enabled /
 *     版本 / 描述）与 `plugin/install`、`plugin/uninstall`；启停走 `config/value/write`。
 *     这是三家里最完整的一份，所以 install / remove / toggle 全开。
 *   - **claude**：插件是「插件@市场」，只有开关列表（`settings.json` 的 `enabledPlugins`），
 *     安装/卸载在 Claude Code 自己的 `/plugin` 流程里 → 这里只做**开关**。
 *   - **opencode**：`opencode.json` 的 `plugin` 数组（npm 包名或本地路径），没有启停状态，
 *     也没有 CLI 写它 → 只读展示，改文件请自己在编辑器里加/删。
 *   - **dsh / 其它**：没有插件概念 → 空视图 + 一句说明。
 */
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { CodexClient } from "../engine/codex-transport.js";
import type { PluginPackageInfo, PluginStore, PluginsResult, PluginsView } from "../engine/pi-plugins.js";
import { readJsonObject, tableOf, writeJsonObject } from "../util/json-file.js";

const EMPTY_COUNTS = { extensions: 0, skills: 0, prompts: 0, themes: 0 };

function packageRow(input: {
	source: string;
	name?: string;
	version?: string;
	description?: string;
	disabled: boolean;
	installedPath?: string;
	installed: boolean;
}): PluginPackageInfo {
	return {
		source: input.source,
		scope: "global",
		...(input.name ? { name: input.name } : {}),
		...(input.version ? { version: input.version } : {}),
		...(input.description ? { description: input.description } : {}),
		disabled: input.disabled,
		filtered: false,
		...(input.installedPath ? { installedPath: input.installedPath } : {}),
		// 「装没装」跟「开没开」是两件事：codex / claude 都分得出来
		status: input.installed ? (input.disabled ? "disabled" : "installed") : "missing",
		counts: { ...EMPTY_COUNTS },
		resources: [],
	};
}

function view(input: {
	engine: string;
	source: string;
	can: NonNullable<PluginsView["can"]>;
	note: string;
	packages: PluginPackageInfo[];
	diagnostics?: PluginsView["diagnostics"];
	error?: string;
}): PluginsResult {
	return {
		packages: input.packages,
		extensions: [],
		totals: { ...EMPTY_COUNTS },
		diagnostics: input.diagnostics ?? [],
		projectLoaded: false,
		engine: input.engine,
		source: input.source,
		can: input.can,
		note: input.note,
		...(input.error ? { error: input.error } : {}),
	};
}

/** 这个引擎没有插件概念（dsh / 未接的引擎）：空列表 + 一句能看懂的话 */
export function createNonePluginStore(engine: string, note: string): PluginStore {
	const empty = () =>
		view({
			engine,
			source: note,
			can: { install: false, remove: false, toggle: false, update: false },
			note,
			packages: [],
			diagnostics: [{ type: "warning", message: note }],
		});
	return {
		async view() {
			return empty();
		},
		async act() {
			return { ...empty(), actionError: note };
		},
	};
}

// ---------------------------------------------------------------------------
// codex
// ---------------------------------------------------------------------------

type CodexPlugin = {
	id?: string;
	name?: string;
	localVersion?: string | null;
	version?: string | null;
	installed?: boolean;
	enabled?: boolean;
	disabledReason?: string | null;
	source?: { type?: string; path?: string };
	interface?: { displayName?: string | null; shortDescription?: string | null };
};

type CodexPluginList = {
	marketplaces?: Array<{ name?: string; path?: string; plugins?: CodexPlugin[] }>;
};

export function createCodexPluginStore(options: {
	client: CodexClient;
	configPath: string;
	log?: (text: string) => void;
}): PluginStore {
	const engine = "codex";
	const can = { install: true, remove: true, toggle: true, update: false };
	const note =
		'Codex 插件来自 marketplace：manifest 在 `~/.codex/config.toml` 的 [plugins."id@market"]，安装缓存在 ~/.codex/plugins';

	const build = async (): Promise<PluginsResult> => {
		try {
			const listed = await options.client.request<CodexPluginList>("plugin/list", {}, { timeoutMs: 25_000 });
			const packages: PluginPackageInfo[] = [];
			const diagnostics: PluginsView["diagnostics"] = [];
			for (const market of listed?.marketplaces ?? []) {
				for (const plugin of market.plugins ?? []) {
					const id = plugin.id ?? plugin.name;
					if (!id) continue;
					packages.push(
						packageRow({
							source: id,
							name: plugin.interface?.displayName ?? plugin.name ?? id,
							version: plugin.localVersion ?? plugin.version ?? undefined,
							description: plugin.interface?.shortDescription ?? undefined,
							// 「装了但没开」与「没装」分开：界面上的按钮不同
							disabled: plugin.enabled !== true,
							installedPath: plugin.source?.path,
							installed: plugin.installed === true,
						}),
					);
					if (typeof plugin.disabledReason === "string" && plugin.disabledReason !== "") {
						diagnostics.push({ type: "warning", source: id, message: plugin.disabledReason });
					}
				}
			}
			return view({ engine, source: `Codex · plugin/list（${options.configPath}）`, can, note, packages, diagnostics });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log?.(`codex：读插件清单失败：${message}`);
			return view({
				engine,
				source: `Codex · ${options.configPath}`,
				can,
				note,
				packages: [],
				error: `读不到 codex 的插件清单：${message}`,
			});
		}
	};

	return {
		view: async () => build(),

		async act(input) {
			const base = await build();
			try {
				if (input.action === "install") {
					if (!input.source) return { ...base, actionError: "要装哪个插件？（写 id@market）" };
					await options.client.request("plugin/install", { pluginName: input.source }, { timeoutMs: 120_000 });
					return { ...(await build()), notice: `已安装 ${input.source}` };
				}
				if (input.action === "remove") {
					if (!input.source) return { ...base, actionError: "要删哪个插件？" };
					await options.client.request("plugin/uninstall", { pluginId: input.source }, { timeoutMs: 60_000 });
					return { ...(await build()), notice: `已卸载 ${input.source}` };
				}
				if (input.action === "enable" || input.action === "disable") {
					if (!input.source) return { ...base, actionError: "要改哪个插件？" };
					await options.client.request(
						"config/value/write",
						{
							keyPath: `plugins.${input.source}.enabled`,
							value: input.action === "enable",
							mergeStrategy: "replace",
						},
						{ timeoutMs: 30_000 },
					);
					return {
						...(await build()),
						notice: `${input.source}：${input.action === "enable" ? "已启用" : "已停用"}`,
					};
				}
				return { ...base, actionError: "codex 面板不支持「更新」：用 `codex plugin marketplace upgrade`" };
			} catch (error) {
				const message = error instanceof Error ? error.message : String(error);
				options.log?.(`codex：插件操作失败（${input.action}）：${message}`);
				return { ...base, actionError: `codex 拒绝了这次操作：${message}` };
			}
		},
	};
}

// ---------------------------------------------------------------------------
// claude
// ---------------------------------------------------------------------------

function claudeSettingsPath(home?: string): string {
	const dir = home?.trim() || process.env.CLAUDE_CONFIG_DIR?.trim() || join(homedir(), ".claude");
	return join(dir, "settings.json");
}

export function createClaudePluginStore(options: { home?: string; log?: (text: string) => void } = {}): PluginStore {
	const engine = "claude";
	const can = { install: false, remove: false, toggle: true, update: false };
	const settingsPath = claudeSettingsPath(options.home);
	const note =
		"Claude Code 的插件是「插件@市场」，开关写在 `~/.claude/settings.json` 的 enabledPlugins；安装/卸载在 Claude Code 自己的 /plugin 流程里";

	const build = (): PluginsResult => {
		const read = readJsonObject(settingsPath);
		if ("error" in read) {
			return view({ engine, source: settingsPath, can, note, packages: [], error: read.error });
		}
		const enabledPlugins = tableOf(read.json, "enabledPlugins");
		const packages = Object.entries(enabledPlugins).map(([id, value]) =>
			packageRow({
				source: id,
				name: id,
				disabled: value !== true,
				installed: true,
			}),
		);
		const diagnostics: PluginsView["diagnostics"] = [];
		// `~/.claude/plugins` 里是缓存/市场，数一下让用户知道「文件在哪」
		const pluginsDir = join(settingsPath, "..", "plugins");
		if (existsSync(pluginsDir)) {
			try {
				const count = readdirSync(pluginsDir).length;
				diagnostics.push({
					type: "warning",
					message: `插件缓存目录 ${pluginsDir}（${count} 项）：本面板只改开关，不动缓存`,
				});
			} catch {
				/* 读不了就算了，不影响开关 */
			}
		}
		return view({ engine, source: `Claude Code · ${settingsPath}`, can, note, packages, diagnostics });
	};

	return {
		async view() {
			return build();
		},

		async act(input) {
			const base = build();
			if (input.action !== "enable" && input.action !== "disable") {
				return { ...base, actionError: "Claude Code 的插件安装/卸载不在这个面板里（用 Claude Code 的 /plugin）" };
			}
			if (!input.source) return { ...base, actionError: "要改哪个插件？" };
			const read = readJsonObject(settingsPath);
			if ("error" in read) return { ...base, actionError: read.error };
			const enabledPlugins = { ...tableOf(read.json, "enabledPlugins") };
			enabledPlugins[input.source] = input.action === "enable";
			try {
				writeJsonObject(settingsPath, { ...read.json, enabledPlugins });
			} catch (error) {
				return { ...base, actionError: error instanceof Error ? error.message : String(error) };
			}
			return {
				...build(),
				notice: `${input.source}：${input.action === "enable" ? "已启用" : "已停用"}`,
			};
		},
	};
}

// ---------------------------------------------------------------------------
// opencode（只读：插件列表在 opencode.json 的 plugin 数组里）
// ---------------------------------------------------------------------------

function opencodeConfigFile(workspace?: string): string {
	if (workspace) return join(workspace, "opencode.json");
	const base = process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
	return join(base, "opencode", "opencode.json");
}

export function createOpencodePluginStore(_options: { log?: (text: string) => void } = {}): PluginStore {
	const engine = "opencode";
	const can = { install: false, remove: false, toggle: false, update: false };
	const note = "opencode 的插件写在 `opencode.json` 的 `plugin` 数组（npm 包名或本地路径）；本面板只读，改文件即可";

	const build = (workspace: string): PluginsResult => {
		const files = [opencodeConfigFile(), opencodeConfigFile(workspace)];
		const packages: PluginPackageInfo[] = [];
		const diagnostics: PluginsView["diagnostics"] = [];
		for (const file of files) {
			const read = readJsonObject(file);
			if ("error" in read) {
				diagnostics.push({ type: "error", source: file, message: read.error });
				continue;
			}
			const plugin = read.json.plugin;
			if (!Array.isArray(plugin)) continue;
			for (const entry of plugin) {
				if (typeof entry !== "string" || entry.trim() === "") continue;
				packages.push(packageRow({ source: entry, name: entry, disabled: false, installed: true }));
			}
		}
		return view({ engine, source: `opencode · ${files[0]}`, can, note, packages, diagnostics });
	};

	return {
		async view(workspace) {
			return build(workspace);
		},
		async act(input) {
			return { ...build(input.workspace), actionError: note };
		},
	};
}
