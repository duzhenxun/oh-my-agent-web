import { useCallback, useEffect, useRef, useState } from "react";
import { SCOPE_LABEL, commandLine, serverKey, type Server, type View } from "../mcp-view.ts";
import { useT } from "../use-language.ts";

/**
 * 非 pi 引擎的 MCP 面板 —— **布局与 pi 的一致**：左边是装过的服务器（按项目 / 全局分组），
 * 点一台，右边显示它的详情；「添加」做成右栏的一页（左栏 220px 放不下一页 npx 命令）。
 *
 * 与 pi 面板的差别只在**能改什么**（后端能力位 `view.can`）：
 *   - pi 有暴露方式（codemode / deferred）、`pi mcp login` 的 OAuth、连接测试；
 *   - codex 有增删启停 + 引擎自己报上来的工具清单（`mcpServerStatus/list`）；
 *   - claude 只有增删（它没有单条 enabled）；opencode 有增删启停；dsh 还没接。
 * 画不出来的按钮就不画 —— 点了假成功的按钮比少一个按钮更糟。
 *
 * 为什么走 HTTP 而不是快照：这是按需读配置，不是会话状态（与 pi 面板同一个理由）。
 */
export function EngineMcpView(props: { engine: string; source?: string }) {
	const t = useT();
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [text, setText] = useState("");
	const [adding, setAdding] = useState(false);
	/** 添加页写到哪个作用域（引擎有项目文件才给选；默认全局，与 pi 一致） */
	const [addScope, setAddScope] = useState<"global" | "project">("global");
	const [confirming, setConfirming] = useState<string | null>(null);
	/** codex 的 `mcpServerStatus/list` 会真去连各台服务器：第一次要几秒，得说清「在读了」 */
	const [loading, setLoading] = useState(true);
	/** 左栏选中的服务器（`scope:name`）；右栏显示的是它 */
	const [selected, setSelected] = useState<string | null>(null);
	/**
	 * 左栏宽度（可左右拖，存 localStorage —— 纯界面偏好，不进快照）。
	 * 与 pi 的 MCP 面板同一把尺子（默认 220px，160–520，双击复位）。
	 */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem("agent-web:engine-mcp-list-width"));
		return Number.isFinite(stored) && stored >= 160 && stored <= 520 ? stored : 220;
	});
	useEffect(() => {
		localStorage.setItem("agent-web:engine-mcp-list-width", String(listWidth));
	}, [listWidth]);
	const resizing = useRef(false);
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		resizing.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!resizing.current) return;
			setListWidth(Math.min(520, Math.max(160, startWidth + (moveEvent.clientX - startX))));
		};
		const onUp = () => {
			resizing.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	const load = useCallback(async () => {
		setLoading(true);
		try {
			const response = await fetch("/api/mcp");
			const body = (await response.json()) as View;
			if (!response.ok) {
				setError(typeof body.error === "string" ? body.error : `HTTP ${response.status}`);
				return;
			}
			setView(body);
			setError(null);
		} catch (failure) {
			setError(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load, props.engine]);

	const act = async (payload: Record<string, unknown>, key: string) => {
		setBusy(key);
		setNotice(null);
		try {
			const response = await fetch("/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify(payload),
			});
			const body = (await response.json()) as View & { added?: string[] };
			setView(body);
			setNotice(body.actionError ?? body.notice ?? null);
			// 加完自动选中刚加的那台（名字由服务端给：多条一起粘进来时猜「第一条」经常猜错）
			const added = body.added?.[0];
			if (payload.action === "add" && added !== undefined) {
				const scope = (payload.scope === "project" ? "project" : "global") as "global" | "project";
				setSelected(`${scope}:${added}`);
			}
		} catch (failure) {
			setNotice(failure instanceof Error ? failure.message : String(failure));
		} finally {
			setBusy(null);
			setConfirming(null);
		}
	};

	const can = view?.can;
	const servers: Server[] = view?.servers ?? [];
	const current = servers.find((server) => serverKey(server) === selected) ?? null;
	/** 项目 / 全局分两段（与 pi 的左栏一致）；没有的那一段不画 */
	const groups = (["project", "global"] as const)
		.map((scope) => ({ scope, items: servers.filter((server) => server.scope === scope) }))
		.filter((group) => group.items.length > 0 || (group.scope === "global" ? servers.length === 0 : false));

	return (
		<div className="mcp engine-panel engine-panel-mcp">
			<div className="engine-panel-head">
				<span className="engine-panel-engine">{view?.engine ?? props.engine}</span>
				<code className="engine-panel-source">{view?.source ?? props.source ?? ""}</code>
				<span className="engine-panel-count">
					{view?.enabled ?? 0}/{view?.total ?? 0} {t("启用", "enabled")}
				</span>
				<button type="button" className="engine-panel-refresh" onClick={() => void load()} disabled={busy !== null}>
					{t("刷新", "Refresh")}
				</button>
			</div>

			{error ? <div className="engine-panel-error">{error}</div> : null}
			{view?.errors?.map((message) => (
				<div key={message} className="engine-panel-error">
					{message}
				</div>
			))}
			{notice ? <div className="engine-panel-notice">{notice}</div> : null}

			<div className="mcp-shell" style={{ "--mcp-list-width": `${listWidth}px` } as React.CSSProperties}>
				<div className="mcp-list">
					<div className="mcp-list-scroll">
						{loading && view === null ? (
							<div className="side-panel-hint">
								{t("正在读当前引擎的 MCP 配置…", "Reading the current engine's MCP config…")}
							</div>
						) : null}
						{groups.map((group) => (
							<div className="mcp-group" key={group.scope}>
								<div className="mcp-group-head">
									<span>{group.scope === "project" ? t("项目", "Project") : t("全局", "Global")}</span>
									<span className="side-panel-count">
										{group.items.filter((server) => server.enabled).length}/{group.items.length}
									</span>
								</div>
								{group.items.length === 0 ? (
									<div className="side-panel-count">{t("还没有 MCP 服务器", "No MCP servers yet")}</div>
								) : (
									group.items.map((server) => (
										<button
											type="button"
											key={serverKey(server)}
											className={`mcp-item${selected === serverKey(server) ? " mcp-item-on" : ""}${server.enabled ? "" : " mcp-item-off"}`}
											title={server.description ?? server.name}
											onClick={() => {
												setSelected(serverKey(server));
												setAdding(false);
											}}
										>
											<span className={`mcp-dot${server.enabled ? " mcp-dot-on" : ""}`} aria-hidden="true" />
											<span className="mcp-item-name">{server.name}</span>
										</button>
									))
								)}
								{group.scope === "project" && group.items.length > 0 && view?.projectPath ? (
									<span className="mcp-list-path mono" title={view.projectPath}>
										{view.projectPath}
									</span>
								) : null}
								{group.scope === "global" && view?.globalPath ? (
									<span className="mcp-list-path mono" title={view.globalPath}>
										{view.globalPath}
									</span>
								) : null}
							</div>
						))}
					</div>
					{can?.add ? (
						<div className="mcp-left-actions">
							<button
								type="button"
								className={`btn btn-tiny${adding ? " btn-on" : ""}`}
								onClick={() => setAdding((open) => !open)}
							>
								＋ {t("添加 MCP", "Add MCP")}
							</button>
						</div>
					) : null}
				</div>

				{/* 左右拖：调左栏宽度（双击复位）。手机断点里整块变上下两段，这条线由 CSS 隐藏 */}
				<div
					className="mcp-list-resizer"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("调整服务器列表宽度", "Resize the server list")}
					title={t("左右拖动调整列表宽度（双击复位）", "Drag to resize the list (double-click to reset)")}
					onPointerDown={startResize}
					onDoubleClick={() => setListWidth(220)}
				/>

				<div className={`mcp-detail${adding ? " mcp-detail-pane" : ""}`}>
					{adding ? (
						<div className="mcp-add-pane">
							<div className="mcp-add-head">
								<strong>{t("添加 MCP", "Add MCP")}</strong>
								{view?.projectPath !== undefined && view.projectPath !== "" ? (
									<div className="mcp-scope-tabs">
										{(["global", "project"] as const).map((scope) => (
											<button
												type="button"
												key={scope}
												className={`mcp-scope-tab${addScope === scope ? " mcp-scope-tab-on" : ""}`}
												onClick={() => setAddScope(scope)}
											>
												{scope === "global" ? t("全局", "Global") : t("项目", "Project")}
											</button>
										))}
									</div>
								) : null}
								<span className="side-panel-count">
									{t("写进引擎自己的配置文件", "Written into the engine's own config")}
								</span>
							</div>
							<textarea
								value={text}
								onChange={(event) => setText(event.target.value)}
								placeholder={t(
									"粘一段就行：URL / 命令行 / 各家 CLI 的 mcp add 命令 / JSON",
									"Paste anything: a URL, a command line, a vendor `mcp add` command, or JSON",
								)}
								rows={6}
							/>
							<div className="mcp-add-head">
								<button
									type="button"
									className="btn btn-tiny btn-primary"
									disabled={busy !== null || text.trim() === ""}
									onClick={async () => {
										await act({ action: "add", text, scope: addScope }, "add");
										setText("");
										setAdding(false);
									}}
								>
									{busy === "add" ? t("添加中…", "Adding…") : t("添加", "Add")}
								</button>
								<button type="button" className="btn btn-tiny" onClick={() => setAdding(false)}>
									{t("取消", "Cancel")}
								</button>
								<span className="topbar-spacer" />
								<code className="engine-panel-source">
									{(addScope === "project" ? view?.projectPath : view?.globalPath) ?? ""}
								</code>
							</div>
						</div>
					) : current === null ? (
						<div className="side-panel-hint">
							{servers.length === 0
								? t(
										`这个引擎还没有 MCP 服务器：点左下角「＋ 添加 MCP」加一台（会写进 ${view?.globalPath ?? "它自己的配置"}）。`,
										`This engine has no MCP servers yet — use "＋ Add MCP" in the bottom-left (it writes into ${view?.globalPath ?? "its own config"}).`,
									)
								: t("左边挑一台服务器看详情。", "Pick a server on the left to see details.")}
						</div>
					) : (
						<>
							<div className="mcp-detail-head">
								<span className="mcp-badge">{SCOPE_LABEL[current.scope]}</span>
								<span className="mcp-detail-name">{current.name}</span>
								<span className="topbar-spacer" />
								{can?.toggle ? (
									<button
										type="button"
										className="btn btn-tiny"
										disabled={busy !== null}
										onClick={() =>
											void act(
												{
													action: "set-enabled",
													name: current.name,
													scope: current.scope,
													enabled: !current.enabled,
												},
												`toggle:${serverKey(current)}`,
											)
										}
									>
										{current.enabled ? t("停用", "Disable") : t("启用", "Enable")}
									</button>
								) : null}
								{can?.remove ? (
									<button
										type="button"
										className={`btn btn-tiny${confirming === serverKey(current) ? " btn-danger" : ""}`}
										disabled={busy !== null}
										onClick={() => {
											if (confirming !== serverKey(current)) {
												setConfirming(serverKey(current));
												return;
											}
											void act(
												{ action: "remove", name: current.name, scope: current.scope },
												`remove:${serverKey(current)}`,
											);
											setSelected(null);
										}}
									>
										{confirming === serverKey(current) ? t("确认删除", "Confirm") : t("删除", "Remove")}
									</button>
								) : null}
							</div>
							<div className="mcp-body">
								<Row label={t("状态", "Status")}>
									<span className={current.enabled ? "mcp-state-on" : "mcp-state-off"}>
										{current.enabled ? t("已启用", "enabled") : t("已停用", "disabled")}
									</span>
								</Row>
								<Row label={t("作用域", "Scope")}>
									{SCOPE_LABEL[current.scope]} · <code className="mono">{current.source}</code>
								</Row>
								<Row label={t("传输", "Transport")}>{current.transport}</Row>
								<Row label={current.transport === "http" ? "URL" : t("命令", "Command")}>
									<code className="mono">
										{current.transport === "http" ? (current.url ?? "") : commandLine(current)}
									</code>
								</Row>
								{current.cwd !== undefined && current.cwd !== "" ? (
									<Row label={t("工作目录", "cwd")}>
										<code className="mono">{current.cwd}</code>
									</Row>
								) : null}
								{current.env && Object.keys(current.env).length > 0 ? (
									<Row label={t("环境变量", "Env")}>
										<span className="mono">
											{/* 只列键名：值是凭据，面板不该把它摊在屏幕上 */}
											{Object.keys(current.env)
												.map((key) => `${key}=***`)
												.join("  ")}
										</span>
									</Row>
								) : null}
								{current.headers && Object.keys(current.headers).length > 0 ? (
									<Row label={t("请求头", "Headers")}>
										<span className="mono">
											{Object.keys(current.headers)
												.map((key) => `${key}: ***`)
												.join("  ")}
										</span>
									</Row>
								) : null}
								{current.envRefs.length > 0 ? (
									<Row label={t("引用的变量", "Referenced vars")}>
										<span className="mono">
											{current.envRefs.map((ref) => `${ref.key} → ${ref.variable}`).join("  ")}
										</span>
									</Row>
								) : null}
								<Row label={t("工具", "Tools")}>
									{current.tools !== undefined && current.tools.length > 0 ? (
										<span>
											{`${current.tools.length} ${t("个", "")}`}
											<span className="side-panel-count">
												{`${t("：", ": ")}${current.tools
													.slice(0, 8)
													.map((tool) => tool.name)
													.join(" · ")}${current.tools.length > 8 ? " …" : ""}`}
											</span>
										</span>
									) : (
										<span className="side-panel-count">
											{t("引擎没报工具清单（打开会话后由引擎自己加载）", "The engine did not report a tool list")}
										</span>
									)}
								</Row>
								{current.description !== undefined && current.description !== "" ? (
									<Row label={t("描述", "Description")}>{current.description}</Row>
								) : null}
								{current.note !== undefined && current.note !== "" ? (
									<Row label={t("说明", "Note")}>{current.note}</Row>
								) : null}
								{current.override !== undefined && current.override !== "" ? (
									<Row label={t("覆盖", "Override")}>
										<code className="mono">{current.override}</code>
									</Row>
								) : null}
							</div>
						</>
					)}
				</div>
			</div>

			<div className="engine-panel-foot">
				{t(
					"这些配置属于当前引擎自己；切换引擎会换成那个引擎的清单。",
					"These settings belong to the current engine; switching engines switches the list.",
				)}
			</div>
		</div>
	);
}

/** 详情里的一行（与 pi 的 MCP 详情同一套类名，样式不用另写） */
function Row({ label, children }: { label: string; children: React.ReactNode }) {
	return (
		<div className="mcp-row">
			<span className="mcp-row-key">{label}</span>
			<span className="mcp-row-value">{children}</span>
		</div>
	);
}
