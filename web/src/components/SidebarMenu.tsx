import { useState } from "react";
import { createPortal } from "react-dom";
import { groupModels } from "../model-groups.ts";
import { useAppState } from "../store.ts";
import type { ProviderView } from "../types.ts";
import { ProviderForm } from "./ProviderForm.tsx";
import { deleteProvider, testProvider } from "../ws.ts";
import { SettingsPanel } from "./SettingsPanel.tsx";

type Panel = "models" | "skills" | "settings" | null;

/**
 * 侧栏底部入口（P7）：模型 / 技能 / 设置。
 *
 * 分期落地（用户明确："设置先放上，后面一步步开发"）：
 *   - 模型：现在就能看到「按厂家分组的可用模型 + 当前模型」；
 *     「添加模型」已可用：配 provider（base url / api key）+ 模型 id（ADR-0025 A 期）；
 *   - 技能：管理技能的入口先放上，能力待做（读 ~/.pi 下的技能目录 + 启停）；
 *   - 设置：直接复用已有的设置面板（快捷短语）。
 */
export function SidebarMenu() {
	const { snapshot } = useAppState();
	const [panel, setPanel] = useState<Panel>(null);
	const [adding, setAdding] = useState(false);
	const [editingProvider, setEditingProvider] = useState<string | null>(null);
	const configured: ProviderView[] = snapshot?.providers ?? [];
	const models = snapshot?.models ?? [];
	const groups = groupModels(models);
	// 内置 provider（nexita / nexita-anthropic …）不在 models-store 里，直接从引擎模型归组，
	// 与「模型选择器」同源 —— 这样会话一打开它们就出现在列表里，不用等后端刷新
	const configuredNames = new Set(configured.map((view) => view.provider));
	const builtinProviders: ProviderView[] = groups
		.filter((group) => !configuredNames.has(group.provider))
		.map((group) => ({
			provider: group.provider,
			source: "builtin",
			baseUrl: "",
			api: "",
			hasKey: group.models.some((model) => model.id === snapshot?.model) || true,
			keyHint: null,
			models: group.models.map((model) => ({ id: model.id, name: model.label })),
		}));
	const providers: ProviderView[] = [...configured, ...builtinProviders];

	const item = (key: Exclude<Panel, null>, icon: string, label: string) => (
		<button
			type="button"
			className={`side-foot-btn${panel === key ? " side-foot-btn-on" : ""}`}
			onClick={() => setPanel(panel === key ? null : key)}
		>
			<span aria-hidden="true">{icon}</span>
			{label}
		</button>
	);

	return (
		<div className="side-foot">
			<div className="side-foot-row">
				{item("models", "🤖", "模型")}
				{item("skills", "🧰", "技能")}
				{item("settings", "⚙", "设置")}
			</div>

			{panel
				? createPortal(
						<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="工作台面板">
							<div className="modal big-modal">
								<div className="big-modal-head">
									{(["models", "skills", "settings"] as const).map((key) => (
										<button
											type="button"
											key={key}
											className={`big-tab${panel === key ? " big-tab-on" : ""}`}
											onClick={() => setPanel(key)}
										>
											{key === "models" ? "🤖 模型" : key === "skills" ? "🧰 技能" : "⚙ 设置"}
										</button>
									))}
									<span className="topbar-spacer" />
									<button type="button" className="btn btn-tiny" onClick={() => setPanel(null)} title="关闭">
										✕
									</button>
								</div>

								<div className="big-modal-body">
									{panel === "models" ? (
										<div className="side-panel">
											<div className="side-panel-head">
												<strong>模型</strong>
												<span className="side-panel-count">{models.length} 个可用</span>
											</div>
											<div className="side-panel-scroll">
												{groups.length === 0 ? (
													<div className="side-panel-hint">还没有可用模型（先打开一个会话）</div>
												) : null}
												{groups.map((group) => (
													<div className="side-model-group" key={group.provider}>
														<div className="side-model-provider">{group.provider.toUpperCase()}</div>
														{group.models.map((model) => (
															<div
																className={`side-model-row${model.id === snapshot?.model ? " side-model-row-on" : ""}`}
																key={model.id}
																title={model.id}
															>
																<span className="side-model-check">{model.id === snapshot?.model ? "✓" : ""}</span>
																<span className="side-model-label">{model.label}</span>
															</div>
														))}
													</div>
												))}
											</div>
											{providers.length > 0 ? (
												<div className="side-provider-list">
													{providers.map((provider) => (
														<div className="side-provider" key={provider.provider}>
															<div className="side-provider-head" title={provider.baseUrl}>
																<span className="side-provider-name">
																	{provider.provider}
																	{provider.source === "builtin" ? (
																		<span className="side-provider-badge">内置</span>
																	) : null}
																</span>
																<span className="side-provider-meta">
																	{provider.models.length} 模型 ·{" "}
																	{provider.hasKey ? `key ${provider.keyHint ?? ""}` : "无 key"}
																</span>
															</div>
															{provider.source === "custom" ? (
																<div className="side-provider-actions">
																	<button
																		type="button"
																		className="msg-action"
																		onClick={() => setEditingProvider(provider.provider)}
																	>
																		✏️ 编辑
																	</button>
																	<button
																		type="button"
																		className="msg-action"
																		onClick={() => testProvider(provider.provider)}
																	>
																		🔌 测试
																	</button>
																	<button
																		type="button"
																		className="msg-action"
																		onClick={() => {
																			// 二次确认：删的是模型表 + 凭证，误删要重填 key
																			if (
																				!window.confirm(
																					`删除 provider「${provider.provider}」？它的 api key 也会一起删掉。`,
																				)
																			)
																				return;
																			deleteProvider(provider.provider);
																		}}
																	>
																		🗑 删除
																	</button>
																</div>
															) : (
																<div className="side-provider-actions">
																	<span className="side-panel-hint">由 pi 内置目录管理，这里只读</span>
																</div>
															)}
														</div>
													))}
												</div>
											) : (
												<div className="side-panel-hint">还没有自己配置的 provider</div>
											)}
											{adding || editingProvider ? (
												<ProviderForm
													initial={
														editingProvider
															? (providers.find((item) => item.provider === editingProvider) ?? null)
															: null
													}
													onClose={() => {
														setAdding(false);
														setEditingProvider(null);
													}}
												/>
											) : (
												<button type="button" className="btn btn-tiny" onClick={() => setAdding(true)}>
													＋ 添加模型
												</button>
											)}
										</div>
									) : null}

									{panel === "skills" ? (
										<div className="side-panel">
											<div className="side-panel-head">
												<strong>技能</strong>
											</div>
											<div className="side-panel-hint">
												技能管理还没做：计划是读技能目录、显示已装载的技能、支持启停与打开说明。
											</div>
										</div>
									) : null}

									{panel === "skills" ? (
										<div className="side-panel">
											<div className="side-panel-head">
												<strong>技能</strong>
											</div>
											<div className="side-panel-hint">
												技能管理还没做：计划是读技能目录、显示已装载的技能、支持启停与打开说明。
											</div>
										</div>
									) : null}
									{panel === "settings" ? <SettingsPanel /> : null}
								</div>
							</div>
						</div>,
						document.body,
					)
				: null}
		</div>
	);
}
