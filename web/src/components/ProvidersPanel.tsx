import { useState } from "react";
import { useAppState } from "../store.ts";
import type { ProviderView } from "../types.ts";
import { ImportModels } from "./ImportModels.tsx";
import { ModelEditor } from "./ModelEditor.tsx";
import { ProviderForm } from "./ProviderForm.tsx";

/**
 * 模型管理（左列表 + 右详情）。
 *
 * 布局照参考实现：**左边只放 provider**，右边放这个 provider 的表单与模型表。
 * 之前的写法是「把引擎可用模型按厂家平铺一遍 + 底下再列 provider」，
 * 结果是两套东西混在一起：既看不清自己配了什么，`0 个可用（先打开一个会话）`
 * 这种提示也毫无用处 —— 配置 provider 跟有没有打开会话无关。
 *
 * 只认**用户自己配的** provider（source=custom）：Pi 内置目录里的那些由 pi 管，
 * 在这里列出来既不能改也容易误改，统一折叠成底部一行提示。
 */
export function ProvidersPanel() {
	const { snapshot } = useAppState();
	const all: ProviderView[] = snapshot?.providers ?? [];
	const custom = all.filter((provider) => provider.source === "custom");
	const builtin = all.filter((provider) => provider.source === "builtin");

	const [selected, setSelected] = useState<string | null>(null);
	const [creating, setCreating] = useState(false);
	const [importing, setImporting] = useState(false);
	const [editingModel, setEditingModel] = useState<string | null>(null);

	// 没选或选中的被删掉了 → 落到第一个（列表随快照变，不额外存副本）
	const current = custom.find((provider) => provider.provider === selected) ?? custom[0] ?? null;
	const showForm = creating || current === null;

	return (
		<div className="prov-shell">
			<aside className="prov-list">
				<div className="prov-list-head">
					<span>Provider</span>
					<span className="side-panel-count">{custom.length}</span>
				</div>
				<div className="prov-list-scroll">
					{custom.length === 0 ? <div className="side-panel-hint">还没有自定义 provider</div> : null}
					{custom.map((provider) => (
						<button
							type="button"
							key={provider.provider}
							className={`prov-item${!creating && current?.provider === provider.provider ? " prov-item-on" : ""}`}
							onClick={() => {
								setCreating(false);
								setSelected(provider.provider);
								setImporting(false);
								setEditingModel(null);
							}}
						>
							<span className="prov-item-name">{provider.provider}</span>
							<span className="prov-item-meta">
								{provider.models.length} 模型{provider.hasKey ? "" : " · 无 key"}
							</span>
						</button>
					))}
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
				{builtin.length > 0 ? (
					<div className="prov-builtin" title={builtin.map((provider) => provider.provider).join(", ")}>
						pi 内置 {builtin.length} 个 provider（由 pi 管理，不在此编辑）
					</div>
				) : null}
			</aside>

			<section className="prov-detail">
				{editingModel && current ? (
					<ModelEditor
						key={`${current.provider}/${editingModel}`}
						provider={current}
						modelId={editingModel}
						onClose={() => setEditingModel(null)}
					/>
				) : importing && current ? (
					<ImportModels provider={current} onClose={() => setImporting(false)} onImported={() => setImporting(false)} />
				) : (
					<>
						<ProviderForm
							key={showForm ? "new" : current?.provider}
							initial={showForm ? null : current}
							onClose={() => setCreating(false)}
						/>
						{current && !creating ? (
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
