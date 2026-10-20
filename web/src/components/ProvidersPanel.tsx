import { useState } from "react";
import { useAppState } from "../store.ts";
import type { ProviderView } from "../types.ts";
import { ImportModels } from "./ImportModels.tsx";
import { ModelEditor } from "./ModelEditor.tsx";
import { ProviderForm } from "./ProviderForm.tsx";

/**
 * 模型管理（左列表 + 右详情）。
 *
 * 左栏列**全部** provider（自定义的 + pi 内置的），点哪个就把它的模型摊在下面；
 * 右栏是它的配置。之前只列自定义的，用户会以为 nexita / nexita-anthropic 之类「丢了」。
 *
 * 内置 provider 由 pi 自己的目录管理（baseUrl / 模型表都是 pi 给的），
 * 它们是可以改的：写回 pi 的 models.json（不是另建覆盖条目），见 catalog-store.ts。
 */
export function ProvidersPanel() {
	const { snapshot } = useAppState();
	const providers: ProviderView[] = snapshot?.providers ?? [];
	/** 引擎当前可用的模型（`provider/modelId`）：用来标「已启用」 */
	const enabled = new Set((snapshot?.models ?? []).map((model) => model.id));

	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [importing, setImporting] = useState(false);
	const [editingModel, setEditingModel] = useState<string | null>(null);
	/** 批量测试结果：modelId → 耗时 / 失败原因 */
	const [latency, setLatency] = useState<Record<string, { ok: boolean; text: string }>>({});
	const [batchBusy, setBatchBusy] = useState(false);

	/** 逐个测（顺序执行：并发打容易把网关打出 429，也会让耗时失真） */
	const batchTest = async (provider: ProviderView) => {
		setBatchBusy(true);
		setLatency({});
		for (const model of provider.models) {
			try {
				const response = await fetch(
					`/api/providers/${encodeURIComponent(provider.provider)}/models/${encodeURIComponent(model.id)}/test`,
					{ method: "POST" },
				);
				const body = (await response.json()) as { ok?: boolean; latencyMs?: number; message?: string };
				setLatency((current) => ({
					...current,
					[model.id]: body.ok
						? { ok: true, text: `${body.latencyMs ?? "?"}ms` }
						: { ok: false, text: `失败 ${body.message ?? ""}`.trim() },
				}));
			} catch (cause) {
				setLatency((current) => ({
					...current,
					[model.id]: { ok: false, text: cause instanceof Error ? cause.message : "失败" },
				}));
			}
		}
		setBatchBusy(false);
	};

	// 没选或选中的没了 → 落到第一个（列表随快照变，不另存副本）
	const current = providers.find((provider) => provider.provider === selected) ?? providers[0] ?? null;
	const isCustom = current?.source === "custom";
	const showForm = creating || current === null;
	const enabledCount = (provider: ProviderView) =>
		provider.models.filter((model) => enabled.has(`${provider.provider}/${model.id}`)).length;

	return (
		<div className="prov-shell">
			<aside className="prov-list">
				<div className="prov-list-head">
					<span>Provider</span>
					<span className="side-panel-count">{providers.length}</span>
				</div>
				<div className="prov-list-scroll">
					{providers.length === 0 ? <div className="side-panel-hint">还没有 provider</div> : null}
					{providers.map((provider) => {
						const active = !creating && current?.provider === provider.provider;
						return (
							<div key={provider.provider} className={`prov-block${active ? " prov-block-on" : ""}`}>
								<button
									type="button"
									className={`prov-item${active ? " prov-item-on" : ""}`}
									onClick={() => {
										setCreating(false);
										setImporting(false);
										setEditingModel(null);
										setSelected(provider.provider);
									}}
								>
									<span className="prov-item-name">
										{provider.provider}
										{provider.source === "builtin" ? <span className="side-provider-badge">内置</span> : null}
										{provider.hasKey ? null : <span className="prov-item-warn">无 key</span>}
									</span>
									<span className="prov-item-meta">
										启用 {enabledCount(provider)}/{provider.models.length}
									</span>
								</button>
								{active ? (
									<div className="prov-models-inline">
										{provider.models.length === 0 ? (
											<div className="side-panel-hint">这个 provider 下没有模型</div>
										) : null}
										{provider.models.map((model) => (
											<button
												type="button"
												key={model.id}
												className="prov-inline-row"
												title={model.id}
												onClick={() => {
													// 内置 provider 也能点：右侧同样给模型详情（保存时会落成自定义条目）
													setImporting(false);
													setEditingModel(model.id);
												}}
											>
												<span
													className={`prov-dot${enabled.has(`${provider.provider}/${model.id}`) ? " prov-dot-on" : ""}`}
													title={enabled.has(`${provider.provider}/${model.id}`) ? "已启用" : "未启用"}
												/>
												<span className="prov-inline-name">{model.name}</span>
											</button>
										))}
									</div>
								) : null}
							</div>
						);
					})}
				</div>
				<button
					type="button"
					className="btn btn-tiny prov-add"
					onClick={() => {
						setCreating(true);
						setImporting(false);
						setEditingModel(null);
					}}
				>
					＋ 添加 Provider
				</button>
			</aside>

			<section className="prov-detail">
				{editingModel && current ? (
					<ModelEditor
						key={`${current.provider}/${editingModel}`}
						provider={current}
						modelId={editingModel}
						onClose={() => setEditingModel(null)}
					/>
				) : current?.source === "builtin" && !creating ? (
					<div className="side-panel">
						<div className="side-panel-head">
							<strong>{current.provider}</strong>
							<span className="side-provider-badge">内置</span>
							<span className="topbar-spacer" />
							<span className="side-panel-count">
								{enabledCount(current)}/{current.models.length} 启用
							</span>
						</div>
						<div className="side-panel-hint">
							来自 pi 的 provider 目录（<span className="mono">~/.pi/agent/models.json</span>）
							{current.hasKey ? `，key ${current.keyHint ?? ""}` : "，目前没有 key"}。 这里的修改会直接写回那份配置 ——
							点模型即可编辑，删掉也会从目录里移除。
						</div>
						<div className="prov-models">
							<div className="prov-models-head">
								<span>模型</span>
								<span className="side-panel-count">{current.models.length}</span>
								<span className="topbar-spacer" />
								<button
									type="button"
									className="btn btn-tiny"
									onClick={() => void batchTest(current)}
									disabled={batchBusy || current.models.length === 0}
									title="逐个发一次最小请求，量出每个模型的响应时间（会消耗与模型数相同的请求数）"
								>
									{batchBusy ? "测试中…" : "⏱ 批量测试"}
								</button>
							</div>
							<div className="prov-models-scroll">
								{current.models.map((model) => (
									<div className="prov-model-row" key={model.id}>
										<span className="prov-model-name" title={model.id}>
											{model.name}
										</span>
										<LatencyCell result={latency[model.id]} />
										<span className="prov-model-spec">
											{enabled.has(`${current.provider}/${model.id}`) ? "已启用" : "未启用"}
										</span>
									</div>
								))}
							</div>
						</div>
					</div>
				) : importing && current ? (
					<ImportModels provider={current} onClose={() => setImporting(false)} onImported={() => setImporting(false)} />
				) : (
					<>
						<ProviderForm
							key={showForm ? "new" : current?.provider}
							initial={showForm ? null : current}
							onClose={() => setCreating(false)}
						/>
						{isCustom && current && !creating ? (
							<div className="prov-models">
								<div className="prov-models-head">
									<span>模型</span>
									<span className="side-panel-count">{current.models.length}</span>
									<span className="topbar-spacer" />
									<button
										type="button"
										className="btn btn-tiny"
										onClick={() => void batchTest(current)}
										disabled={batchBusy || current.models.length === 0}
										title="逐个发一次最小请求，量出每个模型的响应时间（会消耗与模型数相同的请求数）"
									>
										{batchBusy ? "测试中…" : "⏱ 批量测试"}
									</button>
									<button
										type="button"
										className="btn btn-tiny"
										onClick={() => setImporting(true)}
										title="探测这个 provider 下面还有哪些模型，勾选后批量导入"
									>
										⬇️ 导入模型
									</button>
								</div>
								<div className="prov-models-scroll">
									{current.models.length === 0 ? (
										<div className="side-panel-hint">
											这个 provider 下还没有模型：可以导入，或在上面的「模型 id」里手填
										</div>
									) : null}
									{current.models.map((model) => (
										<div className="prov-model-row" key={model.id}>
											<span className="prov-model-name" title={model.id}>
												{model.name}
											</span>
											<LatencyCell result={latency[model.id]} />
											<span className="prov-model-spec">
												{[
													model.contextWindow ? `${model.contextWindow} ctx` : null,
													model.reasoning ? "思考" : null,
													model.imageInput ? "图片" : null,
												]
													.filter(Boolean)
													.join(" · ") || "规格未填"}
											</span>
											<button
												type="button"
												className="msg-action"
												onClick={() => setEditingModel(model.id)}
												title="编辑这个模型的能力 / 规格 / 价格，或从 provider 下移除"
											>
												编辑
											</button>
										</div>
									))}
								</div>
							</div>
						) : null}
					</>
				)}
			</section>
		</div>
	);
}

/** 响应耗时列（批量测试前是占位符，保持列宽不跳动） */
function LatencyCell({ result }: { result?: { ok: boolean; text: string } }) {
	if (!result) return <span className="prov-latency prov-latency-idle">—</span>;
	return <span className={`prov-latency${result.ok ? " prov-latency-ok" : " prov-latency-fail"}`}>{result.text}</span>;
}
