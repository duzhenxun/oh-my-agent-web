import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";
import {
	EXPOSURE_HINT,
	EXPOSURE_LABEL,
	commandLine,
	isCommandValue,
	needsLogin,
	type Exposure,
	type LoginState,
	type Server,
} from "../mcp-view.ts";
import { useT } from "../use-language.ts";

/**
 * MCP 详情（右栏）：一台服务器「到底怎么配的、连不连得上」。
 *
 * 只读字段按**配置原文**显示，不做美化 —— 面板说「就是这份配置」时，用户对不上才好去查文件。
 * 能改的只有两样：暴露方式（下拉）和启停（在外层标题栏），其余一律回 pi 的文件里改。
 */
/** 详情正文：只读字段按「配置原文怎么说」显示，不做美化（对不上时才查配置文件） */
export function McpDetailBody({
	server,
	busy,
	login,
	onExposure,
	onLogin,
	onLoginCancel,
	onRecheck,
}: {
	server: Server;
	busy: boolean;
	/** 这台正在等授权时的状态 */
	login?: LoginState;
	onExposure: (exposure: Exposure) => void;
	/** 起一次 `pi mcp login`（只有 HTTP 服务器会出现这个按钮） */
	onLogin: () => void;
	onLoginCancel: () => void;
	/** 授权完成后重测一次 */
	onRecheck: () => void;
}) {
	const t = useT();
	const probe = server.probe;
	/** 认证失败要单独说话：这不是「配置写错了」，是「还没登录」 */
	const authFailed = probe !== undefined && !probe.ok && needsLogin(probe.error);
	const probeText = probe
		? probe.ok
			? `连接成功 · ${probe.tools.length} 个工具 · ${probe.ms}ms`
			: `连接失败 · ${probe.error ?? "未知错误"}`
		: "还没测过";
	return (
		<div className="mcp-body">
			<Row label="状态">
				<span className={server.enabled ? "mcp-state-on" : "mcp-state-off"}>
					{server.enabled ? "已启用" : "已停用"}
				</span>
				<span className={probe && !probe.ok ? "side-error" : "side-panel-count"}> · {probeText}</span>
			</Row>

			{authFailed || (server.transport === "http" && (server.auth !== undefined || login !== undefined)) ? (
				<Row label="授权">
					<span className="mcp-auth">
						{login?.status === "waiting" ? (
							<>
								<span className="side-panel-count">
									在浏览器里完成授权{login.url === undefined ? "（正在准备授权页…）" : "，完成后回来点「我已授权」"}：
								</span>
								{login.url !== undefined ? (
									<a className="mcp-catalog-link mcp-auth-url mono" href={login.url} target="_blank" rel="noreferrer">
										打开授权页 ↗
									</a>
								) : null}
								<button type="button" className="btn btn-tiny" onClick={onRecheck}>
									我已授权，重测
								</button>
								<button type="button" className="btn btn-tiny" onClick={onLoginCancel}>
									取消
								</button>
							</>
						) : server.auth?.present && server.auth.expired ? (
							<>
								<span className="side-panel-count">
									存过凭据但已过期（pi 会在真正调用时用 refresh token 续期；连不上就重新登录一次）
								</span>
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={onLogin}>
									重新登录
								</button>
							</>
						) : server.auth?.present ? (
							<>
								<span className="mcp-auth-ok">
									{t("已登录", "Signed in")}
									{server.auth.scope ? ` (${server.auth.scope})` : ""}
								</span>
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={onLogin}>
									重新登录
								</button>
							</>
						) : (
							<>
								<span className="side-panel-count">
									这台是远程 HTTP 服务器，要 OAuth 授权才能用（对面回了 401 / requires authentication）。 登录用 pi
									自己的 <code>pi mcp login</code> {t("流程，凭据写进")} <code>mcp-auth.json</code>，会话也跟着用。
								</span>
								<button type="button" className="btn btn-tiny btn-primary-add" disabled={busy} onClick={onLogin}>
									{busy ? "准备中…" : "登录"}
								</button>
							</>
						)}
						{login?.status === "failed" ? <span className="side-error">{login.message ?? "登录失败"}</span> : null}
					</span>
				</Row>
			) : null}

			<Row label="简介">
				{server.description ?? (
					<span className="side-panel-count">
						{t(
							"没写。这一句会进系统提示，帮模型知道该不该用这台服务器。",
							"Not set. This line goes into the system prompt so the model knows whether to use this server.",
						)}
					</span>
				)}
			</Row>

			{server.transport === "stdio" ? (
				<>
					<Row label="命令">
						<span className="mcp-value mono">{commandLine(server)}</span>
						<CopyButton text={commandLine(server)} className="btn btn-tiny" title={t("复制命令", "Copy command")} />
					</Row>
					{server.cwd ? <Row label="工作目录">{server.cwd}</Row> : null}
				</>
			) : (
				<Row label="地址">
					<span className="mcp-value mono">{server.url}</span>
					<CopyButton text={server.url ?? ""} className="btn btn-tiny" title={t("复制地址", "Copy URL")} />
				</Row>
			)}

			{Object.keys(server.env ?? {}).length > 0 ? (
				<Row label="环境变量">
					{Object.entries(server.env ?? {}).map(([key, value]) => (
						<span
							className="mcp-tool"
							key={`env-${key}`}
							title={isCommandValue(value) ? "整条值是一条命令：pi 会跑它，把 stdout 当值" : undefined}
						>
							{key}={value}
						</span>
					))}
				</Row>
			) : null}

			{Object.keys(server.headers ?? {}).length > 0 ? (
				<Row label="请求头">
					{Object.entries(server.headers ?? {}).map(([key, value]) => (
						<span className="mcp-tool" key={`header-${key}`}>
							{key}: {value}
						</span>
					))}
				</Row>
			) : null}

			{server.envRefs.length > 0 ? (
				<Row label="主机环境变量">
					<span className="side-panel-count">
						{server.transport === "http"
							? "请求头里的变量取自运行 Pi Web 的这台机器："
							: "启动它的命令会拿到运行 Pi Web 的这台机器上的变量："}
						{server.envRefs.map((ref) => (
							<span
								className={`mcp-ref${ref.present ? " mcp-ref-ok" : " mcp-ref-missing"}`}
								key={`${ref.key}-${ref.variable}`}
							>
								{ref.key} 里的 {ref.variable}
								{ref.present ? " 已设置" : " 未设置"}
							</span>
						))}
					</span>
				</Row>
			) : null}

			<Row label="工具">
				<select
					className="mcp-exposure"
					value={server.exposure}
					disabled={busy}
					onChange={(event) => onExposure(event.target.value as Exposure)}
				>
					{(Object.keys(EXPOSURE_LABEL) as Exposure[]).map((exposure) => (
						<option value={exposure} key={exposure}>
							{EXPOSURE_LABEL[exposure]}
						</option>
					))}
				</select>
				<span className="side-panel-count">{EXPOSURE_HINT[server.exposure]}</span>
				{server.toolExposure ? (
					<span className="side-panel-count">
						单个工具另有设置：
						{Object.entries(server.toolExposure).map(([tool, exposure]) => (
							<span className="mcp-ref" key={tool}>
								{tool} → {EXPOSURE_LABEL[exposure]}
							</span>
						))}
					</span>
				) : null}
			</Row>

			{probe?.ok && probe.tools.length > 0 ? (
				<Row label="工具清单">
					<div className="mcp-tools">
						{probe.tools.map((tool) => (
							<span className="mcp-tool" key={tool.name} title={tool.description}>
								{tool.name}
							</span>
						))}
					</div>
				</Row>
			) : null}

			{probe && !probe.ok && probe.stderr ? (
				<Row label="stderr">
					<pre className="mcp-stderr">{probe.stderr}</pre>
				</Row>
			) : null}

			<Row label="超时">
				<span className="side-panel-count">{server.timeout} 秒（配置里的 timeout；不写就是 60）</span>
			</Row>

			<Row label="文件">
				<span className="mcp-value mono">{server.source}</span>
				{server.override ? <span className="side-panel-count">{server.override} 里有本项目的覆盖项</span> : null}
			</Row>
		</div>
	);
}

function Row({ label, children }: { label: string; children: ReactNode }) {
	return (
		<div className="mcp-row">
			<span className="mcp-row-key">{label}</span>
			<span className="mcp-row-value">{children}</span>
		</div>
	);
}
