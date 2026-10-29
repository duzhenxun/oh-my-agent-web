import { sortedFiles, withThousands, type Preview, type Skill } from "../skills-view.ts";
import { useT } from "../use-language.ts";

/** 右栏详情：状态 + 描述 + 文件列表 + 预览。启停走改名 SKILL.md，删除是整目录。 */
export function SkillDetail({
	skill,
	detail,
	busy,
	confirmRemove,
	onFile,
	onToggle,
	onRemove,
}: {
	skill: Skill;
	detail: { path: string; preview: Preview | null } | null;
	busy: boolean;
	confirmRemove: string | null;
	onFile: (path: string) => void;
	onToggle: () => void;
	onRemove: () => void;
}) {
	const t = useT();
	const files = sortedFiles(skill.files);
	return (
		<>
			<div className="skills-detail-head">
				<span className={`mcp-badge${skill.enabled ? " skill-badge-on" : ""}`}>
					{skill.enabled ? t("已启用", "Enabled") : t("已停用", "Disabled")}
				</span>
				<span className="mcp-detail-name">{skill.name}</span>
				<span className="topbar-spacer" />
				<button type="button" className="btn btn-tiny" disabled={busy} onClick={onToggle}>
					{skill.enabled ? t("停用", "Disable") : t("启用", "Enable")}
				</button>
				<button
					type="button"
					className={`btn btn-tiny${confirmRemove === skill.id ? " btn-danger" : ""}`}
					disabled={busy}
					onClick={onRemove}
					title={t("整目录删除（含 scripts / references）", "Delete the whole folder (scripts / references included)")}
				>
					{confirmRemove === skill.id ? t("确认删除", "Confirm delete") : t("删除", "Delete")}
				</button>
			</div>

			<div className="skills-detail-meta">
				<span className="skills-label">{t("目录", "Folder")}</span>
				<span className="mono skill-slug">{skill.id}</span>
				<span className="skills-label">{t("文件", "File")}</span>
				<span className="side-panel-count">{files.length} 个</span>
			</div>

			{skill.description !== "" ? <p className="skills-desc">{skill.description}</p> : null}

			<div className="skills-file-chips">
				{files.map((file) => (
					<button
						type="button"
						key={file}
						className={`skills-file${detail?.path === file ? " skills-file-on" : ""}`}
						onClick={() => onFile(file)}
					>
						{file}
					</button>
				))}
			</div>

			{detail === null ? (
				<div className="side-panel-hint">
					{t("点上面的文件名看内容。", "Click a file name above to see its content.")}
				</div>
			) : detail.preview === null ? (
				<div className="side-panel-hint">{t("读取中…", "Loading…")}</div>
			) : detail.preview.binary ? (
				<div className="side-panel-hint">
					{t("这是二进制文件，不能预览", "This is a binary file and cannot be previewed")}
				</div>
			) : (
				<>
					<span className="side-panel-count mono">
						{detail.path} · {withThousands(detail.preview.bytes)} 字节
					</span>
					<pre className="skills-preview mono">{detail.preview.text}</pre>
				</>
			)}
		</>
	);
}
