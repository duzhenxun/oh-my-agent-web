/**
 * 插件（pi package / 本机扩展）的读取与操作。
 *
 * 「插件」在 pi 里就是 **package**：`settings.json` 的 `packages`（npm / git / 本地目录），
 * 一个包可以同时带扩展、技能、提示词模板、主题；另外还有散装放在
 * `~/.pi/agent/extensions/`（或项目 `.pi/extensions/`）里的单文件扩展。
 *
 * 几条约定：
 *   - **谁说了算：pi 自己**。哪些资源、开没开，全部取自 `DefaultPackageManager.resolve()`；
 *     `onMissing` 一律回 `skip` —— 查询时绝不顺手跑 npm install。
 *   - **两个作用域**：全局（`~/.pi/agent/settings.json`）+ 项目（`<workspace>/.pi/settings.json`），
 *     跟会话加载时用的 cwd 是同一个，所以面板显示的就是这个项目里真正加载的东西。
 *     oh-my-agent-web 没有「项目信任」的交互（ADR 未引入），与 SDK 的默认值一致：项目资源按已信任处理。
 *   - **停用 ≠ 卸载**：写 `autoload: false`（pi 文档：先清空、再按 patterns 加回），
 *     不删文件、不动 npm 目录、**不丢用户手写的资源过滤**；开回来只删这一个键。
 *     `pi config` 那种「四类数组都置空」的停用也认，一并显示成已停用。
 *   - **状态四态**：loaded（有资源真的加载了）/ installed（装了但没加载出资源）/
 *     missing（配置里有、本地没装）/ disabled（已停用）。
 */
import { readFile } from "node:fs/promises";
import { basename, dirname, extname, join, relative, sep } from "node:path";
import { DefaultPackageManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import type { PackageSource, ResolvedPaths, ResolvedResource } from "@earendil-works/pi-coding-agent";

const RESOURCE_KEYS = ["extensions", "skills", "prompts", "themes"] as const;
export type ResourceKey = (typeof RESOURCE_KEYS)[number];

export type PluginScope = "global" | "project";
type PluginResourceKind = "extension" | "skill" | "prompt" | "theme";
export type PluginStatus = "loaded" | "installed" | "missing" | "disabled";
type PluginResourceCounts = Record<ResourceKey, number>;

export type PluginResourceInfo = {
	kind: PluginResourceKind;
	name: string;
	path: string;
	/** 相对包根（或扩展所在目录）的路径，界面用它当标题 */
	relativePath: string;
};

export type PluginPackageInfo = {
	source: string;
	scope: PluginScope;
	/** package.json 里的字段（装了才有） */
	name?: string;
	version?: string;
	description?: string;
	/** 源里钉住的版本 / ref（`npm:pkg@1.2.3`、`git:…#v1`） */
	configuredVersion?: string;
	disabled: boolean;
	/** 手写了资源过滤（对象形式）——界面打个「已过滤」标 */
	filtered: boolean;
	installedPath?: string;
	status: PluginStatus;
	counts: PluginResourceCounts;
	resources: PluginResourceInfo[];
};

type PluginExtensionInfo = {
	path: string;
	name: string;
	scope: PluginScope;
	enabled: boolean;
};

type PluginDiagnostic = { type: "warning" | "error"; source?: string; message: string };

export type PluginsView = {
	packages: PluginPackageInfo[];
	/** 散装扩展（不属于任何包） */
	extensions: PluginExtensionInfo[];
	totals: PluginResourceCounts;
	diagnostics: PluginDiagnostic[];
	/** 项目作用域是不是真的读了（信任之后才有） */
	projectLoaded: boolean;
	/**
	 * 这份数据属于哪个引擎（切引擎 = 换口径）。pi 不填（保持旧行为）；
	 * 非 pi 引擎必填 —— 面板据此画「现在看的是谁的插件」。
	 */
	engine?: string;
	/** 人话源头（面板顶部那行）：`Codex · plugin/list`、`Claude Code · ~/.claude/settings.json` */
	source?: string;
	/** 这个引擎允许面板做哪些动作（不支持的按钮隐藏，而不是点了报错） */
	can?: { install: boolean; remove: boolean; toggle: boolean; update: boolean };
	/** 这个引擎的「插件」到底是什么、怎么改（面板顶部那句说明） */
	note?: string;
};

export type PluginAction = "install" | "remove" | "update" | "enable" | "disable";

export type PluginsResult = PluginsView & {
	/** 整体失败（连插件目录都读不出来） */
	error?: string;
	/** 单次操作失败（包没装、npm 报错…），此时 packages 仍然可用 */
	actionError?: string;
	/** 操作成功的提示 */
	notice?: string;
};

export type PluginStore = {
	view: (workspace: string) => Promise<PluginsResult>;
	act: (input: {
		workspace: string;
		action: PluginAction;
		source?: string;
		scope?: PluginScope;
	}) => Promise<PluginsResult>;
};

const EMPTY_COUNTS: PluginResourceCounts = { extensions: 0, skills: 0, prompts: 0, themes: 0 };
const KIND_OF: Record<ResourceKey, PluginResourceKind> = {
	extensions: "extension",
	skills: "skill",
	prompts: "prompt",
	themes: "theme",
};

function describe(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function scopeOf(scope: string): PluginScope {
	return scope === "project" ? "project" : "global";
}

function sourceOf(entry: PackageSource): string {
	return typeof entry === "string" ? entry : entry.source;
}

/** `pi config` 的停用写法：四类资源数组全部置空 */
function isEmptiedEntry(entry: PackageSource): boolean {
	if (typeof entry === "string") return false;
	return RESOURCE_KEYS.every((key) => Array.isArray(entry[key]) && entry[key]!.length === 0);
}

function isDisabledEntry(entry: PackageSource): boolean {
	if (typeof entry === "string") return false;
	return entry.autoload === false || isEmptiedEntry(entry);
}

/** 源里钉住的版本：`npm:@scope/pkg@1.2.3` → `1.2.3`；git 的 `#v1` / `@v1` 同理 */
function configuredVersionOf(source: string): string | undefined {
	if (source.startsWith("npm:")) {
		const spec = source.slice(4).trim();
		const lastAt = spec.lastIndexOf("@");
		const nameEnd = spec.startsWith("@") ? spec.indexOf("/", 1) : 0;
		return lastAt > nameEnd ? spec.slice(lastAt + 1) || undefined : undefined;
	}
	if (source.startsWith("git:") || /^[a-z]+:\/\//i.test(source)) {
		const lastAt = Math.max(source.lastIndexOf("@"), source.lastIndexOf("#"));
		const lastSlash = source.lastIndexOf("/");
		return lastAt > lastSlash ? source.slice(lastAt + 1) || undefined : undefined;
	}
	return undefined;
}

async function readPackageMetadata(root: string | undefined): Promise<{
	name?: string;
	version?: string;
	description?: string;
}> {
	if (!root) return {};
	try {
		const raw: unknown = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
		if (typeof raw !== "object" || raw === null) return {};
		const record = raw as Record<string, unknown>;
		return {
			name: typeof record.name === "string" ? record.name : undefined,
			version: typeof record.version === "string" ? record.version : undefined,
			description: typeof record.description === "string" ? record.description : undefined,
		};
	} catch {
		return {};
	}
}

function resourceName(path: string, kind: PluginResourceKind): string {
	const file = basename(path);
	const ext = extname(file);
	if (kind === "skill" && file.toLowerCase() === "skill.md") return basename(dirname(path));
	if (kind === "extension" && /^index\.[cm]?[jt]s$/.test(file)) return basename(dirname(path));
	return ext ? file.slice(0, -ext.length) : file;
}

function resourceRelativePath(resource: ResolvedResource): string {
	const base = resource.metadata.baseDir;
	if (!base) return resource.path;
	const rel = relative(base, resource.path);
	return rel !== "" && !rel.startsWith("..") ? rel.split(sep).join("/") : resource.path;
}

function toResourceInfo(resource: ResolvedResource, key: ResourceKey): PluginResourceInfo {
	const kind = KIND_OF[key];
	return {
		kind,
		name: resourceName(resource.path, kind),
		path: resource.path,
		relativePath: resourceRelativePath(resource),
	};
}

/** 插件面板的 key：scope + source（同一个包可能在两个作用域各配一份） */
function pluginKey(source: string, scope: PluginScope): string {
	return `${scope}\0${source}`;
}

export function createPluginStore(options: { agentDir: string }): PluginStore {
	const agentDir = options.agentDir;
	/** 安装 / 卸载 / 更新会跑 npm，串起来做，别让两个 npm 抢同一个目录 */
	let queue: Promise<unknown> = Promise.resolve();
	const serialize = <T>(task: () => Promise<T>): Promise<T> => {
		const run = queue.then(task, task);
		queue = run.catch(() => undefined);
		return run;
	};

	function open(workspace: string) {
		// 与 SDK 会话同一个 cwd + 默认信任：面板看到的就是这个项目里真正加载的
		const settings = SettingsManager.create(workspace, agentDir);
		const manager = new DefaultPackageManager({ cwd: workspace, agentDir, settingsManager: settings });
		return { settings, manager };
	}

	async function readView(workspace: string): Promise<PluginsResult> {
		let opened: ReturnType<typeof open>;
		try {
			opened = open(workspace);
		} catch (error) {
			return {
				packages: [],
				extensions: [],
				totals: { ...EMPTY_COUNTS },
				diagnostics: [],
				projectLoaded: false,
				error: `读不到 pi 的设置：${describe(error)}`,
			};
		}
		const { settings, manager } = opened;
		const diagnostics: PluginDiagnostic[] = [];
		const loadError = settings.drainErrors()[0];
		if (loadError) {
			diagnostics.push({
				type: "error",
				message: `${loadError.path ?? loadError.scope}：${describe(loadError.error)}`,
			});
		}

		const countsByPackage = new Map<string, PluginResourceCounts>();
		const resourcesByPackage = new Map<string, PluginResourceInfo[]>();
		const totals: PluginResourceCounts = { ...EMPTY_COUNTS };
		const extensions: PluginExtensionInfo[] = [];

		let resolved: ResolvedPaths;
		try {
			resolved = await manager.resolve(async (source) => {
				diagnostics.push({ type: "warning", source, message: "配置了这个插件包，但本地还没装" });
				return "skip";
			});
		} catch (error) {
			diagnostics.push({ type: "error", message: `读取已装插件失败：${describe(error)}` });
			resolved = { extensions: [], skills: [], prompts: [], themes: [] };
		}

		for (const key of RESOURCE_KEYS) {
			for (const resource of resolved[key]) {
				if (resource.metadata.origin === "top-level") {
					if (key !== "extensions") continue; // 散装技能/模板/主题归各自的 panel
					extensions.push({
						path: resource.path,
						name: resourceName(resource.path, "extension"),
						scope: scopeOf(resource.metadata.scope),
						enabled: resource.enabled,
					});
					if (resource.enabled) totals.extensions += 1;
					continue;
				}
				if (!resource.enabled) continue;
				const scope = scopeOf(resource.metadata.scope);
				const id = pluginKey(resource.metadata.source, scope);
				const counts = countsByPackage.get(id) ?? { ...EMPTY_COUNTS };
				counts[key] += 1;
				totals[key] += 1;
				countsByPackage.set(id, counts);
				const list = resourcesByPackage.get(id) ?? [];
				list.push(toResourceInfo(resource, key));
				resourcesByPackage.set(id, list);
			}
		}

		const disabled = new Map<string, boolean>();
		const filtered = new Map<string, boolean>();
		for (const scope of ["global", "project"] as const) {
			const entries =
				scope === "global" ? settings.getGlobalSettings().packages : settings.getProjectSettings().packages;
			for (const entry of entries ?? []) {
				const id = pluginKey(sourceOf(entry), scope);
				disabled.set(id, isDisabledEntry(entry));
				filtered.set(id, typeof entry === "object" && !isEmptiedEntry(entry));
			}
		}

		const packages: PluginPackageInfo[] = [];
		for (const configured of manager.listConfiguredPackages()) {
			const scope = scopeOf(configured.scope);
			const id = pluginKey(configured.source, scope);
			const counts = countsByPackage.get(id) ?? { ...EMPTY_COUNTS };
			const metadata = await readPackageMetadata(configured.installedPath);
			const isDisabled = disabled.get(id) ?? false;
			const loaded = counts.extensions + counts.skills + counts.prompts + counts.themes;
			packages.push({
				source: configured.source,
				scope,
				name: metadata.name,
				version: metadata.version,
				description: metadata.description,
				configuredVersion: configuredVersionOf(configured.source),
				disabled: isDisabled,
				filtered: filtered.get(id) ?? false,
				installedPath: configured.installedPath,
				status: isDisabled ? "disabled" : loaded > 0 ? "loaded" : configured.installedPath ? "installed" : "missing",
				counts,
				resources: resourcesByPackage.get(id) ?? [],
			});
		}

		const projectLoaded = settings.isProjectTrusted();
		return { packages, extensions, totals, diagnostics, projectLoaded };
	}

	/** 改一条 package 的启停；只动目标条目，其它条目与管理器里的其它键原样保留 */
	function setDisabled(settings: SettingsManager, source: string, scope: PluginScope, wanted: boolean): boolean {
		const current =
			scope === "global"
				? [...(settings.getGlobalSettings().packages ?? [])]
				: [...(settings.getProjectSettings().packages ?? [])];
		const index = current.findIndex((entry) => sourceOf(entry) === source);
		if (index === -1) return false;
		const entry = current[index]!;
		if (isDisabledEntry(entry) === wanted) return false;

		let next: PackageSource;
		if (wanted) {
			// 停用：autoload:false = 「先清空，再按 patterns 加回」。保留用户手写的过滤规则，
			// 否则「停一下再开」会把过滤弄丢。
			next = { ...(typeof entry === "string" ? { source: entry } : entry), autoload: false };
		} else if (typeof entry === "string") {
			next = entry;
		} else {
			const restored = { ...entry };
			delete restored.autoload;
			// `pi config` 那种「四类数组全空」的停用：开回来就把空数组删掉
			if (isEmptiedEntry(entry)) for (const key of RESOURCE_KEYS) delete restored[key];
			next = RESOURCE_KEYS.some((key) => restored[key] !== undefined) ? restored : restored.source;
		}
		current[index] = next;
		if (scope === "global") settings.setPackages(current);
		else settings.setProjectPackages(current);
		return true;
	}

	async function act(input: {
		workspace: string;
		action: PluginAction;
		source?: string;
		scope?: PluginScope;
	}): Promise<PluginsResult> {
		const scope = input.scope ?? "global";
		const source = input.source?.trim() ?? "";
		let actionError: string | undefined;
		let notice: string | undefined;

		if (input.action !== "update" && source === "") {
			return { ...(await readView(input.workspace)), actionError: "没有指定插件包" };
		}

		try {
			if (input.action === "install" || input.action === "remove" || input.action === "update") {
				await serialize(async () => {
					const { manager } = open(input.workspace);
					if (input.action === "install") {
						await manager.installAndPersist(source, { local: scope === "project" });
						notice = "装好了（对新会话生效）";
					} else if (input.action === "remove") {
						await manager.removeAndPersist(source, { local: scope === "project" });
						notice = "已卸载";
					} else {
						await manager.update(source === "" ? undefined : source);
						notice = "已更新（对新会话生效）";
					}
				});
			} else {
				const { settings } = open(input.workspace);
				const changed = setDisabled(settings, source, scope, input.action === "disable");
				await settings.flush();
				const writeError = settings.drainErrors()[0];
				if (writeError) throw new Error(describe(writeError.error));
				if (!changed) actionError = "这个插件包已经不在配置里了（刷新一下再看）";
				else notice = input.action === "disable" ? "已停用（对新会话生效）" : "已启用（对新会话生效）";
			}
		} catch (error) {
			actionError = describe(error);
		}

		return { ...(await readView(input.workspace)), actionError, notice };
	}

	return { view: readView, act };
}
