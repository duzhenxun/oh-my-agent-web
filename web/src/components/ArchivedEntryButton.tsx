/**
 * 侧栏标题栏上的「已归档」入口（🗄）。
 *
 * 平时看不见，鼠标移到标题栏上才出现（触摸屏常显）—— 归档是低频动作，
 * 不该常占一行位置（原来那条「🗄 已归档 · N」整条被挪走了）。
 */
export function ArchivedEntryButton({
	total,
	active,
	onToggle,
}: {
	total: number;
	/** 归档视图是否正开着（开着时高亮、且一直可见，再点一下就是关掉） */
	active: boolean;
	onToggle: () => void;
}) {
	if (total <= 0) return null;
	return (
		<button
			type="button"
			className={`archived-entry-icon${active ? " archived-entry-icon-on" : ""}`}
			title={active ? `已关掉？点一下收起「已归档 · ${total}」` : `已归档 · ${total}（点一下查看，可批量恢复 / 删除）`}
			onClick={onToggle}
		>
			🗄
		</button>
	);
}
