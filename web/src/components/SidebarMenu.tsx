import { useState } from "react";
import { groupModels } from "../model-groups.ts";
import { useAppState } from "../store.ts";
import { ProviderForm } from "./ProviderForm.tsx";
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
	const models = snapshot?.models ?? [];
	const groups = groupModels(models);

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

			{panel === "models" ? (
				<div className="side-panel">
					<div className="side-panel-head">
						<strong>模型</strong>
						<span className="side-panel-count">{models.length} 个可用</span>
					</div>
					<div className="side-panel-scroll">
						{groups.length === 0 ? <div className="side-panel-hint">还没有可用模型（先打开一个会话）</div> : null}
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
					{adding ? (
						<ProviderForm onClose={() => setAdding(false)} />
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

			{panel === "settings" ? <SettingsPanel /> : null}
		</div>
	);
}
