import { useCallback, useEffect, useRef, useState } from "react";
import { isModelEnabled } from "../model-enabled.ts";
import { setProviderEnabled } from "../ws.ts";
import { useT } from "../use-language.ts";

/**
 * 订阅服务（OAuth）里的一个 provider（服务端 `/api/subscriptions` 的一条）。
 * 对应 `server/engine/port.ts` 的 ProviderAuthEntry。
 */
export type SubscriptionEntry = {
	id: string;
	name: string;
	/** 引擎标注：走订阅额度，不是按 API key 计费 */
	subscription: boolean;
	connected: boolean;
	supportsApiKey: boolean;
	modelCount: number;
	models?: { id: string; name: string }[];
};

type Ask =
	| { kind: "text"; token: string; message: string; placeholder: string | null; secret: boolean }
	| { kind: "select"; token: string; message: string; options: { id: string; label: string; description?: string }[] };

/**
 * 连接一个订阅账号（右栏详情）。
 *
 * 流程（服务端 SSE，见 server/providers/subscription-routes.ts）：
 *   connecting → auth（授权链接）/ device（设备码） → ask（粘回调地址或验证码）→ success。
 * 关掉这条流 = 取消登录：浏览器断开，服务端 abort 掉引擎的 login。
 */
export function SubscriptionDetail({
	entry,
	onClose,
	onChanged,
	onImportModels,
	enabledModels = [],
	canTest = false,
}: {
	entry: SubscriptionEntry;
	onClose: () => void;
	/** 登录 / 登出成功：让上层重拉订阅列表与 provider 列表 */
	onChanged: () => void;
	/** 打开该订阅 provider 的远端模型导入面板（目前仅 Codex 支持） */
	onImportModels?: () => void;
	/**
	 * 启用白名单（pi settings.json 的 `enabledModels`）：勾选态的唯一来源。
	 * 空数组 = 全开（pi 的语义），与左栏开关、`model-enabled.ts` 的口径完全一致。
	 */
	enabledModels?: string[];
	/**
	 * 能不能测速：需要工作台里真有这个 provider 的配置（测速走 `/api/providers/:p/models/:id/test`，
	 * 订阅登录的 OAuth 凭据那条路会转给引擎自己的探测器，见 codex-test.ts）。
	 */
	canTest?: boolean;
}) {
	const t = useT();
	const [phase, setPhase] = useState<"idle" | "connecting" | "running" | "done" | "error">("idle");
	const [authUrl, setAuthUrl] = useState<{ url: string; instructions: string | null } | null>(null);
	const [device, setDevice] = useState<{ userCode: string; verificationUri: string; seconds: number | null } | null>(
		null,
	);
	const [ask, setAsk] = useState<Ask | null>(null);
	const [progress, setProgress] = useState<string | null>(null);
	const [error, setError] = useState<string | null>(null);
	const [value, setValue] = useState("");
	/** 正在把答复回给服务端（和流里的 progress 分开：两者会同时发生） */
	const [submitting, setSubmitting] = useState(false);
	/** 登出请求进行中 */
	const [busy, setBusy] = useState(false);
	/** 测速结果：modelId → 一行摘要（完整原因挂 title）；一次只测一个（并发只会打出 429） */
	const [probeResults, setProbeResults] = useState<Record<string, { ok: boolean; text: string; detail: string }>>({});
	const [probingModel, setProbingModel] = useState<string | null>(null);
	const [probeBatch, setProbeBatch] = useState<{ done: number; total: number } | null>(null);
	const probeAbort = useRef<AbortController | null>(null);
	const sourceRef = useRef<EventSource | null>(null);
	/** SSE 的 error 在正常收尾时也会触发，别把成功改写成失败 */
	const settledRef = useRef(false);

	const stop = useCallback(() => {
		sourceRef.current?.close();
		sourceRef.current = null;
	}, []);

	// 换 provider / 卸载：关掉流（= 取消登录）
	useEffect(() => {
		setPhase("idle");
		setAuthUrl(null);
		setDevice(null);
		setAsk(null);
		setProgress(null);
		setError(null);
		setValue("");
		settledRef.current = false;
		stop();
		// 换 provider：上一个订阅的测速结果 / 进度不能留在这一栏
		probeAbort.current?.abort();
		probeAbort.current = null;
		setProbeResults({});
		setProbingModel(null);
		setProbeBatch(null);
	}, [entry.id, stop]);

	useEffect(() => stop, [stop]);

	const submit = useCallback(
		async (token: string, code: string) => {
			if (code.trim() === "") return;
			setSubmitting(true);
			setError(null);
			try {
				const response = await fetch(`/api/subscriptions/${encodeURIComponent(entry.id)}/login`, {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ token, code: code.trim() }),
				});
				const body = (await response.json()) as { error?: { message?: string } };
				if (!response.ok) {
					setError(body.error?.message ?? `HTTP ${response.status}`);
					return;
				}
				// 只清掉刚回答的这一个提问：答复回得慢时，流的下一句提问可能已经到了
				setAsk((current) => (current && current.token === token ? null : current));
				setProgress(null);
				setValue("");
			} catch (cause) {
				setError(cause instanceof Error ? cause.message : String(cause));
			} finally {
				setSubmitting(false);
			}
		},
		[entry.id],
	);

	const start = useCallback(() => {
		stop();
		settledRef.current = false;
		setPhase("connecting");
		setAuthUrl(null);
		setDevice(null);
		setAsk(null);
		setProgress(null);
		setError(null);
		setValue("");

		const source = new EventSource(`/api/subscriptions/${encodeURIComponent(entry.id)}/login`);
		sourceRef.current = source;

		source.onmessage = (message) => {
			const data = JSON.parse(message.data) as {
				type: string;
				url?: string;
				instructions?: string | null;
				userCode?: string;
				verificationUri?: string;
				expiresInSeconds?: number | null;
				message?: string;
				placeholder?: string | null;
				secret?: boolean;
				token?: string;
				options?: { id: string; label: string; description?: string }[];
			};
			if (data.type === "auth") {
				setPhase("running");
				setAuthUrl({ url: data.url ?? "", instructions: data.instructions ?? null });
				// 浏览器就在这台机器上时自动打开授权页（远端/手机浏览器会失败，所以下面还留链接）
				if (data.url) window.open(data.url, "_blank", "noopener,noreferrer");
				return;
			}
			if (data.type === "device_code") {
				setPhase("running");
				setDevice({
					userCode: data.userCode ?? "",
					verificationUri: data.verificationUri ?? "",
					seconds: data.expiresInSeconds ?? null,
				});
				if (data.verificationUri) window.open(data.verificationUri, "_blank", "noopener,noreferrer");
				return;
			}
			if (data.type === "prompt_request" && data.token) {
				setPhase("running");
				setAsk({
					kind: "text",
					token: data.token,
					message: data.message ?? "",
					placeholder: data.placeholder ?? null,
					secret: data.secret === true,
				});
				return;
			}
			if (data.type === "select_request" && data.token) {
				setPhase("running");
				setAsk({ kind: "select", token: data.token, message: data.message ?? "", options: data.options ?? [] });
				return;
			}
			if (data.type === "progress") {
				setPhase("running");
				setProgress(data.message ?? null);
				return;
			}
			if (data.type === "info") {
				setProgress(data.message ?? null);
				return;
			}
			if (data.type === "success") {
				settledRef.current = true;
				source.close();
				sourceRef.current = null;
				setPhase("done");
				setProgress(null);
				setAsk(null);
				onChanged();
				return;
			}
			if (data.type === "error") {
				settledRef.current = true;
				source.close();
				sourceRef.current = null;
				setPhase("error");
				setProgress(null);
				setError(data.message ?? t("登录失败", "Sign-in failed"));
				return;
			}
			if (data.type === "cancelled") {
				settledRef.current = true;
				source.close();
				sourceRef.current = null;
				setPhase("idle");
				setProgress(null);
			}
		};

		source.onerror = () => {
			source.close();
			sourceRef.current = null;
			if (settledRef.current) return;
			setPhase("error");
			setProgress(null);
			setError(
				t(
					"和服务器的连接断了：重试一次（登录可能已经在中途被取消）",
					"Lost the connection to the server — try again (the sign-in may have been cancelled midway)",
				),
			);
		};
	}, [entry.id, onChanged, stop]);

	const logout = useCallback(async () => {
		setBusy(true);
		setError(null);
		try {
			const response = await fetch(`/api/subscriptions/${encodeURIComponent(entry.id)}/logout`, { method: "POST" });
			const body = (await response.json()) as { error?: { message?: string } };
			if (!response.ok) {
				setError(body.error?.message ?? `HTTP ${response.status}`);
				return;
			}
			setPhase("idle");
			onChanged();
		} catch (cause) {
			setError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setBusy(false);
		}
	}, [entry.id, onChanged]);

	const running = phase === "connecting" || phase === "running";
	const models = entry.models ?? [];
	const canFetch = entry.connected && onImportModels !== undefined;
	/** 勾选态就是「启用态」：写 pi 的 enabledModels，和左栏那个开关是同一份数据 */
	const modelOn = (id: string) => isModelEnabled(enabledModels, entry.id, id);
	const enabledIds = models.filter((model) => modelOn(model.id)).map((model) => model.id);
	const allOn = models.length > 0 && enabledIds.length === models.length;
	const noneOn = enabledIds.length === 0;

	/**
	 * 批量测速：逐个对勾选的模型发一次最小请求（顺序跑，避开 429）。
	 *
	 * 走 `/api/providers/:p/models/:id/test`：和非订阅 provider 的批量测速是同一条路由。
	 * 订阅登录存的是 OAuth access token（不是 api key），服务端会按凭据类型转给 Codex 探测器，
	 * 鉴权头由它负责（见 server/providers/import-routes.ts）。
	 * 语义上这是一次真实调用（会消耗订阅额度），所以调用方先让用户确认。
	 */
	const runTest = async (ids: string[]) => {
		// 用 ref 判「已经在跑了」：state 是异步的，连点两下可能两边都看到 probingModel === null
		if (ids.length === 0 || probeAbort.current !== null) return;
		const controller = new AbortController();
		probeAbort.current = controller;
		setProbeResults({});
		setProbeBatch({ done: 0, total: ids.length });
		let done = 0;
		for (const id of ids) {
			if (controller.signal.aborted) break;
			setProbingModel(id);
			let entryResult: { ok: boolean; text: string; detail: string };
			try {
				const response = await fetch(
					`/api/providers/${encodeURIComponent(entry.id)}/models/${encodeURIComponent(id)}/test`,
					{ method: "POST", signal: controller.signal },
				);
				const body = (await response.json()) as {
					ok?: boolean;
					latencyMs?: number;
					message?: string;
					error?: { message?: string };
				};
				// 引擎侧测出来的会多一段「首字 / 出字速度」；直连 HTTP 只有一个耗时
				const detail = body.ok
					? [body.latencyMs === undefined ? null : `${body.latencyMs}ms`, body.message ?? null]
							.filter((part): part is string => part !== null && part !== "")
							.join(" · ")
					: t(
							`失败：${body.message ?? body.error?.message ?? `HTTP ${response.status}`}`,
							`Failed: ${body.message ?? body.error?.message ?? `HTTP ${response.status}`}`,
						);
				entryResult = {
					ok: body.ok === true,
					text: detail.length > 42 ? `${detail.slice(0, 40)}…` : detail,
					detail,
				};
			} catch (cause) {
				// 用户主动停：不要记一个假的「失败」
				if (controller.signal.aborted) break;
				const detail = cause instanceof Error ? cause.message : String(cause);
				entryResult = { ok: false, text: detail.slice(0, 40), detail };
			}
			setProbeResults((results) => ({ ...results, [id]: entryResult }));
			done += 1;
			setProbeBatch({ done, total: ids.length });
		}
		setProbingModel(null);
		setProbeBatch(null);
		probeAbort.current = null;
	};

	return (
		<div className="side-panel subs-detail">
			<div className="side-panel-head">
				<strong>{entry.name}</strong>
				<span className="side-panel-count mono">{entry.id}</span>
				<span className="topbar-spacer" />
				{entry.connected ? (
					<span className="subs-state subs-state-on">{t("已连接", "Connected")}</span>
				) : (
					<span className="subs-state">{t("未连接", "Not connected")}</span>
				)}
				<button
					type="button"
					className="btn btn-tiny"
					onClick={onClose}
					title={t("回到 provider 列表", "Back to the provider list")}
				>
					✕
				</button>
			</div>

			<div className="side-panel-hint">
				{entry.subscription
					? t(
							"用你的订阅账号登录：额度算在订阅里，不按 API key 计费。凭据由引擎写进 ~/.pi/agent/auth.json。",
							"Sign in with your subscription: usage counts against the subscription, not an API key. The engine writes the credential to ~/.pi/agent/auth.json.",
						)
					: t(
							"用 OAuth 登录这个 provider（凭据由引擎写进 ~/.pi/agent/auth.json）。",
							"Sign in to this provider with OAuth (the engine writes the credential to ~/.pi/agent/auth.json).",
						)}
				<div>
					{t("当前", "Currently")} {entry.modelCount} {t("个模型。", "models.")}{" "}
					{entry.supportsApiKey
						? t(
								"它也支持 API key —— 那条路在左侧 provider 表单里。",
								"It also accepts an API key — that route lives in the provider form on the left.",
							)
						: ""}
				</div>
			</div>

			{authUrl ? (
				<div className="subs-block">
					<div className="side-panel-hint">
						{authUrl.instructions ?? t("在授权页完成登录。", "Finish signing in on the authorization page.")}
					</div>
					<a className="subs-link" href={authUrl.url} target="_blank" rel="noopener noreferrer">
						{t(
							"打开授权页（浏览器没自动弹出时点这里）",
							"Open the authorization page (click here if the browser did not open)",
						)}
					</a>
				</div>
			) : null}

			{device ? (
				<div className="subs-block">
					<div className="side-panel-hint">
						{t("在验证页输入下面这串码", "Enter this code on the verification page")}
						{device.seconds ? ` (${Math.round(device.seconds / 60)} ${t("分钟内有效", "min to enter")})` : ""}
						{t("：", ":")}
					</div>
					<div className="subs-code mono">{device.userCode}</div>
					<a className="subs-link" href={device.verificationUri} target="_blank" rel="noopener noreferrer">
						{device.verificationUri}
					</a>
				</div>
			) : null}

			{ask?.kind === "select" ? (
				<div className="subs-block">
					<div className="side-panel-hint">{ask.message}</div>
					<div className="subs-options">
						{ask.options.map((option) => (
							<button
								key={option.id}
								type="button"
								className="btn btn-tiny"
								disabled={submitting}
								title={option.description ?? option.id}
								onClick={() => void submit(ask.token, option.id)}
							>
								{option.label}
							</button>
						))}
					</div>
				</div>
			) : null}

			{ask?.kind === "text" ? (
				<div className="subs-block">
					<label className="side-field">
						<span>{ask.message}</span>
						<input
							type={ask.secret ? "password" : "text"}
							value={value}
							autoFocus
							autoComplete="off"
							placeholder={ask.placeholder ?? t("粘贴授权码或回调地址", "Paste the authorization code or callback URL")}
							onChange={(event) => setValue(event.target.value)}
							onKeyDown={(event) => {
								if (event.key === "Enter" && !event.nativeEvent.isComposing) void submit(ask.token, value);
							}}
						/>
					</label>
					<div className="subs-actions">
						<button
							type="button"
							className="btn btn-tiny btn-primary"
							disabled={submitting || value.trim() === ""}
							onClick={() => void submit(ask.token, value)}
						>
							{submitting ? t("校验中…", "Checking…") : t("提交", "Submit")}
						</button>
					</div>
				</div>
			) : null}

			{progress ? <div className="side-panel-hint">{progress}</div> : null}
			{error ? <div className="side-panel-hint side-error">{error}</div> : null}
			{phase === "done" ? (
				<div className="side-ok">
					{t(
						"已连接：模型表已重载，聊天里可以直接选它的模型了。",
						"Connected — the model list was reloaded; you can pick its models in the chat now.",
					)}
				</div>
			) : null}

			<div className="import-foot">
				{entry.connected ? (
					<>
						<button type="button" className="btn btn-tiny" onClick={start} disabled={busy || running}>
							{t("重新登录", "Sign in again")}
						</button>
						<span className="topbar-spacer" />
						<button type="button" className="btn btn-tiny btn-danger" onClick={() => void logout()} disabled={busy}>
							{t("退出登录", "Sign out")}
						</button>
					</>
				) : (
					<>
						<button type="button" className="btn btn-tiny btn-primary" onClick={start} disabled={running}>
							{running
								? t("登录中…", "Signing in…")
								: t(`连接 ${entry.name} 账号`, `Connect the ${entry.name} account`)}
						</button>
						<span className="topbar-spacer" />
						{running ? (
							<button
								type="button"
								className="btn btn-tiny"
								onClick={() => {
									stop();
									setPhase("idle");
									setAsk(null);
									setAuthUrl(null);
									setDevice(null);
									setProgress(null);
								}}
							>
								{t("取消", "Cancel")}
							</button>
						) : null}
					</>
				)}
			</div>

			{models.length > 0 || canFetch ? (
				<div className="side-field">
					<span className="prov-field-head">
						{t("模型（勾选的才启用）", "Models (only ticked ones are enabled)")}
						<span className="side-panel-count">
							{enabledIds.length}/{models.length}
						</span>
						<span className="prov-check-actions">
							<button
								type="button"
								className="msg-action"
								disabled={allOn}
								onClick={() => setProviderEnabled(entry.id, true)}
								title={t("全部启用（写进 pi 的 settings.json）", "Enable everything (written to pi's settings.json)")}
							>
								{t("全选", "Select all")}
							</button>
							<button
								type="button"
								className="msg-action"
								disabled={noneOn}
								onClick={() => setProviderEnabled(entry.id, false)}
								title={t("全部停用（对话里就选不到它们了）", "Disable everything (they disappear from the composer)")}
							>
								{t("全不选", "Select none")}
							</button>
						</span>
						{canTest ? (
							<button
								type="button"
								className="btn btn-tiny"
								style={{ marginLeft: "auto" }}
								disabled={probingModel !== null || enabledIds.length === 0}
								title={
									enabledIds.length === 0
										? t("先勾选要测的模型", "Tick the models you want to test first")
										: t(
												`对勾选的 ${enabledIds.length} 个模型各发一次真实请求（消耗少量订阅额度），测首字延迟与出字速度`,
												`Sends one real request for each of the ${enabledIds.length} ticked models (spends a little subscription quota) and measures time-to-first-token and tokens/s`,
											)
								}
								onClick={() => {
									const ids = enabledIds.slice();
									if (
										!window.confirm(
											t(
												`会对 ${ids.length} 个模型各发一次真实请求（消耗少量额度），继续？`,
												`This sends one real request per model (${ids.length} total) and spends a little quota. Continue?`,
											),
										)
									)
										return;
									void runTest(ids);
								}}
							>
								{probeBatch
									? t(
											`测速中… ${probeBatch.done}/${probeBatch.total}`,
											`Testing… ${probeBatch.done}/${probeBatch.total}`,
										)
									: t("⏱ 批量测速", "⏱ Test speed")}
							</button>
						) : null}
						{probeBatch ? (
							<button
								type="button"
								className="btn btn-tiny btn-danger"
								style={{ marginLeft: canTest ? 0 : "auto" }}
								title={t("停止测速，已测出的结果会保留", "Stop testing and keep the results already measured")}
								onClick={() => probeAbort.current?.abort()}
							>
								■ {t("停止", "Stop")}
							</button>
						) : null}
						{canFetch ? (
							<button
								type="button"
								className="btn btn-tiny"
								style={{ marginLeft: canTest ? 0 : "auto" }}
								onClick={onImportModels}
								disabled={busy || running}
								title={t(
									"从订阅拉取可用模型，再勾选要启用的",
									"Fetch available models from the subscription, then tick the ones to enable",
								)}
							>
								⬇️ {t("从订阅获取模型", "Fetch models from subscription")}
							</button>
						) : null}
					</span>
					{models.length === 0 ? (
						<div className="side-panel-hint">
							{t(
								"还没有导入模型：点「从订阅获取模型」",
								"No models imported yet — click “Fetch models from subscription”",
							)}
						</div>
					) : (
						<div className="prov-checklist">
							{models.map((model) => {
								const on = modelOn(model.id);
								return (
									<div className={`prov-check-row${on ? " prov-check-on" : ""}`} key={model.id}>
										<label
											className="prov-check-label"
											title={
												on
													? t(
															"已启用：点击停用（写进 pi 的 settings.json）",
															"Enabled — click to disable (written to pi's settings.json)",
														)
													: t("未启用：点击启用", "Disabled — click to enable")
											}
										>
											<input
												type="checkbox"
												checked={on}
												onChange={() => setProviderEnabled(entry.id, !on, model.id)}
											/>
											<span className="mono">{model.id}</span>
										</label>
										<ProbeCell result={probeResults[model.id]} busy={probingModel === model.id} />
									</div>
								);
							})}
						</div>
					)}
				</div>
			) : null}
		</div>
	);
}

/** 测速结果：一行耗时/失败原因（完整文本挂 title，单元格窄所以先截一截） */
function ProbeCell({ result, busy }: { result?: { ok: boolean; text: string; detail: string }; busy: boolean }) {
	const t = useT();
	if (busy) return <span className="prov-latency prov-latency-idle">{t("测速中…", "Testing…")}</span>;
	if (!result) return null;
	return (
		<span
			className={`prov-latency prov-check-latency${result.ok ? " prov-latency-ok" : " prov-latency-fail"}`}
			title={result.detail}
		>
			{result.text}
		</span>
	);
}
