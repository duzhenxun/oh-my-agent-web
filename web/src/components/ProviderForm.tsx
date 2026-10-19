import { useState } from "react";
import { upsertProvider } from "../ws.ts";

/**
 * 「添加模型」表单（ADR-0025 A 期）：
 *   - api key 是**只能填、不能读**的字段：留空表示不修改已有 key；
 *   - 服务端保存后回一份不含明文 key 的视图（只有 hasKey + 尾 4 位）。
 */
export function ProviderForm({ onClose }: { onClose: () => void }) {
	const [provider, setProvider] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [api, setApi] = useState("openai-completions");
	const [apiKey, setApiKey] = useState("");
	const [modelsText, setModelsText] = useState("");
	const [message, setMessage] = useState<{ kind: "ok" | "error"; text: string } | null>(null);

	const submit = () => {
		const models = modelsText
			.split(/[\s,]+/)
			.map((item) => item.trim())
			.filter(Boolean)
			.map((id) => ({ id }));
		upsertProvider({
			provider,
			baseUrl,
			api,
			...(apiKey.trim() === "" ? {} : { apiKey: apiKey.trim() }),
			models,
		});
		// 校验与写盘都在服务端；结果用提示条回传（前端没有 request/response 配对机制）
		setMessage({ kind: "ok", text: "已提交，结果会以提示形式出现在对话区" });
		setApiKey("");
	};

	return (
		<div className="side-panel">
			<div className="side-panel-head">
				<strong>添加模型</strong>
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
				</select>
			</label>
			<label className="side-field">
				<span>api key（留空 = 不修改已有 key）</span>
				<input
					type="password"
					value={apiKey}
					onChange={(event) => setApiKey(event.target.value)}
					placeholder="sk-…"
					autoComplete="off"
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
			<button type="button" className="btn btn-tiny" onClick={submit}>
				保存
			</button>
		</div>
	);
}
