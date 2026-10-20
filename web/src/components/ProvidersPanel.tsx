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
 * 这里只展示 + 说明，不给编辑入口 —— 改了会写坏 pi 的配置。
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
							它由 pi 内置目录管理：baseUrl 与模型表都来自 pi 自己
							{current.hasKey ? `，key ${current.keyHint ?? ""}` : "，目前没有 key"}。 要改它请用 pi
							的配置文件，这里只做展示（改这里会写坏 pi 的目录）。
						</div>
						<div className="prov-models">
							<div className="prov-models-head">
								<span>模型</span>
								<span className="side-panel-count">{current.models.length}</span>
							</div>
							<div className="prov-models-scroll">
								{current.models.map((model) => (
									<div className="prov-model-row" key={model.id}>
										<span className="prov-model-name" title={model.id}>
											{model.name}
										</span>
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
