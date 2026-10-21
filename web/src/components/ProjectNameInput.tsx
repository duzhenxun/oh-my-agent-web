/**
 * 项目名的就地改名输入框（从 Sidebar 抽出来：ADR-0010 的 400 行护栏）。
 *
 * 行为：打开就全选，回车保存 / Esc 取消 / 失焦也保存；打字或点击都不许
 * 连带把 `<details>` 收起展开（否则输入框会被卸载，改名一半就没了）。
 */
export function ProjectNameInput({
	value,
	onChange,
	onCommit,
	onCancel,
}: {
	value: string;
	onChange: (next: string) => void;
	onCommit: () => void;
	onCancel: () => void;
}) {
	return (
		<input
			className="proj-name proj-name-input"
			value={value}
			autoFocus
			onFocus={(event) => event.currentTarget.select()}
			onChange={(event) => onChange(event.target.value)}
			onClick={(event) => event.stopPropagation()}
			onDoubleClick={(event) => event.stopPropagation()}
			onKeyDown={(event) => {
				event.stopPropagation();
				if (event.key === "Enter") {
					event.preventDefault();
					onCommit();
				} else if (event.key === "Escape") {
					event.preventDefault();
					onCancel();
				}
			}}
			onBlur={onCommit}
			title="回车保存 · Esc 取消（只改显示名，不动目录）"
		/>
	);
}
