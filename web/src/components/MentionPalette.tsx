/**
 * 「@ 提及」面板（在输入框上方弹出，`@` 后面开始打字时出现）。
 *
 * 结构与交互跟斜杠命令面板（`SlashPalette`）**刻意一致**：↑↓ 选择、Enter/Tab 插入、Esc 关掉、
 * 鼠标点也行 —— 两个浮层出现在同一个位置，手感和快捷键不该有两套。
 * 键盘事件归 Composer 管（它才是 textarea 的 owner），这里只负责画 + 报告「点了第几条」。
 */
import { useEffect, useRef } from "react";
import { fileTypeOf } from "../file-type.ts";
import { dirname, tailSegments } from "../path-utils.ts";
import { useT } from "../use-language.ts";
import type { MentionRow } from "../at-mentions.ts";

/** 分组标题：面板里靠它把「挑选入口 / 最近 / 搜索结果」分开，不然三拨东西混成一列 */
const GROUP_LABEL: Record<MentionRow["group"], { zh: string; en: string } | null> = {
	browse: { zh: "添加", en: "Add" },
	recent: { zh: "最近用过", en: "Recent" },
	result: null,
};

export function MentionPalette({
	rows,
	active,
	loading = false,
	error = null,
	onPick,
	onHover,
	onBrowse,
}: {
	rows: MentionRow[];
	/** 当前高亮的第几条（键盘选择） */
	active: number;
	loading?: boolean;
	/** 搜索失败的一句话（没工作区 / 接口报错）；有它就顶替「没有匹配」的提示 */
	error?: string | null;
	/** 选中一个文件/最近项（面板不负责改草稿，composer 那边统一处理光标与替换） */
	onPick: (row: Extract<MentionRow, { kind: "file" }>) => void;
	onHover: (index: number) => void;
	/** 选中「文件和文件夹 / 文件夹」：让服务端弹原生选择框 */
	onBrowse: (target: "file" | "dir") => void;
}) {
	const t = useT();
	const listRef = useRef<HTMLDivElement | null>(null);

	// 键盘移动时把高亮那条滚进视野（面板最多显示 ~8 条，选到底部不该被裁掉）
	useEffect(() => {
		const row = listRef.current?.querySelector<HTMLElement>(`[data-index="${active}"]`);
		row?.scrollIntoView({ block: "nearest" });
	}, [active]);

	let lastGroup: MentionRow["group"] | null = null;

	return (
		<div className="slash-panel mention-panel" role="listbox" aria-label={t("@ 提及文件", "Mention a file")}>
			<div className="slash-head">
				<span>{t("↑↓ 选择 · Enter/Tab 插入 · Esc 关闭", "↑↓ to choose · Enter/Tab to insert · Esc to close")}</span>
				<span className="slash-count">
					{loading ? t("搜索中…", "Searching…") : `${rows.length} ${t("项", "items")}`}
				</span>
			</div>
			<div className="slash-list" ref={listRef}>
				{rows.map((row, index) => {
					const heading = row.group === lastGroup ? null : GROUP_LABEL[row.group];
					lastGroup = row.group;
					return (
						<div key={row.kind === "browse" ? `browse:${row.target}` : `${row.group}:${row.path}`}>
							{heading ? <div className="mention-group">{t(heading.zh, heading.en)}</div> : null}
							<button
								type="button"
								data-index={index}
								role="option"
								aria-selected={index === active}
								className={`slash-row mention-row${index === active ? " slash-row-on" : ""}`}
								title={row.kind === "browse" ? undefined : `@${row.path}`}
								onMouseEnter={() => onHover(index)}
								onMouseDown={(event) => {
									// 保住 textarea 的焦点：插入之后光标要接着停在草稿里
									event.preventDefault();
									if (row.kind === "browse") onBrowse(row.target);
									else onPick(row);
								}}
							>
								{row.kind === "browse" ? (
									<>
										<span className="mention-icon" aria-hidden="true">
											{row.target === "file" ? "📄" : "📁"}
										</span>
										<span className="mention-name">
											{row.target === "file" ? t("文件和文件夹", "Files and folders") : t("文件夹", "Folder")}
										</span>
										<span className="mention-path">
											{row.target === "file"
												? t("从这台电脑选择", "Pick from this computer")
												: t("选择一个文件夹", "Pick a folder")}
										</span>
									</>
								) : (
									<>
										<FileBadge name={row.name} isDir={row.isDir} />
										<span className="mention-name mono">{row.name}</span>
										{/* 路径只给「在哪儿」：项目深的时候前面几段省略，别把文件名挤掉 */}
										<span className="mention-path">{tailSegments(dirname(row.path), 3)}</span>
									</>
								)}
							</button>
						</div>
					);
				})}
				{rows.length === 0 ? (
					<div className="slash-empty">
						{error ?? (loading ? t("搜索中…", "Searching…") : t("没有匹配的文件", "No matching files"))}
					</div>
				) : error ? (
					<div className="slash-empty">{error}</div>
				) : null}
			</div>
		</div>
	);
}

/** 行首那个类型小标：复用文件树的 `.filetree-type` + `.filetype-<tone>`（同一套颜色，不另起一套） */
function FileBadge({ name, isDir }: { name: string; isDir: boolean }) {
	if (isDir) {
		return (
			<span className="mention-icon" aria-hidden="true">
				📁
			</span>
		);
	}
	const badge = fileTypeOf(name);
	if (!badge) {
		return (
			<span className="mention-icon" aria-hidden="true">
				·
			</span>
		);
	}
	return (
		<span className={`filetree-type filetype-${badge.tone}`} aria-hidden="true">
			{badge.label}
		</span>
	);
}
