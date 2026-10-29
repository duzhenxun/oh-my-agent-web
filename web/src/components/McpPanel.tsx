import { useCallback, useEffect, useRef, useState } from "react";
import { McpAdd } from "./McpAdd.tsx";
import { McpList } from "./McpList.tsx";
import { McpDetailBody } from "./McpDetail.tsx";
import { McpMarket } from "./McpMarket.tsx";
import { SCOPE_LABEL, errorText, serverKey, type Action, type LoginState, type Scope, type View } from "../mcp-view.ts";
import { useT } from "../use-language.ts";

/** 右栏现在显示什么：某一台的详情 / 添加表单 / 市场 */
type Pane = { kind: "detail" } | { kind: "add" } | { kind: "market" };

/**
 * MCP 面板：pi 的 MCP 服务器（项目 `.pi/mcp.json` + 全局 `~/.pi/agent/mcp.json`）。
 *
 * 与「插件」面板同一套理由走 HTTP 而不是快照：这是按需查配置，不是会话状态。
 * 面板里能改的东西都**写回 pi 自己的 mcp.json**，所以显示的就是会话启动时真正会连的；
 * 改完**对新会话生效** —— 已经开着的对话在启动时就连好了。
 *
 * 「测试连接」是本面板唯一主动发起的网络/进程动作：按配置真起一次连接、握手 + `tools/list`
 * 再立刻关掉。它有副作用（会跑 `npx …`），所以只在点按钮时做，不在打开面板时自动做。
 *
 * 布局：左栏只有「有哪些服务器」（可拖宽），右栏三种内容——
 *   详情（某一台的配置 + 测试）、**添加**（一个框什么都收，见 McpAdd）、**市场**（见 McpMarket）。
 * 添加/市场都放右栏：左栏 220px 连一条 npx 命令都放不下，而这两个是「编辑」动作，
 * 跟右边那套「看/改这一台」是一类东西。
 */

export function McpPanel() {
	const t = useT();
	const [view, setView] = useState<View | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [notice, setNotice] = useState<string | null>(null);
	const [busy, setBusy] = useState<string | null>(null);
	const [selected, setSelected] = useState<string | null>(null);
	const [confirming, setConfirming] = useState<string | null>(null);
	const [pane, setPane] = useState<Pane>({
		kind: "detail",
	});
	/** 添加表单写到哪个作用域（表单里可切，记在面板层：切到别处再回来不丢） */
	const [addScope, setAddScope] = useState<Scope>("global");
	/** 添加框里粘的内容与市场页的源 / 搜索词：都放面板层，切页不丢 */
	const [addText, setAddText] = useState("");
	const [marketSource, setMarketSource] = useState<"registry" | "smithery" | "github">("registry");
	const [marketQuery, setMarketQuery] = useState("");
	/** 正在等授权的那一台（服务器名 → 状态）：面板轮询它的进度 */
	const [login, setLogin] = useState<{ name: string; scope: Scope; state: LoginState } | null>(null);
	const [loading, setLoading] = useState(true);
	/**
	 * 左栏宽度（可左右拖，存 localStorage —— 纯界面偏好，不进快照）。
	 * 跟「模型」面板同一把尺子：默认 220px（名字比 provider 长一点，`@scope/name` 那种要放得下），
	 * 上下限 160–520，双击那条线复位。
	 */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem("agent-web:mcp-list-width"));
		return Number.isFinite(stored) && stored >= 160 && stored <= 520 ? stored : 220;
	});
	useEffect(() => {
		localStorage.setItem("agent-web:mcp-list-width", String(listWidth));
	}, [listWidth]);
	const resizing = useRef(false);
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		resizing.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		// pointer 事件挂 document：鼠标拖出那条线（甚至拖到面板外）也能继续跟手
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
	const resetWidth = () => setListWidth(220);

	/**
	 * 等授权期间轮询 `login-status`：子进程退出（退出码 0 = 授权完成）时面板要自己知道，
	 * 否则用户得猜「刚才那下点开授权页到底成没成」。完成后自动重测一次，省一次点击。
	 */
	useEffect(() => {
		if (login?.state.status !== "waiting") return;
		const target = { name: login.name, scope: login.scope };
		const timer = window.setInterval(() => void run("login-status", target), 2000);
		return () => window.clearInterval(timer);
		// run 每次渲染都是新函数，但它只用 target/setState：依赖里刻意只放这两个字段
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [login?.state.status, login?.name, login?.scope]);

	useEffect(() => {
		if (login?.state.status !== "done") return;
		void run("test", { name: login.name, scope: login.scope });
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [login?.state.status, login?.name, login?.scope]);

	const apply = (body: View) => {
		if (body.servers) setView(body);
		setError(body.actionError ?? (typeof body.error === "string" ? body.error : null));
		setNotice(body.notice ?? null);
	};

	const load = useCallback(async () => {
		setError(null);
		setLoading(true);
		try {
			const response = await fetch("/api/mcp");
			const parsed = await readView(response);
			if (parsed.view === undefined) {
				setError(parsed.error ?? `HTTP ${response.status}`);
				return;
			}
			if (!response.ok) {
				setError(errorText(parsed.view, response.status));
				return;
			}
			apply(parsed.view);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setLoading(false);
		}
	}, []);

	useEffect(() => {
		void load();
	}, [load]);

	/**
	 * 一次操作。`extra` 直接当请求体的一部分发出去：
	 *   - 添加：`{ text }`（粘的一整段）或 `{ config, name }`（市场卡片）；
	 *   - 其余：`{ enabled }` / `{ exposure }` / `{ scope }` 这类开关字段。
	 */
	const run = async (action: Action, target?: { name: string; scope: Scope }, extra: Record<string, unknown> = {}) => {
		const key = `${action}:${target ? serverKey(target) : String(extra.scope ?? "new")}`;
		setBusy(key);
		setNotice(null);
		try {
			const response = await fetch("/api/mcp", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					action,
					name: target?.name,
					scope: target?.scope ?? extra.scope,
					...extra,
				}),
			});
			const body = (await response.json()) as View & { login?: LoginState };
			if (!response.ok) {
				setError(errorText(body, response.status));
				return;
			}
			apply(body);
			if (body.login !== undefined) {
				// scope 只有调用点知道（body 里只有名字）：登录动作一定带着 target
				const scope = (target?.scope ?? (extra.scope as Scope | undefined) ?? "global") as Scope;
				setLogin({ name: body.login.name, scope, state: body.login });
			}
			// 添加成功后回详情页，并把**刚加的那台**选上（省得用户再去左边找）。
			// 名字用服务端回的 `added`：多条一起粘进来时，猜「第一条」经常猜错。
			if (action === "add" && body.servers) {
				setPane({ kind: "detail" });
				const scope = (extra.scope ?? addScope) as Scope;
				const name = (body as { added?: string[] }).added?.[0];
				const added = body.servers.find(
					(server) => server.scope === scope && (name === undefined || server.name === name),
				);
				if (added) setSelected(serverKey(added));
			}
			if (action === "remove" && target && selected === serverKey(target)) setSelected(null);
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(null);
			setConfirming(null);
		}
	};

	/**
	 * 还没读到配置（首次加载 / 上一版服务端没有这个接口）：
	 * **不能只写「正在读取…」** —— 读失败时那行字会一直挂着，看起来像卡死（踩过：
	 * 跑着旧版本的 Pi Web，`GET /api/mcp` 回的是 404 的 HTML，面板就永远停在读取中）。
	 */
	if (view === null) {
		return (
			<div className="mcp mcp-boot">
				{error !== null ? (
					<>
						<div className="side-panel-hint side-error">
							{t("读不到 MCP 配置：", "Cannot read the MCP config: ")}
							{error}
						</div>
						<div className="mcp-boot-actions">
							<button type="button" className="btn btn-tiny" disabled={loading} onClick={() => void load()}>
								{loading ? "重试中…" : "重试"}
							</button>
						</div>
					</>
				) : (
					<div className="side-panel-hint">{t("正在读取 MCP 配置…", "Reading the MCP config…")}</div>
				)}
			</div>
		);
	}

	const servers = view.servers ?? [];
	const current = servers.find((server) => serverKey(server) === selected) ?? null;
	const total = view.total ?? servers.length;
	const enabled = view.enabled ?? servers.filter((server) => server.enabled).length;

	return (
		<div className="mcp">
			<div className="mcp-shell" style={{ "--mcp-list-width": `${listWidth}px` } as React.CSSProperties}>
				<McpList
					servers={servers}
					projectPath={view.projectPath ?? ""}
					globalPath={view.globalPath ?? ""}
					selected={selected}
					pane={pane.kind}
					busy={busy !== null}
					onSelect={(key) => {
						// 点左边的服务器 = 要看它：右栏如果停在「添加 / 市场」，顺手切回详情
						setSelected(key);
						setPane({ kind: "detail" });
					}}
					onToggleScope={(scope, enabled) => void run("set-scope-enabled", undefined, { scope, enabled })}
					onPane={(kind) => setPane(pane.kind === kind ? { kind: "detail" } : { kind })}
				/>

				{/* 左右拖：调左栏宽度（双击复位）。手机断点里整块变上下两段，这条线由 CSS 隐藏 */}
				<div
					className="mcp-list-resizer"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("调整服务器列表宽度", "Resize the server list")}
					title={t("左右拖动调整列表宽度（双击复位）", "Drag to resize the list (double-click to reset)")}
					onPointerDown={startResize}
					onDoubleClick={resetWidth}
				/>

				<div className={`mcp-detail${pane.kind === "detail" ? "" : " mcp-detail-pane"}`}>
					{pane.kind === "add" ? (
						<McpAdd
							text={addText}
							onText={setAddText}
							scope={addScope}
							scopePath={addScope === "project" ? (view.projectPath ?? "") : (view.globalPath ?? "")}
							onScope={setAddScope}
							busy={busy !== null}
							onCancel={() => setPane({ kind: "detail" })}
							onSubmit={(text) => void run("add", undefined, { text, scope: addScope })}
						/>
					) : pane.kind === "market" ? (
						<McpMarket
							installed={servers.map((server) => server.name)}
							busy={busy !== null}
							source={marketSource}
							onSource={setMarketSource}
							query={marketQuery}
							onQuery={setMarketQuery}
							onAdd={(entry, scope) =>
								void run("add", undefined, {
									scope,
									name: entry.name,
									config: entry.config,
									description: entry.description === "" ? undefined : entry.description,
								})
							}
						/>
					) : current === null ? (
						<div className="side-panel-hint">
							{t("左边挑一个服务器看详情。", "Pick a server on the left to see details.")}
						</div>
					) : (
						<>
							<div className="mcp-detail-head">
								<span className="mcp-badge">{SCOPE_LABEL[current.scope]}</span>
								<span className="mcp-detail-name">{current.name}</span>
								<span className="topbar-spacer" />
								<button
									type="button"
									className="btn btn-tiny"
									disabled={busy !== null}
									onClick={() => void run("test", current)}
									title={t(
										"按配置真连一次：握手 + 列出工具，然后关掉",
										"Actually connect once using the config: handshake + list tools, then disconnect",
									)}
								>
									{busy?.startsWith("test:") ? "连接中…" : "测试连接"}
								</button>
								<button
									type="button"
									className={`btn btn-tiny${confirming === serverKey(current) ? " btn-danger" : ""}`}
									disabled={busy !== null}
									onClick={() =>
										confirming === serverKey(current) ? void run("remove", current) : setConfirming(serverKey(current))
									}
									onBlur={() => setConfirming((value) => (value === serverKey(current) ? null : value))}
								>
									{busy?.startsWith("remove:") ? "移除中…" : confirming === serverKey(current) ? "确认移除" : "移除"}
								</button>
								<button
									type="button"
									role="switch"
									aria-checked={current.enabled}
									className={`mcp-switch${current.enabled ? " mcp-switch-on" : ""}`}
									disabled={busy !== null}
									onClick={() => void run("set-enabled", current, { enabled: !current.enabled })}
								>
									{current.enabled ? "已启用" : "已停用"}
								</button>
							</div>

							<McpDetailBody
								server={current}
								busy={busy !== null}
								login={login?.name === current.name ? login.state : undefined}
								onExposure={(exposure) => void run("set-exposure", current, { exposure })}
								onLogin={() => void run("login", current)}
								onLoginCancel={() => {
									void run("login-cancel", current);
									setLogin(null);
								}}
								onRecheck={() => {
									// 先问一次登录状态（子进程退出 = 授权完成），再重测连接
									void run("login-status", current).then(() => run("test", current));
								}}
							/>
						</>
					)}
				</div>
			</div>

			<div className="mcp-bar">
				<span className="side-panel-count">
					{t("已开启", "Enabled")} {enabled}/{total} {t("个服务器", "servers")}
					{view.autoEnableCodemode === false ? " · 代码模式不会自动打开" : ""}
				</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" disabled={busy !== null} onClick={() => void load()}>
					{t("刷新", "Refresh")}
				</button>
			</div>

			{error ? <div className="side-panel-hint side-error">{error}</div> : null}
			{notice ? <div className="side-panel-hint">{notice}</div> : null}
			{(view.errors ?? []).length > 0 ? (
				<div className="mcp-diagnostics">
					{(view.errors ?? []).map((message, index) => (
						<div className="side-panel-hint side-error" key={`${index}-${message}`}>
							{message}
						</div>
					))}
				</div>
			) : null}

			<div className="side-panel-hint">
				{t("配置读的就是 pi 自己的", "The config is pi's own")} <code>mcp.json</code>
				{t("（", " (")}
				{t(
					"项目覆盖全局，只写 enabled / exposure 的项目条目是覆盖项",
					"project entries override global ones; entries that only set enabled / exposure act as overrides",
				)}
				）。
				{t("启停与暴露方式写回同一个文件，", "Enable flags and exposure are written back to the same file, ")}
				<strong>{t("对新会话生效", "effective for new sessions")}</strong>
				{t(
					"；「测试连接」只握手 + 列工具，不调用任何工具。",
					"; “Test connection” only handshakes and lists tools — it calls no tools.",
				)}
			</div>
		</div>
	);
}

/**
 * 把 `GET /api/mcp` 的响应读成 View。
 *
 * 为什么要自己读 text：服务端**不一定**回 JSON —— 跑的是旧版本（没有这个路由）时，
 * Express 的兜底会回一段 404 HTML，直接 `response.json()` 抛出去只能得到
 * `Unexpected token '<'`，人看不懂，也不知道该重启。
 */
async function readView(response: Response): Promise<{ view?: View; error?: string }> {
	const text = await response.text();
	try {
		return { view: JSON.parse(text) as View };
	} catch {
		const snippet = text
			.replace(/<[^>]*>/g, " ")
			.replace(/\s+/g, " ")
			.trim()
			.slice(0, 120);
		return {
			error:
				response.status === 404
					? "服务端没有 /api/mcp 这个接口（大概率是跑着旧版本）：重启 Pi Web 后再打开这个面板"
					: `HTTP ${response.status}${snippet === "" ? "" : `：${snippet}`}`,
		};
	}
}
