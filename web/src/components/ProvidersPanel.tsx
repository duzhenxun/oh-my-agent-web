import { useEffect, useRef, useState } from "react";
import { useAppState } from "../store.ts";
import { deleteProvider, setProviderEnabled } from "../ws.ts";
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
	/** 启用白名单（pi settings.json）：空数组 = 全开 */
	const allowlist = snapshot?.enabledModels ?? [];
	const providerEnabled = (provider: ProviderView) =>
		allowlist.length === 0 ||
		allowlist.some((pattern) => pattern === `${provider.provider}/**` || pattern.startsWith(`${provider.provider}/`));

	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [importing, setImporting] = useState(false);
	const [editingModel, setEditingModel] = useState<string | null>(null);
	/** 右栏两个 Tab：配置 / 模型（内置 provider 也能改配置，所以两者对谁都可用） */
	const [tab, setTab] = useState<"config" | "models">("config");
	/** 批量测试结果：modelId → 耗时 / 失败原因 */
	const [latency, setLatency] = useState<Record<string, { ok: boolean; text: string }>>({});
	const [batchBusy, setBatchBusy] = useState(false);
	/** 左栏宽度（可拖，存 localStorage —— 纯界面偏好，不该进快照） */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem("agent-web:provider-list-width"));
		return Number.isFinite(stored) && stored >= 140 && stored <= 420 ? stored : 190;
	});
	useEffect(() => {
		localStorage.setItem("agent-web:provider-list-width", String(listWidth));
	}, [listWidth]);
	const dragging = useRef(false);

	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			setListWidth(Math.min(420, Math.max(140, startWidth + (moveEvent.clientX - startX))));
		};
		const onUp = () => {
			dragging.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

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
	/** 单个模型是否启用：白名单空 = 全开；命中 `provider/**` 或精确 `provider/model` 即可 */
	const modelEnabled = (provider: string, modelId: string) =>
		allowlist.length === 0 ||
		allowlist.some((pattern) => pattern === `${provider}/**` || pattern === `${provider}/${modelId}`);
	const enabledCount = (provider: ProviderView) =>
		provider.models.filter((model) => modelEnabled(provider.provider, model.id)).length;

	/** 全局计数：所有 provider 的模型里，落在白名单内的有多少 */
	const totalModels = providers.reduce((sum, provider) => sum + provider.models.length, 0);
	const enabledTotal = providers.reduce((sum, provider) => sum + enabledCount(provider), 0);

	return (
		<>
			<div className="prov-global-bar">
				<span className="mono prov-global-path">~/.pi/agent/settings.json</span>
				<span className="side-panel-count">
					已启用 {enabledTotal}/{totalModels}
				</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setProviderEnabled("*", true)}
					disabled={allowlist.length === 0}
					title="清空 enabledModels 白名单 —— pi 的语义是「不限制」即全部可用"
				>
					启用全部模型
				</button>
			</div>
			<div className="prov-shell" style={{ gridTemplateColumns: `minmax(140px, ${listWidth}px) 6px minmax(0, 1fr)` }}>
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
											setTab("config");
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
														className={`prov-dot${modelEnabled(provider.provider, model.id) ? " prov-dot-on" : ""}`}
														title={modelEnabled(provider.provider, model.id) ? "已启用" : "未启用"}
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

				{/* 分隔条：拖动改左栏宽度（双击复位） */}
				<div
					className="prov-resizer"
					role="separator"
					aria-orientation="vertical"
					title="拖动调整宽度（双击复位）"
					onPointerDown={startResize}
					onDoubleClick={() => setListWidth(190)}
				/>

				<section className={`prov-detail${isCustom && !creating ? " prov-detail-split" : ""}`}>
					{editingModel && current ? (
						<ModelEditor
							key={`${current.provider}/${editingModel}`}
							provider={current}
							modelId={editingModel}
							onClose={() => setEditingModel(null)}
						/>
					) : importing && current ? (
						<ImportModels
							provider={current}
							onClose={() => setImporting(false)}
							onImported={() => setImporting(false)}
						/>
					) : (
						<>
							{current && !creating ? (
								<div className="prov-tabs">
									{(current ? ["config", "models"] : []).map((key) => (
										<button
											type="button"
											key={key}
											className={`prov-tab${tab === key ? " prov-tab-on" : ""}`}
											onClick={() => setTab(key as "config" | "models")}
										>
											{key === "config" ? "配置" : `模型 ${current.models.length}`}
										</button>
									))}
									<span className="topbar-spacer" />
									<span className="side-panel-count">
										{enabledCount(current)}/{current.models.length} 启用
									</span>
									<label className="prov-switch" title="停用后这个 provider 的模型不再出现在选择器里">
										<input
											type="checkbox"
											checked={providerEnabled(current)}
											onChange={(event) => setProviderEnabled(current.provider, event.target.checked)}
										/>
										<span className="prov-switch-track" aria-hidden="true" />
									</label>
									<button
										type="button"
										className="btn btn-tiny btn-danger"
										onClick={() => {
											const where = current.source === "builtin" ? "（会从 ~/.pi/agent/models.json 里整条删掉）" : "";
											if (!window.confirm(`删除 provider「${current.provider}」？它的 api key 也会一起删。${where}`))
												return;
											deleteProvider(current.provider);
											setSelected(null);
										}}
									>
										删除
									</button>
								</div>
							) : null}

							{showForm || tab === "config" ? (
								<ProviderForm
									key={showForm ? "new" : current?.provider}
									initial={showForm ? null : current}
									onClose={() => setCreating(false)}
									onSaved={(saved) => {
										// 存完就选中它：否则表单还停在「添加」态，看着像没保存成功
										setCreating(false);
										setSelected(saved);
										setTab("config");
									}}
								/>
							) : null}

							{current && !creating && tab === "models" ? (
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
											<div className="side-panel-hint">这个 provider 下还没有模型：可以导入，或在「配置」里手填</div>
										) : null}
										{current.models.map((model) => (
											<div className="prov-model-row" key={model.id}>
												<button
													type="button"
													className="prov-model-name prov-model-open"
													title={model.id}
													onClick={() => setEditingModel(model.id)}
												>
													{model.name}
												</button>
												<LatencyCell result={latency[model.id]} />
												<label className="prov-switch prov-switch-sm" title="单独启用 / 停用这个模型">
													<input
														type="checkbox"
														checked={modelEnabled(current.provider, model.id)}
														onChange={(event) => setProviderEnabled(current.provider, event.target.checked, model.id)}
													/>
													<span className="prov-switch-track" aria-hidden="true" />
												</label>
												<button type="button" className="msg-action" onClick={() => setEditingModel(model.id)}>
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
		</>
	);
}

/** 响应耗时列（批量测试前是占位符，保持列宽不跳动） */
function LatencyCell({ result }: { result?: { ok: boolean; text: string } }) {
	if (!result) return <span className="prov-latency prov-latency-idle">—</span>;
	return <span className={`prov-latency${result.ok ? " prov-latency-ok" : " prov-latency-fail"}`}>{result.text}</span>;
}
