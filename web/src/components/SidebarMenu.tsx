import { useState } from "react";
import { createPortal } from "react-dom";
import { ProvidersPanel } from "./ProvidersPanel.tsx";
import { SettingsPanel } from "./SettingsPanel.tsx";
import { SkillsPanel } from "./SkillsPanel.tsx";
import { PushPanel } from "./PushPanel.tsx";

type Panel = "models" | "skills" | "push" | "settings" | null;

/**
 * 侧栏底部入口（P7）：模型 / 技能 / 设置。
 *
 * 分期落地（用户明确："设置先放上，后面一步步开发"）：
 *   - 模型：现在就能看到「按厂家分组的可用模型 + 当前模型」；
 *     「添加模型」已可用：配 provider（base url / api key）+ 模型 id（ADR-0025 A 期）；
 *   - 技能：管理技能的入口先放上，能力待做（读 ~/.pi 下的技能目录 + 启停）；
 *   - 设置：直接复用已有的设置面板（快捷短语）。
 */
export function SidebarMenu({
	initialPanel = null,
	variant = "full",
	placement = "footer",
}: {
	/** 收起态由活动栏按钮指定打开哪个面板 */
	initialPanel?: Panel;
	/** full = 三个入口 + 弹窗；modal = 只渲染弹窗（收起态用） */
	variant?: "full" | "modal";
	/** footer = 侧栏底部；appbar = 顶部那一排 */
	placement?: "footer" | "appbar";
} = {}) {
	const [panel, setPanel] = useState<Panel>(initialPanel);
	const item = (key: Exclude<Panel, null>, icon: string, label: string) => (
		<button
			type="button"
			className={`side-foot-btn${panel === key ? " side-foot-btn-on" : ""}`}
			onClick={() => setPanel(panel === key ? null : key)}
		>
			<span className="side-foot-icon" aria-hidden="true">
				{icon}
			</span>
			{label}
		</button>
	);

	return (
		<div className={placement === "appbar" ? "appbar-menu" : "side-foot"}>
			{variant === "full" ? (
				<div className="side-foot-row">
					{item("models", "🤖", "模型")}
					{item("skills", "🧰", "技能")}
					{item("push", "🔔", "推送")}
					{item("settings", "⚙", "设置")}
				</div>
			) : null}

			{panel
				? createPortal(
						<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="工作台面板">
							<div className="modal big-modal">
								<div className="big-modal-head">
									{(["models", "skills", "push", "settings"] as const).map((key) => (
										<button
											type="button"
											key={key}
											className={`big-tab${panel === key ? " big-tab-on" : ""}`}
											onClick={() => setPanel(key)}
										>
											{key === "models"
												? "🤖 模型"
												: key === "skills"
													? "🧰 技能"
													: key === "push"
														? "🔔 推送"
														: "⚙ 设置"}
										</button>
									))}
									<span className="topbar-spacer" />
									<button type="button" className="btn btn-tiny" onClick={() => setPanel(null)} title="关闭">
										✕
									</button>
								</div>

								<div className="big-modal-body">
									{panel === "models" ? <ProvidersPanel /> : null}

									{panel === "skills" ? <SkillsPanel /> : null}
									{panel === "push" ? <PushPanel /> : null}
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
