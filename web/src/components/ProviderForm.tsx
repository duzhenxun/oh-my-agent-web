import { useState } from "react";
import type { ProviderView } from "../types.ts";
import { upsertProvider } from "../ws.ts";

/**
 * 「添加模型」表单（ADR-0025 A 期）：
 *   - api key 是**只能填、不能读**的字段：留空表示不修改已有 key；
 *   - 服务端保存后回一份不含明文 key 的视图（只有 hasKey + 尾 4 位）。
 */
export function ProviderForm({ initial, onClose }: { initial?: ProviderView | null; onClose: () => void }) {
	const [provider, setProvider] = useState(initial?.provider ?? "");
	const [baseUrl, setBaseUrl] = useState(initial?.baseUrl ?? "");
	const [api, setApi] = useState(initial?.api || "openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [headersText, setHeadersText] = useState("");
	const [modelsText, setModelsText] = useState((initial?.models ?? []).map((model) => model.id).join(" "));
	const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);
	const [verifying, setVerifying] = useState(false);

	const modelIds = modelsText
		.split(/[\s,]+/)
		.map((item) => item.trim())
		.filter(Boolean);
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
			<label className="side-field">
				<span>模型 id（空格或换行分隔）</span>
				<textarea
					rows={3}
					value={modelsText}
					onChange={(event) => setModelsText(event.target.value)}
					placeholder="deepseek-chat deepseek-reasoner"
				/>
			</label>
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
