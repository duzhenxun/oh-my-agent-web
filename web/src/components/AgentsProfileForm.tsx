/**
 * 子代理模板的编辑表单（从 AgentsPanel 拆出：那个文件只负责模板列表与开关，运行记录在对话下方）。
 *
 * 字段与 md 文件一一对应：id / 显示名 / 描述 / 系统指令 / 工具白名单 / 模型 / 思考级别 / 最大轮次。
 * 保存走上行请求，落 `~/.pi/agent/agents/<id>.md`（见 server/subagents/profile-store.ts）。
 */
import { useMemo, useState } from "react";
import { useAppState } from "../store.ts";
import { saveSubagentProfile } from "../ws.ts";
import { filterEnabledModels } from "../model-groups.ts";
import type { SubagentProfileView } from "../types.ts";
import { useT } from "../use-language.ts";

const TOOL_CHOICES = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** 编辑表单：一个模板的完整字段（保存后写 `~/.pi/agent/agents/<id>.md`） */
export function AgentsProfileForm({ profile, onClose }: { profile: SubagentProfileView; onClose: () => void }) {
	const t = useT();
	const [draft, setDraft] = useState<SubagentProfileView>(profile);
	const snapshot = useAppState().snapshot;
	// 停用的模型同样不给选：子代理跑起来会因为「模型不在白名单」而直接失败
	const models = useMemo(
		() => filterEnabledModels(snapshot?.models ?? [], snapshot?.enabledModels ?? []),
		[snapshot?.models, snapshot?.enabledModels],
	);
	const patch = (value: Partial<SubagentProfileView>) => setDraft((current) => ({ ...current, ...value }));
	const toggleTool = (tool: string) =>
		patch({
			tools: draft.tools.includes(tool) ? draft.tools.filter((item) => item !== tool) : [...draft.tools, tool],
		});

	return (
		<div className="agents-form">
			<div className="agents-form-row">
				<label className="agents-field">
					<span>{t("子代理 ID", "Subagent ID")}</span>
					<input
						value={draft.id}
						disabled={!draft.builtin ? false : true}
						onChange={(event) => patch({ id: event.target.value })}
						placeholder="review"
					/>
				</label>
				<label className="agents-field">
					<span>{t("显示名称", "Display name")}</span>
					<input value={draft.label} onChange={(event) => patch({ label: event.target.value })} placeholder="Review" />
				</label>
			</div>

			<label className="agents-field">
				<span>
					{t("描述（模型靠它决定什么时候用谁）", "Description (the model uses it to decide when to use which)")}
				</span>
				<input
					value={draft.description}
					onChange={(event) => patch({ description: event.target.value })}
					placeholder={t(
						"代码 / 方案 / PR 审查：有证据的发现与合并结论",
						"Code / design / PR review: findings with evidence and a merge verdict",
					)}
				/>
			</label>

			<label className="agents-field">
				<span>{t("系统指令", "System instructions")}</span>
				<textarea
					value={draft.systemPrompt}
					onChange={(event) => patch({ systemPrompt: event.target.value })}
					rows={8}
					placeholder="Explore the codebase to answer the delegated question. Do not modify files…"
				/>
			</label>

			<div className="agents-field">
				<span>{t("工具", "Tools")}</span>
				<div className="agents-tools">
					{TOOL_CHOICES.map((tool) => (
						<label key={tool} className="agents-tool">
							<input type="checkbox" checked={draft.tools.includes(tool)} onChange={() => toggleTool(tool)} />
							{tool}
						</label>
					))}
				</div>
			</div>

			<div className="agents-form-row">
				<label className="agents-field">
					<span>{t("模型（留空 = 跟随默认）", "Model (empty = follow the default)")}</span>
					<select value={draft.model ?? ""} onChange={(event) => patch({ model: event.target.value || undefined })}>
						<option value="">{t("跟随默认模型", "Follow the default model")}</option>
						{models.map((model) => (
							<option key={model.id} value={model.id}>
								{model.label}
							</option>
						))}
					</select>
				</label>
				<label className="agents-field">
					<span>{t("思考级别", "Thinking level")}</span>
					<select
						value={draft.thinking ?? ""}
						onChange={(event) => patch({ thinking: event.target.value || undefined })}
					>
						<option value="">{t("跟随默认", "Follow the default")}</option>
						{["off", "minimal", "low", "medium", "high", "xhigh", "max"].map((level) => (
							<option key={level} value={level}>
								{level}
							</option>
						))}
					</select>
				</label>
				<label className="agents-field agents-field-narrow">
					<span>{t("最大轮次", "Max turns")}</span>
					<input
						type="number"
						min={1}
						max={200}
						value={draft.maxTurns ?? ""}
						onChange={(event) => patch({ maxTurns: Number(event.target.value) || undefined })}
					/>
				</label>
			</div>

			<div className="agents-form-actions">
				<span className="agents-hint">
					{draft.builtin
						? t(
								"内置模板：保存会生成一个同名用户文件（可再改回来）",
								"Built-in template: saving creates a user file with the same name (you can revert later)",
							)
						: t("保存后对新建的子代理生效", "Applies to subagents created after saving")}
				</span>
				<button type="button" className="btn btn-tiny" onClick={onClose}>
					{t("取消", "Cancel")}
				</button>
				<button
					type="button"
					className="btn btn-tiny btn-primary"
					disabled={draft.id.trim() === "" || draft.systemPrompt.trim() === ""}
					onClick={() => {
						saveSubagentProfile({ ...draft, id: draft.id.trim(), label: draft.label.trim() || draft.id.trim() });
						onClose();
					}}
				>
					{t("保存", "Save")}
				</button>
			</div>
		</div>
	);
}
