import type { ReactNode } from "react";
import { CopyButton } from "./CopyButton.tsx";
import {
	EXPOSURE_HINT,
	EXPOSURE_HINT_EN,
	EXPOSURE_LABEL,
	EXPOSURE_LABEL_EN,
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
			? t(
					`连接成功 · ${probe.tools.length} 个工具 · ${probe.ms}ms`,
					`Connected · ${probe.tools.length} tools · ${probe.ms}ms`,
				)
			: t(`连接失败 · ${probe.error ?? "未知错误"}`, `Failed · ${probe.error ?? "unknown error"}`)
		: t("还没测过", "Not tested yet");
	return (
		<div className="mcp-body">
			<Row label={t("状态", "Status")}>
				<span className={server.enabled ? "mcp-state-on" : "mcp-state-off"}>
					{server.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}
				</span>
				<span className={probe && !probe.ok ? "side-error" : "side-panel-count"}> · {probeText}</span>
			</Row>

			{authFailed || (server.transport === "http" && (server.auth !== undefined || login !== undefined)) ? (
				<Row label={t("授权", "Authorization")}>
					<span className="mcp-auth">
						{login?.status === "waiting" ? (
							<>
								<span className="side-panel-count">
									{t("在浏览器里完成授权", "Finish authorization in the browser")}
									{login.url === undefined
										? t("（正在准备授权页…）", " (preparing the authorization page…)")
										: t("，完成后回来点「我已授权」", ", then come back and click “I've authorized”")}
									{t("：", ":")}
								</span>
								{login.url !== undefined ? (
									<a className="mcp-catalog-link mcp-auth-url mono" href={login.url} target="_blank" rel="noreferrer">
										{t("打开授权页 ↗", "Open the authorization page ↗")}
									</a>
								) : null}
								<button type="button" className="btn btn-tiny" onClick={onRecheck}>
									{t("我已授权，重测", "I've authorized — retest")}
								</button>
								<button type="button" className="btn btn-tiny" onClick={onLoginCancel}>
									{t("取消", "Cancel")}
								</button>
							</>
						) : server.auth?.present && server.auth.expired ? (
							<>
								<span className="side-panel-count">
									{t(
										"存过凭据但已过期（pi 会在真正调用时用 refresh token 续期；连不上就重新登录一次）",
										"Credentials saved but expired (pi renews them with the refresh token on real calls; sign in again if it cannot connect)",
									)}
								</span>
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={onLogin}>
									{t("重新登录", "Sign in again")}
								</button>
							</>
						) : server.auth?.present ? (
							<>
								<span className="mcp-auth-ok">
									{t("已登录", "Signed in")}
									{server.auth.scope ? ` (${server.auth.scope})` : ""}
								</span>
								<button type="button" className="btn btn-tiny" disabled={busy} onClick={onLogin}>
									{t("重新登录", "Sign in again")}
								</button>
							</>
						) : (
							<>
								<span className="side-panel-count">
									{t(
										"这台是远程 HTTP 服务器，要 OAuth 授权才能用（对面回了 401 / requires authentication）。 登录用 pi 自己的",
										"This is a remote HTTP server; it needs OAuth authorization (the other side returned 401 / requires authentication). Sign in with pi's own",
									)}{" "}
									<code>pi mcp login</code> {t("流程，凭据写进")} <code>mcp-auth.json</code>
									{t("，会话也跟着用。", ", and sessions use them too.")}
								</span>
								<button type="button" className="btn btn-tiny btn-primary-add" disabled={busy} onClick={onLogin}>
									{busy ? t("准备中…", "Preparing…") : t("登录", "Sign in")}
								</button>
							</>
						)}
						{login?.status === "failed" ? (
							<span className="side-error">{login.message ?? t("登录失败", "Sign-in failed")}</span>
						) : null}
					</span>
				</Row>
			) : null}

			<Row label={t("简介", "About")}>
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
					<Row label={t("命令", "Command")}>
						<span className="mcp-value mono">{commandLine(server)}</span>
						<CopyButton text={commandLine(server)} className="btn btn-tiny" title={t("复制命令", "Copy command")} />
					</Row>
					{server.cwd ? <Row label={t("工作目录", "Working directory")}>{server.cwd}</Row> : null}
				</>
			) : (
				<Row label={t("地址", "URL")}>
					<span className="mcp-value mono">{server.url}</span>
					<CopyButton text={server.url ?? ""} className="btn btn-tiny" title={t("复制地址", "Copy URL")} />
				</Row>
			)}

			{Object.keys(server.env ?? {}).length > 0 ? (
				<Row label={t("环境变量", "Environment")}>
					{Object.entries(server.env ?? {}).map(([key, value]) => (
						<span
							className="mcp-tool"
							key={`env-${key}`}
							title={
								isCommandValue(value)
									? t(
											"整条值是一条命令：pi 会跑它，把 stdout 当值",
											"The whole value is a command: pi runs it and uses stdout as the value",
										)
									: undefined
							}
						>
							{key}={value}
						</span>
					))}
				</Row>
			) : null}

			{Object.keys(server.headers ?? {}).length > 0 ? (
				<Row label={t("请求头", "Headers")}>
					{Object.entries(server.headers ?? {}).map(([key, value]) => (
						<span className="mcp-tool" key={`header-${key}`}>
							{key}: {value}
						</span>
					))}
				</Row>
			) : null}

			{server.envRefs.length > 0 ? (
				<Row label={t("主机环境变量", "Host environment")}>
					<span className="side-panel-count">
						{server.transport === "http"
							? t(
									"请求头里的变量取自运行 Pi Web 的这台机器：",
									"Header values are read from the machine running Pi Web:",
								)
							: t(
									"启动它的命令会拿到运行 Pi Web 的这台机器上的变量：",
									"The launch command gets the variables of the machine running Pi Web:",
								)}
						{server.envRefs.map((ref) => (
							<span
								className={`mcp-ref${ref.present ? " mcp-ref-ok" : " mcp-ref-missing"}`}
								key={`${ref.key}-${ref.variable}`}
							>
								{t(`${ref.key} 里的 ${ref.variable}`, `${ref.variable} on ${ref.key}`)}
								{ref.present ? t(" 已设置", " set") : t(" 未设置", " not set")}
							</span>
						))}
					</span>
				</Row>
			) : null}

			<Row label={t("工具", "Tools")}>
				<select
					className="mcp-exposure"
					value={server.exposure}
					disabled={busy}
					onChange={(event) => onExposure(event.target.value as Exposure)}
				>
					{(Object.keys(EXPOSURE_LABEL) as Exposure[]).map((exposure) => (
						<option value={exposure} key={exposure}>
							{t(EXPOSURE_LABEL[exposure], EXPOSURE_LABEL_EN[exposure])}
						</option>
					))}
				</select>
				<span className="side-panel-count">{t(EXPOSURE_HINT[server.exposure], EXPOSURE_HINT_EN[server.exposure])}</span>
				{server.toolExposure ? (
					<span className="side-panel-count">
						{t("单个工具另有设置：", "Per-tool overrides:")}
						{Object.entries(server.toolExposure).map(([tool, exposure]) => (
							<span className="mcp-ref" key={tool}>
								{tool} → {t(EXPOSURE_LABEL[exposure], EXPOSURE_LABEL_EN[exposure])}
							</span>
						))}
					</span>
				) : null}
			</Row>

			{probe?.ok && probe.tools.length > 0 ? (
				<Row label={t("工具清单", "Tools found")}>
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

			<Row label={t("超时", "Timeout")}>
				<span className="side-panel-count">
					{t(
						`${server.timeout} 秒（配置里的 timeout；不写就是 60）`,
						`${server.timeout}s (timeout from the config; 60 if unset)`,
					)}
				</span>
			</Row>

			<Row label={t("文件", "File")}>
				<span className="mcp-value mono">{server.source}</span>
				{server.override ? (
					<span className="side-panel-count">
						{t(`${server.override} 里有本项目的覆盖项`, `${server.override} has overrides for this project`)}
					</span>
				) : null}
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
