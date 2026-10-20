import { useState } from "react";
import type { ProviderView } from "../types.ts";
import { upsertProvider } from "../ws.ts";

/**
 * 「添加模型」表单（ADR-0025 A 期）：
 *   - api key 是**只能填、不能读**的字段：留空表示不修改已有 key；
 *   - 服务端保存后回一份不含明文 key 的视图（只有 hasKey + 尾 4 位）。
 */
export function ProviderForm({
	initial,
	onClose,
	onSaved,
}: {
	initial?: ProviderView | null;
	onClose: () => void;
	/** 保存成功后回传 provider 名（上层用它选中刚存的那个） */
	onSaved?: (provider: string) => void;
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
	const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [verifying, setVerifying] = useState(false);
	const [fetching, setFetching] = useState(false);
	const [fetchError, setFetchError] = useState<string | null>(null);
	const [fetchedCount, setFetchedCount] = useState(0);

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
				setFetchError(body.error?.message ?? "这个地址没有返回可用的模型");
				return;
			}
			setModelRows((current) => {
				const known = new Set(current.map((row) => row.id));
				// 已有的保持原样；新拉到的默认**不勾**（要用户自己确认哪些进 pi）
				return [...current, ...ids.filter((id) => !known.has(id)).map((id) => ({ id, on: false }))];
			});
			setFetchedCount(ids.length);
			setMessage({ kind: "ok", text: `已获取 ${ids.length} 个模型：勾选要用的，再保存` });
		} catch (cause) {
			setFetchError(cause instanceof Error ? cause.message : String(cause));
		} finally {
			setFetching(false);
		}
	};

	const modelIds = modelRows.filter((row) => row.on).map((row) => row.id);
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
			.split("\n")
			.map((line) => line.split(/:(.*)/s))
			.filter(([name, value]) => Boolean(name?.trim() && value?.trim()))
			.map(([name, value]) => [name.trim(), value.trim()]),
	);

	const payload = () => ({
		provider,
		baseUrl,
		api,
		...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
		...(Object.keys(headers).length > 0 ? { headers } : {}),
		models: modelIds.map((id) => ({ id })),
	});

	/** 先试再存：地址/key/协议不对时**不写盘**，避免把坏配置写进 models-store */
	const verifyAndSubmit = async () => {
		setVerifying(true);
		setMessage(null);
		try {
			const response = await fetch("/api/providers/verify", {
				method: "POST",
				headers: { "content-type": "application/json" },
				body: JSON.stringify({
					provider,
					baseUrl,
					api,
					...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
					...(Object.keys(headers).length > 0 ? { headers } : {}),
					...(modelIds[0] ? { modelId: modelIds[0] } : {}),
				}),
			});
			const body = (await response.json()) as {
				ok?: boolean;
				step?: string;
				message?: string;
				latencyMs?: number;
				modelLatencyMs?: number;
				error?: { message?: string };
			};
			if (!response.ok || !body.ok) {
				setMessage({
					kind: "error",
					text: `没通过（${body.step === "chat" ? "模型对话" : "模型列表"}）：${body.message ?? body.error?.message ?? `HTTP ${response.status}`}`,
				});
				return;
			}
			upsertProvider(payload());
			onSaved?.(provider.trim());
			setMessage({
				kind: "ok",
				text: `验证通过（列表 ${body.latencyMs ?? "-"}ms${body.modelLatencyMs ? `，模型 ${body.modelLatencyMs}ms` : ""}），已保存`,
			});
			setApiKey("");
		} catch (cause) {
			setMessage({ kind: "error", text: cause instanceof Error ? cause.message : String(cause) });
		} finally {
			setVerifying(false);
		}
	};

	const submit = () => {
		upsertProvider(payload());
		onSaved?.(provider.trim());
		// 校验与写盘都在服务端；结果用提示条回传（前端没有 request/response 配对机制）
		setMessage({ kind: "ok", text: "已提交，结果会以提示形式出现在对话区" });
		setApiKey("");
	};

	return (
		<div className="side-panel">
			<div className="side-panel-head">
				<strong>{initial ? "编辑 provider" : "添加模型"}</strong>
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					关闭
				</button>
			</div>
			<label className="side-field">
				<span>provider（小写，作为 provider/model 前缀）</span>
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
				<span>api 形态</span>
				<select value={api} onChange={(event) => setApi(event.target.value)}>
					<option value="openai-completions">openai-completions</option>
					<option value="openai-responses">openai-responses</option>
					<option value="anthropic-messages">anthropic-messages</option>
					<option value="openai-codex-responses">openai-codex-responses</option>
					<option value="typesafe-system-one">typesafe-system-one</option>
				</select>
			</label>
			<label className="side-field">
				<span>API Key（{initial?.hasKey ? `已有 ${initial.keyHint ?? ""}，留空即不修改` : "新增 provider 必填"}）</span>
				<input
					type="password"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="sk-…"
					autoComplete="off"
				/>
			</label>
			<label className="side-field">
				<span>自定义 Headers（每行 Name: Value）</span>
				<textarea
					rows={3}
					value={headersText}
					onChange={(event) => setHeadersText(event.target.value)}
					placeholder={
						initial?.headerNames?.length
							? `已有：${initial.headerNames.join(", ")}；留空保持不变`
							: "X-Client: agent-web"
					}
				/>
			</label>
			<div className="side-field">
				<span className="prov-field-head">
					模型（勾选的才保存）
					<span className="side-panel-count">
						{modelIds.length}/{modelRows.length}
					</span>
					<span className="prov-check-actions">
						<button
							type="button"
							className="msg-action"
							onClick={() => setAll(true)}
							disabled={modelRows.every((row) => row.on) || modelRows.length === 0}
							title="全部勾上（保存时全部写进 provider）"
						>
							全选
						</button>
						<button
							type="button"
							className="msg-action"
							onClick={() => setAll(false)}
							disabled={modelRows.every((row) => !row.on) || modelRows.length === 0}
							title="全部不勾（保存时一个模型都不写）"
						>
							全不选
						</button>
					</span>
					<button
						type="button"
						className="btn btn-tiny"
						style={{ marginLeft: "auto" }}
						onClick={() => void fetchModelIds()}
						disabled={fetching || baseUrl.trim() === ""}
						title="调一次 GET {baseUrl}/models 把可用模型拉回来，勾选要用的那些"
					>
						{fetching ? "获取中…" : "⬇️ 从 API 获取"}
					</button>
				</span>

				{modelRows.length === 0 ? (
					<div className="side-panel-hint">还没有模型：点「从 API 获取」，或在下面手填一个 id</div>
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
								<button
									type="button"
									className="msg-action"
									title="从列表里删掉这一行"
									onClick={() => removeRow(row.id)}
								>
									移除
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
						placeholder="手动加一个模型 id，回车添加"
					/>
					<button type="button" className="btn btn-tiny" onClick={addManual} disabled={manualId.trim() === ""}>
						添加
					</button>
				</div>
			</div>
			{fetchError ? <div className="side-panel-hint side-error">获取失败：{fetchError}</div> : null}
			{fetchedCount > 0 ? (
				<div className="side-panel-hint">已从接口取回 {fetchedCount} 个模型：勾上要用的，再保存</div>
			) : null}
			{message ? (
				<div className={message.kind === "ok" ? "side-ok" : "side-panel-hint side-error"}>{message.text}</div>
			) : null}
			<div className="import-foot">
				<button
					type="button"
					className="btn btn-tiny btn-primary"
					title="先拉一次 /models（不花钱），再用第一个模型发一次最小请求（会消耗一次请求）验证协议"
					onClick={() => void verifyAndSubmit()}
					disabled={verifying}
				>
					{verifying ? "验证中…" : "测试并保存"}
				</button>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" onClick={submit} disabled={verifying}>
					直接保存
				</button>
			</div>
		</div>
	);
}
