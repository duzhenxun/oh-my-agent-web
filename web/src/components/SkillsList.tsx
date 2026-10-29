import type { Skill } from "../skills-view.ts";
import { useT } from "../use-language.ts";

/**
 * 技能面板的**左栏**：三个页签（全部 / 启用 / 禁用）+ 搜索 + 多选批量操作 + 列表。
 *
 * 从 `SkillsPanel.tsx` 拆出来（400 行护栏）。这一栏的职责很窄：回答「有哪些技能、开没开」，
 * 并把「看哪一个 / 勾了哪些 / 要批量做什么」报给面板 —— 右栏那三种内容与它无关。
 *
 * 两个约束值得写下来：
 *   - **搜索只在当前页签里搜**：「在启用列表里搜 x」跟「在所有技能里搜 x」是两件事；
 *   - **换页签就清空勾选**：看不见的条目被勾着，接着点「批量删除」是很吓人的事。
 */

type SkillTab = "all" | "enabled" | "disabled";

export function SkillsList({
	skills,
	tab,
	onTab,
	query,
	onQuery,
	byTab,
	shown,
	selected,
	selecting,
	picked,
	onPicked,
	onSelecting,
	busy,
	confirmRemove,
	installOpen,
	onOpenInstall,
	onOpenDetail,
	onBatchEnabled,
	onBatchRemove,
	onEnableAll,
}: {
	skills: Skill[];
	tab: SkillTab;
	onTab: (tab: SkillTab) => void;
	query: string;
	onQuery: (query: string) => void;
	/** 页签过滤后的集合（计数与「全启用」用） */
	byTab: Skill[];
	/** 再叠加搜索后的集合（列表里真正显示的那些） */
	shown: Skill[];
	selected: string | null;
	selecting: boolean;
	picked: Set<string>;
	onPicked: (next: Set<string>) => void;
	onSelecting: (next: boolean) => void;
	busy: boolean;
	/** "batch" = 批量删除的第二步确认 */
	confirmRemove: string | null;
	installOpen: boolean;
	onOpenInstall: () => void;
	onOpenDetail: (skill: Skill) => void;
	onBatchEnabled: (enabled: boolean) => void;
	onBatchRemove: () => void;
	onEnableAll: () => void;
}) {
	const t = useT();
	const toggle = (id: string) => {
		const next = new Set(picked);
		if (next.has(id)) next.delete(id);
		else next.add(id);
		onPicked(next);
	};
	const enabledCount = skills.filter((skill) => skill.enabled).length;

	return (
		<div className="skills-list-col">
			{/* 三个页签：先说「看哪一类」，搜索只在这一类里找 */}
			<div className="skills-tabbar" role="tablist" aria-label={t("技能筛选", "Skill filter")}>
				{[
					{ key: "all" as const, label: t("全部", "All"), count: skills.length },
					{ key: "enabled" as const, label: t("启用", "Enabled"), count: enabledCount },
					{ key: "disabled" as const, label: t("禁用", "Disabled"), count: skills.length - enabledCount },
				].map((item) => (
					<button
						type="button"
						key={item.key}
						role="tab"
						aria-selected={tab === item.key}
						className={`skills-tab${tab === item.key ? " skills-tab-on" : ""}`}
						onClick={() => onTab(item.key)}
					>
						{item.label}
						<span className="skills-tab-count">{item.count}</span>
					</button>
				))}
			</div>

			<input
				className="skills-input skills-search"
				value={query}
				placeholder={
					tab === "all"
						? t("搜索已安装的技能…", "Search installed skills…")
						: t(
								`在「${tab === "enabled" ? "启用" : "禁用"}」里搜索…`,
								`Search among ${tab === "enabled" ? "enabled" : "disabled"} skills…`,
							)
				}
				onChange={(event) => onQuery(event.target.value)}
				aria-label={t("搜索已安装的技能", "Search installed skills")}
			/>

			<div className="skills-list-head">
				<span>
					{selecting
						? t(`已选 ${picked.size}`, `${picked.size} selected`)
						: tab === "all"
							? t("已安装", "Installed")
							: tab === "enabled"
								? t("已启用", "Enabled")
								: t("已禁用", "Disabled")}
				</span>
				<span className="side-panel-count">
					{query.trim() === "" ? `${shown.length} 个` : `匹配 ${shown.length} / ${byTab.length}`}
				</span>
				<button
					type="button"
					className={`skills-select-toggle${selecting ? " skills-select-toggle-on" : ""}`}
					onClick={() => onSelecting(!selecting)}
					title={
						selecting
							? t("退出多选", "Leave multi-select")
							: t("多选：可批量启用 / 停用 / 删除", "Multi-select: enable / disable / delete in bulk")
					}
				>
					{selecting ? t("完成", "Done") : t("多选", "Multi-select")}
				</button>
			</div>

			<div className="skills-list-scroll">
				{shown.length === 0 ? (
					<div className="side-panel-count">
						{skills.length === 0
							? t("还没有技能，点下面「安装技能」", "No skills yet — use “Install skill” below")
							: tab === "disabled"
								? "没有禁用的技能"
								: tab === "enabled"
									? "没有启用的技能"
									: "没有匹配的技能"}
					</div>
				) : (
					shown.map((skill) => {
						const checked = picked.has(skill.id);
						return (
							<button
								type="button"
								key={skill.id}
								className={`skill-item${selecting ? " skill-item-pick" : ""}${checked ? " skill-item-picked" : ""}${selected === skill.id && !selecting ? " skill-item-on" : ""}${skill.enabled ? "" : " skill-item-off"}`}
								onClick={() => (selecting ? toggle(skill.id) : onOpenDetail(skill))}
								title={selecting ? `选择 ${skill.name}` : skill.description}
							>
								{selecting ? (
									<input
										type="checkbox"
										checked={checked}
										onChange={() => undefined}
										tabIndex={-1}
										aria-label={`选择 ${skill.name}`}
									/>
								) : (
									<span className={`mcp-dot${skill.enabled ? " mcp-dot-on" : ""}`} aria-hidden="true" />
								)}
								<span className="skill-item-name">{skill.name}</span>
							</button>
						);
					})
				)}
			</div>

			{selecting ? (
				<div className="skills-batch">
					<div className="skills-batch-row">
						<button
							type="button"
							className="btn btn-tiny"
							disabled={shown.length === 0}
							onClick={() =>
								onPicked(
									shown.every((skill) => picked.has(skill.id)) ? new Set() : new Set(shown.map((skill) => skill.id)),
								)
							}
						>
							{shown.length > 0 && shown.every((skill) => picked.has(skill.id))
								? t("全不选", "Select none")
								: `${t("全选", "Select all")} ${shown.length}`}
						</button>
						<span className="topbar-spacer" />
						<button
							type="button"
							className="btn btn-tiny"
							disabled={busy || picked.size === 0}
							onClick={() => onPicked(new Set())}
						>
							清空
						</button>
					</div>
					<div className="skills-batch-row">
						<button
							type="button"
							className="btn btn-tiny"
							disabled={busy || picked.size === 0}
							onClick={() => onBatchEnabled(true)}
							title={t("把勾选的技能全部启用", "Enable every ticked skill")}
						>
							批量启用
						</button>
						<button
							type="button"
							className="btn btn-tiny"
							disabled={busy || picked.size === 0}
							onClick={() => onBatchEnabled(false)}
							title={t("把勾选的技能全部停用（改名 SKILL.md）", "Disable every ticked skill (renames SKILL.md)")}
						>
							批量禁用
						</button>
						<button
							type="button"
							className={`btn btn-tiny${confirmRemove === "batch" ? " btn-danger" : ""}`}
							disabled={busy || picked.size === 0}
							onClick={onBatchRemove}
							title={t("整目录删除，不可恢复", "Delete the whole folder — this cannot be undone")}
						>
							{confirmRemove === "batch" ? `确认删除 ${picked.size} 个` : "批量删除"}
						</button>
					</div>
				</div>
			) : (
				<div className="skills-left-actions">
					<button type="button" className={`btn btn-tiny${installOpen ? " btn-on" : ""}`} onClick={onOpenInstall}>
						＋ {t("安装技能", "Install skill")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						disabled={busy || byTab.every((skill) => skill.enabled)}
						onClick={onEnableAll}
						title={t("把当前页签里停用的技能全部启用", "Enable all disabled skills in this tab")}
					>
						{t("全启用", "Enable all")}
					</button>
				</div>
			)}
		</div>
	);
}
