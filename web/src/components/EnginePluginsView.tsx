import { useCallback, useEffect, useState } from "react";
import { useT } from "../use-language.ts";

/**
 * 非 pi 引擎的插件面板：照各家自己的「插件」口径显示（见 server/plugins/engine-plugin-stores.ts）。
 *
 * 一行一个条目，右上角是它能做的动作（安装/删除/启停由服务端 `can` 决定）；
 * 顶部说清「这些是谁的插件、开关写在哪」—— 切到 claude 不会再看到 pi 的 packages。
 */

type PackageRow = {
	source: string;
	name?: string;
	version?: string;
	description?: string;
	disabled: boolean;
	status: string;
	installedPath?: string;
};

type PluginsView = {
	packages?: PackageRow[];
	engine?: string;
	source?: string;
	note?: string;
	can?: { install: boolean; remove: boolean; toggle: boolean; update: boolean };
	diagnostics?: Array<{ type: string; source?: string; message: string }>;
	error?: string;
	actionError?: string;
	notice?: string;
};

export function EnginePluginsView(props: { engine: string }) {
	const t = useT();
	const [view, setView] = useState<PluginsView | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [install, setInstall] = useState("");

	const load = useCallback(async () => {
		try {
			const response = await fetch("/api/plugins");
			const body = (await response.json()) as PluginsView;
			if (!response.ok) {
				setError(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
				return;
			}
			setView(body);
			setError(null);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load, props.engine]);

	const act = async (payload: Record<string, unknown>, key: string) => {
		setBusy(key);
		setNotice(null);
		try {
			const response = await fetch("/api/plugins", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await response.json()) as PluginsView;
			setView(body);
			setNotice(body.actionError ?? body.notice ?? null);
		} catch (failure) {
			setNotice(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(null);
		}
	};

	const can = view?.can;
	const packages = view?.packages ?? [];

	return (
		<div className="engine-panel">
			<div className="engine-panel-head">
				<span className="engine-panel-engine">{view?.engine ?? props.engine}</span>
				<code className="engine-panel-source">{view?.source ?? ""}</code>
				<button type="button" className="engine-panel-refresh" onClick={() => void load()} disabled={busy !== null}>
					{t("刷新", "Refresh")}
				</button>
			</div>

			{view?.note ? <div className="engine-panel-note-text">{view.note}</div> : null}
			{error ? <div className="engine-panel-error">{error}</div> : null}
			{view?.error ? <div className="engine-panel-error">{view.error}</div> : null}
			{notice ? <div className="engine-panel-notice">{notice}</div> : null}
			{view?.diagnostics?.map((item) => (
				<div key={`${item.type}:${item.message}`} className="engine-panel-row-note">
					{item.message}
				</div>
			))}

			{can?.install ? (
				<div className="engine-panel-add">
					<input
						value={install}
						onChange={(event) => setInstall(event.target.value)}
						placeholder={t("插件 id（形如 name@marketplace）", "plugin id, e.g. name@marketplace")}
					/>
					<button
						type="button"
						disabled={busy !== null || install.trim() === ""}
						onClick={async () => {
							await act({ action: "install", source: install.trim() }, "install");
							setInstall("");
						}}
					>
						{t("安装", "Install")}
					</button>
				</div>
			) : null}

			{packages.length === 0 ? (
				<div className="engine-panel-empty">{t("这个引擎目前没有插件。", "This engine currently has no plugins.")}</div>
			) : (
				<div className="engine-panel-list">
					{packages.map((item) => (
						<div key={item.source} className="engine-panel-row">
							<div className="engine-panel-row-main">
								<span className="engine-panel-row-name">{item.name ?? item.source}</span>
								{item.version ? <span className="engine-panel-tag">v{item.version}</span> : null}
								{/* 「装没装」与「开没开」是两件事：missing（市场里有、本机没装）单独说 */}
								<span className="engine-panel-tag">
									{item.status === "missing"
										? t("未安装", "not installed")
										: item.status === "disabled"
											? t("已停用", "disabled")
											: item.status}
								</span>
								{item.disabled && item.status !== "disabled" ? (
									<span className="engine-panel-tag">{t("已停用", "disabled")}</span>
								) : null}
							</div>
							{item.description ? <div className="engine-panel-row-note">{item.description}</div> : null}
							<code className="engine-panel-row-cmd">{item.installedPath ?? item.source}</code>
							<div className="engine-panel-row-actions">
								{can?.toggle ? (
									<button
										type="button"
										disabled={busy !== null}
										onClick={() =>
											void act({ action: item.disabled ? "enable" : "disable", source: item.source }, item.source)
										}
									>
										{item.disabled ? t("启用", "Enable") : t("停用", "Disable")}
									</button>
								) : null}
								{can?.remove ? (
									<button
										type="button"
										disabled={busy !== null}
										onClick={() => void act({ action: "remove", source: item.source }, item.source)}
									>
										{t("卸载", "Remove")}
									</button>
								) : null}
							</div>
						</div>
					))}
				</div>
			)}

			<div className="engine-panel-foot">
				{t(
					"这些插件属于当前引擎自己；切换引擎会换成那个引擎的清单。",
					"These plugins belong to the current engine; switching engines switches the list.",
				)}
			</div>
		</div>
	);
}
