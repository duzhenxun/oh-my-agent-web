import { useCallback, useEffect, useState } from "react";
import { tNow, useT } from "../use-language.ts";

type ResourceKey = "extensions" | "skills" | "prompts" | "themes";
type PluginScope = "global" | "project";
type PluginStatus = "loaded" | "installed" | "missing" | "disabled";
type PluginResourceInfo = { kind: string; name: string; path: string; relativePath: string };

type Package = {
	source: string;
	scope: PluginScope;
	name?: string;
	version?: string;
	description?: string;
	configuredVersion?: string;
	disabled: boolean;
	filtered: boolean;
	installedPath?: string;
	status: PluginStatus;
	counts: Record<ResourceKey, number>;
	resources: PluginResourceInfo[];
};

type Standalone = { path: string; name: string; scope: PluginScope; enabled: boolean };
type Diagnostic = { type: "warning" | "error"; source?: string; message: string };

type View = {
	packages?: Package[];
	extensions?: Standalone[];
	totals?: Record<ResourceKey, number>;
	diagnostics?: Diagnostic[];
	projectLoaded?: boolean;
	error?: string | { message?: string };
	actionError?: string;
	notice?: string;
};

type Action = "install" | "remove" | "update" | "enable" | "disable";

const RESOURCE_LABEL: Record<ResourceKey, string> = {
	extensions: "扩展",
	skills: "技能",
	prompts: "模板",
	themes: "主题",
};

const RESOURCE_LABEL_EN: Record<ResourceKey, string> = {
	extensions: "extensions",
	skills: "skills",
	prompts: "prompts",
	themes: "themes",
};

const STATUS_LABEL: Record<PluginStatus, string> = {
	loaded: "已加载",
	installed: "已安装",
	missing: "缺失",
	disabled: "已停用",
};

/** `package:<source>` 只能当 React key；作用域不同的同名包要分开 */
function packageKey(item: { source: string; scope: PluginScope }): string {
	return `${item.scope}:${item.source}`;
}

/** 服务端两种错误形态：整体错误回 `{code,message}`，操作结果里是字符串 —— 都认 */
function errorText(view: View, status: number): string {
	if (typeof view.error === "string") return view.error;
	return view.error?.message ?? `HTTP ${status}`;
}

function describeCounts(counts: Record<ResourceKey, number>): string {
	const parts = (Object.keys(RESOURCE_LABEL) as ResourceKey[])
		.filter((key) => counts[key] > 0)
		.map((key) => `${tNow(RESOURCE_LABEL[key], RESOURCE_LABEL_EN[key])} ${counts[key]}`);
	return parts.length > 0 ? parts.join(" · ") : tNow("没有加载出资源", "no resources loaded");
}

/**
 * 插件面板：pi 的插件包（npm / git / 本地目录，全局 + 当前项目）+ 散装本机扩展。
 *
 * 数据走 HTTP 而不是快照 —— 跟技能面板同一套理由：这是按需查目录，不属会话状态。
 * 装 / 卸 / 更新 / 启停改的都是 pi 自己的配置与安装目录，**对新会话生效**：
 * 已经开着的对话在启动时就把扩展加载进来了。
 */
export function PluginsPanel() {
	const t = useT();
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [source, setSource] = useState("");
	const [installScope, setInstallScope] = useState<PluginScope>("global");
	/** 卸载要点两下：第一次只把按钮换成「确认卸载」，避免手滑删掉插件 */
	const [confirming, setConfirming] = useState<string | null>(null);

	const apply = (body: View) => {
		if (body.packages) setView(body);
		setError(body.actionError ?? (typeof body.error === "string" ? body.error : null));
		setNotice(body.notice ?? null);
	};

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/plugins");
			const body = (await response.json()) as View;
			if (!response.ok) {
				setError(errorText(body, response.status));
				return;
			}
			apply(body);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	const run = async (action: Action, target?: Package) => {
		const key = action + ":" + (target ? packageKey(target) : "new");
		setBusy(key);
		setNotice(null);
		try {
			const response = await fetch("/api/plugins", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action,
					source: target?.source ?? source,
					scope: target?.scope ?? installScope,
				}),
			});
			const body = (await response.json()) as View;
			if (!response.ok) {
				setError(errorText(body, response.status));
				return;
			}
			apply(body);
			if (action === "install") setSource("");
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
			setConfirming(null);
		}
	};

	if (view === null) return <div className="side-panel-hint">{t("正在读取插件…", "Loading plugins…")}</div>;

	const packages = view.packages ?? [];
	const extensions = view.extensions ?? [];
	const diagnostics = view.diagnostics ?? [];
	const groups: { scope: PluginScope; label: string; items: Package[] }[] = [
		{ scope: "global" as const, label: t("全局", "Global"), items: packages.filter((item) => item.scope === "global") },
		{
			scope: "project" as const,
			label: t("项目", "Project"),
			items: packages.filter((item) => item.scope === "project"),
		},
	].filter((group) => group.items.length > 0);

	const packageRow = (item: Package) => {
		const key = packageKey(item);
		const isBusy = busy !== null;
		return (
			<div className={`plugin-row${item.disabled ? " plugin-row-off" : ""}`} key={key}>
				<div className="plugin-main">
					<span className="plugin-name">
						{item.name ?? item.source}
						{item.disabled ? <span className="plugin-badge">{t("已停用", "Disabled")}</span> : null}
						{item.filtered && !item.disabled ? (
							<span className="plugin-badge plugin-badge-filtered">{t("已过滤", "Filtered")}</span>
						) : null}
						{item.version ? <span className="plugin-version">v{item.version}</span> : null}
						{!item.version && item.configuredVersion ? (
							<span className="plugin-version">{item.configuredVersion}</span>
						) : null}
					</span>
					<span
						className="plugin-meta"
						title={item.resources.length > 0 ? item.resources.map((one) => one.relativePath).join("\n") : undefined}
					>
						<span className={`plugin-status plugin-status-${item.status}`}>{t(STATUS_LABEL[item.status])}</span>
						{item.disabled ? "" : ` · ${describeCounts(item.counts)}`}
						{item.description ? ` · ${item.description}` : ""}
					</span>
					<span className="plugin-source mono" title={item.installedPath ?? item.source}>
						{item.source}
					</span>
				</div>
				<div className="plugin-actions">
					<button
						type="button"
						className="btn btn-tiny"
						disabled={isBusy}
						onClick={() => void run("update", item)}
						title={t(
							"更新到源里的最新版本（钉了版本的源不会动）",
							"Update to the latest version in the source (pinned versions stay put)",
						)}
					>
						{busy === `update:${key}` ? t("更新中…", "Updating…") : t("更新", "Update")}
					</button>
					<button
						type="button"
						className={`btn btn-tiny${confirming === key ? " btn-danger" : ""}`}
						disabled={isBusy}
						onClick={() => (confirming === key ? void run("remove", item) : setConfirming(key))}
						onBlur={() => setConfirming((current) => (current === key ? null : current))}
					>
						{busy === `remove:${key}`
							? t("卸载中…", "Removing…")
							: confirming === key
								? t("确认卸载", "Confirm remove")
								: t("卸载", "Remove")}
					</button>
					<button
						type="button"
						role="switch"
						aria-checked={!item.disabled}
						aria-label={`${item.disabled ? "启用" : "停用"} ${item.name ?? item.source}`}
						className={`plugin-switch${item.disabled ? "" : " plugin-switch-on"}`}
						disabled={isBusy}
						onClick={() => void run(item.disabled ? "enable" : "disable", item)}
					>
						{item.disabled ? t("已停用", "Disabled") : t("已启用", "Enabled")}
					</button>
				</div>
			</div>
		);
	};

	return (
		<div className="plugins">
			<div className="plugins-bar">
				<span className="side-panel-count">
					{packages.length} {t("个插件包", "plugin packages")} · {extensions.length}{" "}
					{t("个本机扩展", "local extensions")}
					{view.totals ? ` · ${t("已加载", "loaded")}: ${describeCounts(view.totals)}` : ""}
				</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" disabled={busy !== null} onClick={() => void load()}>
					{t("刷新", "Refresh")}
				</button>
			</div>

			<div className="plugins-install">
				<input
					className="plugins-install-input mono"
					value={source}
					placeholder={t(
						"npm:@scope/pi-plugin 或 git:https://github.com/user/repo 或 /本地目录",
						"npm:@scope/pi-plugin or git:https://github.com/user/repo or /local/folder",
					)}
					onChange={(event) => setSource(event.target.value)}
					onKeyDown={(event) => {
						if (event.key === "Enter" && source.trim() !== "") void run("install");
					}}
				/>
				<select
					className="plugins-install-scope"
					value={installScope}
					onChange={(event) => setInstallScope(event.target.value === "project" ? "project" : "global")}
					title={t("装到哪一份配置", "Which config it installs into")}
				>
					<option value="global">{t("全局", "Global")}</option>
					<option value="project" disabled={view.projectLoaded === false}>
						{t("项目", "Project")}
					</option>
				</select>
				<button
					type="button"
					className="btn btn-tiny"
					disabled={busy !== null || source.trim() === ""}
					onClick={() => void run("install")}
				>
					{busy === "install:new" ? t("安装中…", "Installing…") : t("安装", "Install")}
				</button>
			</div>

			{error ? <div className="side-panel-hint side-error">{error}</div> : null}
			{notice ? <div className="side-panel-hint">{notice}</div> : null}

			<div className="plugins-body">
				{groups.length === 0 && extensions.length === 0 ? (
					<div className="side-panel-hint">
						还没有插件。上面粘贴 npm / git / 本地目录装一个；也可以直接跑 <code>{t("pi install npm:包名")}</code>。
					</div>
				) : null}
				{groups.map((group) => (
					<div className="plugins-group" key={group.scope}>
						<div className="plugins-group-head">
							<span>{group.label}</span>
							<span className="side-panel-count">
								{group.items.length} {t("个包", "packages")} ·{" "}
								{group.scope === "global"
									? "~/.pi/agent/settings.json"
									: t("<项目>/.pi/settings.json", "<project>/.pi/settings.json")}
							</span>
						</div>
						<div className="plugin-list">{group.items.map(packageRow)}</div>
					</div>
				))}

				<div className="plugins-group">
					<div className="plugins-group-head">
						<span>{t("本机扩展", "Local extensions")}</span>
						<span className="side-panel-count">
							{t("不属于任何包的单文件扩展", "Single-file extensions that belong to no package")}
						</span>
					</div>
					{extensions.length === 0 ? (
						<div className="side-panel-hint">
							{t("没有本机扩展。写一个 .ts 扔进", "No local extensions. Drop a .ts file into")}{" "}
							<code>~/.pi/agent/extensions/</code> {t("就会出现在这里。", "and it will show up here.")}
						</div>
					) : (
						<div className="plugin-list">
							{extensions.map((item) => (
								<div className={`plugin-row${item.enabled ? "" : " plugin-row-off"}`} key={item.path}>
									<div className="plugin-main">
										<span className="plugin-name">
											{item.name}
											<span className="plugin-badge">{item.scope === "project" ? "项目" : "全局"}</span>
										</span>
										<span className="plugin-source mono" title={item.path}>
											{item.path}
										</span>
									</div>
									<span className="plugin-meta">{item.enabled ? "已启用" : "已停用"}</span>
								</div>
							))}
						</div>
					)}
				</div>

				{diagnostics.length > 0 ? (
					<div className="plugins-diagnostics">
						{diagnostics.map((item, index) => (
							<div
								className={`side-panel-hint${item.type === "error" ? " side-error" : ""}`}
								key={`${item.source ?? ""}-${index}`}
							>
								{item.source ? <code>{item.source}</code> : null} {item.message}
							</div>
						))}
					</div>
				) : null}
			</div>

			<div className="side-panel-hint">
				{t(
					"资源构成与状态来自 pi 自己解析的结果，所以这里显示的就是会话真正加载的东西。启停只改「加载不加载」，不删文件；装 / 卸 / 更新会动 pi 的安装目录。以上都",
					"Resources and their status come from pi's own resolution, so this is exactly what the session loads. Enabling or disabling only toggles loading (no files are deleted); install / remove / update touch pi's install directory. All of it is",
				)}
				<strong>{t("对新会话生效", "effective for new sessions")}</strong>
				{t(
					" —— 已经开着的对话在启动时就把扩展加载完了。",
					" — conversations already open loaded their extensions at startup.",
				)}
			</div>
		</div>
	);
}
