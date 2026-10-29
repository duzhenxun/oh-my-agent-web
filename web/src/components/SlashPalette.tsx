/**
 * 斜杠命令面板（在输入框上方弹出，`/` 开头时出现）。
 *
 * 交互对齐终端里的补全：↑↓ 选择、Enter/Tab 补全、Esc 关掉、鼠标点也行。
 * 键盘事件由 Composer 接管（它才是 textarea 的 owner），这里只负责画 + 报告"点了第几条"。
 */
import { useEffect, useRef } from "react";
import { useLanguage, useT } from "../use-language.ts";
import { commandUsage, type SlashCommand } from "../slash-commands.ts";

export function SlashPalette({
	commands,
	active,
	onPick,
	onHover,
	skills = null,
}: {
	commands: SlashCommand[];
	/** 当前高亮的第几条（键盘选择） */
	active: number;
	onPick: (command: SlashCommand) => void;
	onHover: (index: number) => void;
	/** 技能模式：`/skill ` 之后列已安装的技能（由 Composer 传进来） */
	skills?: { id: string; name: string; description: string; enabled: boolean }[] | null;
}) {
	const t = useT();
	const { language } = useLanguage();
	const listRef = useRef<HTMLDivElement | null>(null);

	// 键盘移动时把高亮那条滚进视野（面板最多显示 ~8 条，选到底部不该被裁掉）
	useEffect(() => {
		const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [active]);

	return (
		<div className="slash-panel" role="listbox" aria-label={t("斜杠命令", "Slash commands")}>
			<div className="slash-head">
				<span>
					{skills === null
						? t("↑↓ 选择 · Enter/Tab 补全 · Esc 关闭", "↑↓ to choose · Enter/Tab to complete · Esc to close")
						: t("↑↓ 选择技能 · Enter/Tab 插入 · Esc 关闭", "↑↓ to choose a skill · Enter/Tab to insert · Esc to close")}
				</span>
				<span className="slash-count">
					{skills === null ? (
						<>
							{commands.length} {t("条命令", "commands")}
						</>
					) : (
						<>
							{skills.length} {t("个技能", "skills")}
						</>
					)}
				</span>
			</div>
			<div className="slash-list" ref={listRef}>
				{skills !== null
					? skills.map((skill, index) => (
							<button
								type="button"
								key={skill.id}
								data-index={index}
								role="option"
								aria-selected={index === active}
								className={`slash-row${index === active ? " slash-row-on" : ""}`}
								onMouseEnter={() => onHover(index)}
								onMouseDown={(event) => {
									event.preventDefault();
									onPick({ name: `skill:${skill.name}`, kind: "agent", description: skill.description });
								}}
							>
								<span className="slash-name mono">{`/skill:${skill.name}`}</span>
								<span className={`slash-kind${skill.enabled ? "" : " slash-kind-off"}`}>
									{skill.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}
								</span>
								<span className="slash-desc">{skill.description || skill.name}</span>
							</button>
						))
					: null}
				{skills === null && commands.length === 0 ? (
					<div className="slash-empty">{t("没有匹配的命令", "No matching commands")}</div>
				) : null}
				{skills !== null && skills.length === 0 ? (
					<div className="slash-empty">{t("没有匹配的技能", "No matching skills")}</div>
				) : null}
				{(skills === null ? commands : []).map((command, index) => (
					<button
						type="button"
						key={command.name}
						data-index={index}
						role="option"
						aria-selected={index === active}
						className={`slash-row${index === active ? " slash-row-on" : ""}`}
						onMouseEnter={() => onHover(index)}
						// 用 mousedown：click 之前 textarea 会先失焦，光标位置就没了
						onMouseDown={(event) => {
							event.preventDefault();
							onPick(command);
						}}
					>
						<span className="slash-name mono">{commandUsage(command, language === "en")}</span>
						<span className={`slash-kind${command.kind === "agent" ? " slash-kind-agent" : ""}`}>
							{command.kind === "agent" ? t("发给 Agent", "Sent to agent") : t("本地", "Runs here")}
						</span>
						<span className="slash-desc">{t(command.description)}</span>
					</button>
				))}
			</div>
		</div>
	);
}
