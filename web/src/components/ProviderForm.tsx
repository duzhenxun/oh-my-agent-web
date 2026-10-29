import { useEffect, useImperativeHandle, useRef, useState, type Ref } from "react";
import type { ProviderView } from "../types.ts";
import { upsertProvider } from "../ws.ts";
import { useT } from "../use-language.ts";

export type ProviderFormHandle = { save: () => void };

/**
 * 「添加模型」表单（ADR-0025 A 期）：
 *   - api key 是**只能填、不能读**的字段：留空表示不修改已有 key；
 *   - 服务端保存后回一份不含明文 key 的视图（只有 hasKey + 尾 4 位）。
 */
export function ProviderForm({
	initial,
	onSaved,
	formRef,
}: {
	initial?: ProviderView | null;
	/** 保存成功后回传 provider 名（上层用它选中刚存的那个） */
	onSaved?: (provider: string) => void;
	/** 顶部栏的保存按钮通过这个句柄触发表单提交 */
	formRef?: Ref<ProviderFormHandle>;
}) {
	const [provider, setProvider] = useState(initial?.provider ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [api, setApi] = useState(initial?.api || "openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [headersText, setHeadersText] = useState("");
	/** 模型列表：一行一个，勾上才保存（不再用空格分隔的文本框） */
	const [modelRows, setModelRows] = useState<{ id: string; on: boolean }[]>(
		(initial?.models ?? []).map((model) => ({ id: model.id, on: true })),
	);
	const [manualId, setManualId] = useState("");
	/**
	 * 「只填一把 key」的引擎内置 provider（xAI / Cerebras / Fireworks…）：
	 * 模型表由引擎自己的目录提供，这里不该出现 base url / api / 模型勾选那一堆 ——
	 * 让用户填这些等于让他替 pi 抄目录，填错还会把内置 provider 配坏。
	 */
	const keyOnly = (initial?.models.length ?? 0) === 0 && (initial?.modelCount ?? 0) > 0;
	const t = useT();
	const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchedCount, setFetchedCount] = useState(0);
	/** 批量测速结果：modelId → 耗时 / 失败原因 */
	const [latency, setLatency] = useState<Record<string, { ok: boolean; text: string }>>({});
	const [batchBusy, setBatchBusy] = useState(false);
	const [batchDone, setBatchDone] = useState(0);
	const [batchTotal, setBatchTotal] = useState(0);
	const batchAbort = useRef<AbortController | null>(null);

	// 表单关闭 / provider 切走时别让循环接着打请求。
	useEffect(() => () => batchAbort.current?.abort(), []);

	/**
	 * 从厂家接口拉模型清单，填进「模型 id」。
	 * **手动触发**：不自动联网（离线可用 + 不给后台偷偷发请求）。
	 */
	const fetchModelIds = async () => {
		setFetching(true);
		setFetchError(null);
		try {
			const response = await fetch("/api/providers/remote-models", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider,
					baseUrl,
					api,
					...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
				}),
			});
			const body = (await response.json()) as { models?: { id: string }[]; error?: { message?: string } };
			const ids = (body.models ?? []).map((model) => model.id);
			if (!response.ok || ids.length === 0) {
				setFetchError(
					body.error?.message ?? t("这个地址没有返回可用的模型", "This endpoint returned no usable models"),
				);
				return;
			}
			setModelRows((current) => {
				const known = new Set(current.map((row) => row.id));
				// 已有的保持原样；新拉到的默认**不勾**（要用户自己确认哪些进 pi）
				return [...current, ...ids.filter((id) => !known.has(id)).map((id) => ({ id, on: false }))];
			});
			setFetchedCount(ids.length);
			setMessage({
				kind: "ok",
				text: t(
					`已获取 ${ids.length} 个模型：勾选要用的，再保存`,
					`Fetched ${ids.length} models — tick the ones you need, then save`,
				),
			});
		} catch (cause) {
			setFetchError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setFetching(false);
		}
	};

	const modelIds = modelRows.filter((row) => row.on).map((row) => row.id);

	/**
	 * 逐个测速：顺序发最小请求，避免并发把网关打出 429。
	 * 只测当前勾选的模型；停止时已经测出的结果保留。
	 */
	const runBatchTest = async () => {
		const providerId = initial?.provider;
		const ids = modelIds.slice();
		if (!providerId || ids.length === 0 || batchAbort.current) return;
		const controller = new AbortController();
		batchAbort.current = controller;
		setBatchBusy(true);
		setBatchDone(0);
		setBatchTotal(ids.length);
		setLatency({});
		let done = 0;
		for (const id of ids) {
			if (controller.signal.aborted) break;
			try {
				const response = await fetch(
					`/api/providers/${encodeURIComponent(providerId)}/models/${encodeURIComponent(id)}/test`,
					{ method: "POST", signal: controller.signal },
				);
				const body = (await response.json()) as {
					ok?: boolean;
					latencyMs?: number;
					message?: string;
					error?: { message?: string };
				};
				setLatency((current) => ({
					...current,
					[id]: body.ok
						? { ok: true, text: `${body.latencyMs ?? "?"}ms` }
						: {
								ok: false,
								text: t(
									`失败 ${body.message ?? body.error?.message ?? `HTTP ${response.status}`}`,
									`Failed: ${body.message ?? body.error?.message ?? `HTTP ${response.status}`}`,
								).trim(),
							},
				}));
			} catch (cause) {
				// 用户主动停：不要记一个假的「失败」。
				if (controller.signal.aborted) break;
				setLatency((current) => ({
					...current,
					[id]: { ok: false, text: cause instanceof Error ? cause.message : t("失败", "Failed") },
				}));
			}
			done += 1;
			setBatchDone(done);
		}
		batchAbort.current = null;
		setBatchBusy(false);
	};
	const toggleRow = (id: string, on: boolean) =>
		setModelRows((current) => current.map((row) => (row.id === id ? { ...row, on } : row)));
	const removeRow = (id: string) => setModelRows((current) => current.filter((row) => row.id !== id));
	const setAll = (on: boolean) => setModelRows((current) => current.map((row) => ({ ...row, on })));
	const addManual = () => {
		const id = manualId.trim();
		if (id === "" || modelRows.some((row) => row.id === id)) {
			setManualId("");
			return;
		}
		setModelRows((current) => [...current, { id, on: true }]);
		setManualId("");
	};

	const headers = Object.fromEntries(
		headersText
			.split(/\r?\n/) // 多行输入框：Windows 换行会带 \r
			.map((line) => line.split(/:(.*)/s))
			.filter(([name, value]) => Boolean(name?.trim() && value?.trim()))
			.map(([name, value]) => [name.trim(), value.trim()]),
	);

	const payload = () => ({
		provider,
		// 改名时告诉服务端原来的名字，它会把旧条目搬过去（否则会变成「新建一个」）
		...(initial && initial.provider !== provider.trim() ? { previousProvider: initial.provider } : {}),
		baseUrl,
		api,
		...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		models: modelIds.map((id) => ({ id })),
	});

	const submit = () => {
		upsertProvider(payload());
		onSaved?.(provider.trim());
		// 校验与写盘都在服务端；结果用提示条回传（前端没有 request/response 配对机制）
		setMessage({
			kind: "ok",
			text: t("已提交，结果会以提示形式出现在对话区", "Submitted — the result appears as a notice in the conversation"),
		});
		setApiKey("");
	};

	useImperativeHandle(formRef, () => ({ save: submit }));

	return (
		<div className="side-panel">
			<label className="side-field">
				<span>
					{t("provider（小写，作为 provider/model 前缀）", "provider (lowercase; used as the provider/model prefix)")}
				</span>
				<input value={provider} onChange={(event) => setProvider(event.target.value)} placeholder="my-endpoint" />
			</label>
			<label className="side-field">
				<span>base url</span>
				<input
					value={baseUrl}
					onChange={(event) => setBaseUrl(event.target.value)}
					placeholder="https://api.example.com/v1"
				/>
			</label>
			<label className="side-field">
				<span>{t("api 形态", "API shape")}</span>
				<select value={api} onChange={(event) => setApi(event.target.value)}>
					<option value="openai-completions">openai-completions</option>
					<option value="openai-responses">openai-responses</option>
					<option value="anthropic-messages">anthropic-messages</option>
					<option value="openai-codex-responses">openai-codex-responses</option>
					<option value="typesafe-system-one">typesafe-system-one</option>
				</select>
			</label>
			<label className="side-field">
				<span>
					API Key（
					{initial?.hasKey
						? t(
								`已有 ${initial.keyHint ?? ""}，留空即不修改`,
								`Saved ${initial.keyHint ?? ""} — leave empty to keep it`,
							)
						: initial?.credential === "oauth"
							? t(
									`已用订阅登录${initial.oauth?.accountHint ? `（账号 ${initial.oauth.accountHint}）` : ""}，留空即继续用订阅额度`,
									`Signed in${initial.oauth?.accountHint ? ` (${initial.oauth.accountHint})` : ""} — leave empty to keep using subscription quota`,
								)
							: keyOnly
								? t("填一把就能用", "just add a key")
								: t("新增 provider 必填", "required for a new provider")}
					）
				</span>
				<input
					type="password"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="sk-…"
					autoComplete="off"
				/>
			</label>
			<label className="side-field">
				<span>{t("自定义 Headers（每行 Name: Value）", "Custom headers (one Name: Value per line)")}</span>
				<textarea
					rows={3}
					value={headersText}
					onChange={(event) => setHeadersText(event.target.value)}
					placeholder={
						initial?.headerNames?.length
							? t(
									`已有：${initial.headerNames.join(", ")}；留空保持不变`,
									`Saved: ${initial.headerNames.join(", ")} — leave empty to keep`,
								)
							: "X-Client: agent-web"
					}
				/>
			</label>
			<div className="side-field">
				<span className="prov-field-head">
					{t("模型（勾选的才保存）", "Models (only ticked ones are saved)")}
					<span className="side-panel-count">
						{modelIds.length}/{modelRows.length}
					</span>
					<span className="prov-check-actions">
						<button
							type="button"
							className="msg-action"
							onClick={() => setAll(true)}
							disabled={modelRows.every((row) => row.on)}
							title={t("全部勾上（保存时全部写进 provider）", "Tick everything (all get written to the provider)")}
						>
							{t("全选", "Select all")}
						</button>
						<button
							type="button"
							className="msg-action"
							onClick={() => setAll(false)}
							disabled={modelRows.every((row) => !row.on)}
							title={t("全部不勾（保存时一个模型都不写）", "Tick nothing (no model is written)")}
						>
							{t("全不选", "Select none")}
						</button>
					</span>
					<button
						type="button"
						className="btn btn-tiny"
						style={{ marginLeft: "auto" }}
						onClick={() => void runBatchTest()}
						disabled={!initial || batchBusy || modelIds.length === 0}
						title={
							!initial
								? t("先保存 provider，再用已保存的配置测速", "Save the provider first, then test with its saved config")
								: batchBusy
									? t("正在逐个测速", "Testing models")
									: t(
											"逐个测试勾选的模型，每个模型会发一次最小请求",
											"Tests each ticked model with one minimal request",
										)
						}
					>
						{batchBusy ? t("测速中…", "Testing…") : t("⏱ 批量测速", "⏱ Test speed")}
					</button>
					{batchBusy ? (
						<button
							type="button"
							className="btn btn-tiny btn-danger"
							onClick={() => batchAbort.current?.abort()}
							title={t("停止测速，已测出的结果会保留", "Stop testing and keep the results already measured")}
						>
							■ {t("停止", "Stop")} {batchDone}/{batchTotal}
						</button>
					) : null}
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void fetchModelIds()}
						disabled={fetching || baseUrl.trim() === ""}
						title={t(
							"调一次 GET /models 把可用模型拉回来，勾选要用的那些",
							"Call GET /models to fetch the available models, then tick the ones you need",
						)}
					>
						{fetching ? t("获取中…", "Fetching…") : t("⬇️ 从 API 获取", "⬇️ Fetch from API")}
					</button>
				</span>

				{modelRows.length === 0 ? (
					<div className="side-panel-hint">
						{t(
							"还没有模型：点「从 API 获取」，或在下面手填一个 id",
							"No models yet — fetch from the API, or add an id by hand below",
						)}
					</div>
				) : (
					<div className="prov-checklist">
						{modelRows.map((row) => (
							<div className={`prov-check-row${row.on ? " prov-check-on" : ""}`} key={row.id}>
								<label className="prov-check-label">
									<input
										type="checkbox"
										checked={row.on}
										onChange={(event) => toggleRow(row.id, event.target.checked)}
									/>
									<span className="mono">{row.id}</span>
								</label>
								<LatencyCell result={latency[row.id]} />
								<button
									type="button"
									className="msg-action"
									title={t("从列表里删掉这一行", "Remove this row")}
									onClick={() => removeRow(row.id)}
								>
									{t("移除", "Remove")}
								</button>
							</div>
						))}
					</div>
				)}

				<div className="prov-add-row">
					<input
						value={manualId}
						onChange={(event) => setManualId(event.target.value)}
						onKeyDown={(event) => {
							if (event.key === "Enter") addManual();
						}}
						placeholder={t("手动加一个模型 id，回车添加", "Add a model id by hand, press Enter")}
					/>
					<button type="button" className="btn btn-tiny" onClick={addManual} disabled={manualId.trim() === ""}>
						{t("添加", "Add")}
					</button>
				</div>
			</div>
			{fetchError ? (
				<div className="side-panel-hint side-error">
					{t("获取失败：", "Fetch failed: ")}
					{fetchError}
				</div>
			) : null}
			{fetchedCount > 0 ? (
				<div className="side-panel-hint">
					{t("已从接口取回", "Fetched")} {fetchedCount}{" "}
					{t("个模型：勾上要用的，再保存", "models — tick the ones you need, then save")}
				</div>
			) : null}
			{message ? (
				<div className={message.kind === "ok" ? "side-ok" : "side-panel-hint side-error"}>{message.text}</div>
			) : null}
		</div>
	);
}

/** 批量测速结果：每个勾选模型旁边显示耗时或失败原因。 */
function LatencyCell({ result }: { result?: { ok: boolean; text: string } }) {
	if (!result) return null;
	return (
		<span
			className={`prov-latency prov-check-latency${result.ok ? " prov-latency-ok" : " prov-latency-fail"}`}
			title={result.text}
		>
			{result.text}
		</span>
	);
}
