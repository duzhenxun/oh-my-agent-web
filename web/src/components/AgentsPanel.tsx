/**
 * 「子代理」面板：管模板、管开关（**运行记录不在这里**）。
 *
 * 为什么不放运行记录：运行是「这个对话」派生出来的平行任务，放在设置面板里等于看进度
 * 要先开设置。它们现在就在对话区下方的卡片条里（`AgentsRunStrip`），面板只负责
 * 「谁能被委派、用什么工具、最多同时开几个」。
 *
 * 模板的读写走 RPC（与「模型 / 队列」同一套纪律：会话状态进快照，按需的配置操作走上行请求）。
 */
import { useEffect, useRef, useState } from "react";
import { useAppSelector } from "../store.ts";
import { deleteSubagentProfile, saveSubagentProfile, setSubagentSettings } from "../ws.ts";
import type { SubagentProfileView } from "../types.ts";
import { AgentsProfileForm } from "./AgentsProfileForm.tsx";
import { useT } from "../use-language.ts";

/** 左栏（模板）宽度：记住上次拖到哪，下次打开还是这个宽度 */
const LIST_WIDTH_KEY = "agent-web:agents-list-width";
const LIST_WIDTH_MIN = 168;
const LIST_WIDTH_MAX = 420;
const LIST_WIDTH_DEFAULT = 232;

function clampListWidth(width: number): number {
	return Math.min(LIST_WIDTH_MAX, Math.max(LIST_WIDTH_MIN, Math.round(width)));
}

export function AgentsPanel() {
	const t = useT();
	const snapshot = useAppSelector((state) => state.snapshot);
	const [editing, setEditing] = useState<SubagentProfileView | null>(null);
	/** 两栏之间的分隔线可以左右拖：模板名长短差别很大，固定宽度要么挤要么浪费 */
	const [listWidth, setListWidth] = useState(() => {
		const stored = Number(localStorage.getItem(LIST_WIDTH_KEY));
		return Number.isFinite(stored) && stored > 0 ? clampListWidth(stored) : LIST_WIDTH_DEFAULT;
	});
	const dragging = useRef(false);

	useEffect(() => {
		localStorage.setItem(LIST_WIDTH_KEY, String(listWidth));
	}, [listWidth]);

	/** 拖拽：pointer 事件挂在 document 上，鼠标移出那条线也不会中断 */
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		const startX = event.clientX;
		const startWidth = listWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			setListWidth(clampListWidth(startWidth + (moveEvent.clientX - startX)));
		};
		const onUp = () => {
			dragging.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};

	const profiles = snapshot?.subagentProfiles ?? [];
	const settings = snapshot?.subagentSettings ?? { enabled: true, concurrency: 4 };
	/** 引擎有没有子代理能力（老进程 / 未适配的引擎都没有） */
	const capable = snapshot?.engineCapabilities.subagents === true;
	/**
	 * 子代理能不能按「逐工具白名单」隔离：pi 能；codex 是沙箱 + 审批，不能。
	 * false 时面板要讲清楚，别让人以为勾掉 bash 就真的不给 bash。
	 */
	const whitelist = snapshot?.engineCapabilities.subagentToolWhitelist;

	return (
		<div className="agents-panel" style={{ "--agents-list-w": `${listWidth}px` } as React.CSSProperties}>
			{/* 头部永远在：总开关 + 「默认开几个」这两格，就算现在跑不了也要能看见、能改 */}
			<header className="agents-head">
				<div className="agents-head-title">
					<strong>{t("子代理", "Subagents")}</strong>
					<span className="agents-hint">
						{whitelist === false
							? t(
									"职责分工（委派说明）· 运行记录看对话下方",
									"Roles as delegation briefs · run history sits below the conversation",
								)
							: t(
									"职责分工与工具白名单 · 运行记录看对话下方",
									"Roles and tool allowlists · run history sits below the conversation",
								)}
					</span>
				</div>
				<div className="agents-head-actions">
					<label className="agents-toggle" title={t("关掉之后 Agent 工具不再暴露给模型（已有的模板保留）")}>
						<input
							type="checkbox"
							checked={settings.enabled}
							onChange={(event) => setSubagentSettings({ enabled: event.target.checked })}
						/>
						{t("启用子代理", "Enable subagents")}
					</label>
					<label className="agents-toggle agents-toggle-concurrency" title={t("最多同时开几个子代理，超出的排队")}>
						{t("默认同时开", "Run at most")}
						<select
							value={settings.concurrency}
							onChange={(event) => setSubagentSettings({ concurrency: Number(event.target.value) })}
						>
							{[1, 2, 3, 4, 5, 6, 8, 10, 12].map((count) => (
								<option key={count} value={count}>
									{count} 个
								</option>
							))}
						</select>
					</label>
				</div>
			</header>

			{!capable ? (
				<div className="agents-banner">
					{snapshot?.engine === "pi" || snapshot?.engine === undefined
						? "当前服务还没有子代理能力：更新后请重启一次服务（aw restart），面板里的模板不受影响。"
						: `当前引擎（${snapshot?.engine}）不能跑子代理：切到 pi 原生引擎即可；模板可以先在这里配置。`}
				</div>
			) : whitelist === false ? (
				<div className="agents-banner">
					{t(
						`${snapshot?.engine} 的子代理由引擎自己发起（模型调 spawn_agent），隔离靠沙箱与审批，所以模板里的工具勾选对它不生效。模板的「名称 + 说明」会作为委派说明注入新会话 —— 想让它真的只读，靠的是审批与沙箱，不是这里的勾选。`,
						`On ${snapshot?.engine}, subagents are spawned by the engine itself (spawn_agent) and isolated by sandbox + approvals, so the per-tool ticks do not apply. A template's name and description are injected into new sessions as delegation briefs; read-only-ness comes from the sandbox and approvals, not from the ticks.`,
					)}
				</div>
			) : null}

			<div className="agents-body">
				<section className="agents-col agents-col-profiles">
					<div className="agents-col-head">
						<span>
							{t("模板", "Templates")}（{profiles.length}）
						</span>
						<button
							type="button"
							className="btn btn-tiny"
							onClick={() =>
								setEditing({
									id: "",
									label: "",
									description: "",
									systemPrompt: "Complete the delegated task end to end. Report what you changed with file paths.",
									tools: ["read", "grep", "find", "ls"],
									enabled: true,
									builtin: false,
								})
							}
						>
							+ {t("新建", "New")}
						</button>
					</div>
					{profiles.length === 0 ? (
						<div className="agents-empty">
							<p>{t("还没有可用的模板。", "No templates available yet.")}</p>
							<p className="agents-hint">
								{t(
									"点上面的「+ 新建」建一个；内置的 explore / general-purpose / plan 会随服务一起出现。",
									"Use “+ New” above to create one; the built-in explore / general-purpose / plan appear automatically.",
								)}
							</p>
						</div>
					) : (
						<ul className="agents-profile-list">
							{profiles.map((profile) => (
								<li
									key={profile.id}
									className={`agents-profile${editing?.id === profile.id ? " agents-profile-on" : ""}`}
								>
									<button
										type="button"
										className="agents-profile-main"
										onClick={() => setEditing(profile)}
										title={profile.description || profile.id}
									>
										<span className="agents-profile-name">
											{profile.label}
											{profile.builtin ? <em className="agents-badge">{t("内置", "Built-in")}</em> : null}
										</span>
										<span className="agents-profile-desc">{profile.description || profile.id}</span>
									</button>
									<label className="agents-profile-switch" title={profile.enabled ? "停用" : "启用"}>
										<input
											type="checkbox"
											checked={profile.enabled}
											onChange={(event) => saveSubagentProfile({ ...profile, enabled: event.target.checked })}
										/>
									</label>
									{profile.builtin ? null : (
										<button
											type="button"
											className="agents-profile-del"
											title={t("删除这个模板（内置模板可以改成同名用户文件再删，等于恢复默认）")}
											onClick={() => deleteSubagentProfile(profile.id)}
										>
											✕
										</button>
									)}
								</li>
							))}
						</ul>
					)}
				</section>

				{/* 可左右拖：双击回到默认宽度（纯界面偏好，存 localStorage） */}
				<div
					className="agents-split"
					role="separator"
					aria-orientation="vertical"
					aria-label={t("调整模板栏宽度", "Resize the template column")}
					title={t("拖动调整宽度（双击复位）", "Drag to resize (double-click to reset)")}
					onPointerDown={startResize}
					onDoubleClick={() => setListWidth(LIST_WIDTH_DEFAULT)}
				/>

				<section className="agents-col agents-col-runs">
					{editing ? (
						<AgentsProfileForm
							key={`${editing.id}-${editing.builtin}`}
							profile={editing}
							onClose={() => setEditing(null)}
						/>
					) : (
						<div className="agents-empty">
							<p>
								{profiles.length === 0
									? t("还没有模板：点左边「+ 新建」建一个。", "No templates yet — use “+ New” on the left.")
									: t(
											"左边点一个模板就能改它的指令、工具白名单与模型。",
											"Pick a template on the left to edit its instructions, tool allowlist and model.",
										)}
							</p>
							<p className="agents-hint">
								{whitelist === false
									? "子代理跑起来之后，卡片会直接出现在对话下方（可就地看结果、可单独停掉）；这里只管「谁能被委派」，隔离由引擎的沙箱与审批决定。"
									: "子代理跑起来之后，卡片会直接出现在对话下方（带耗时 / token / 花费，可就地看结果、可单独停掉）；这里只管「谁能被委派、用什么工具」。"}
							</p>
						</div>
					)}
				</section>
			</div>
		</div>
	);
}
