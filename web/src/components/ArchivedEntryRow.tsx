import { ArchiveIcon } from "./ArchiveIcon.tsx";

/**
 * 侧栏列表里的「已归档 · N」入口。
 *
 * 以前是标题栏上一枚 hover 才出现的小图标（🗄）：藏在角落、还得先发现它。
 * 现在**单独占一行**、跟项目文件夹同一层（就是列表最后一行）——
 * 归档是一块独立的内容，不该挂在「项目」标题上。
 *
 * 点它 → 整个列表区切到归档视图（那里能批量恢复 / 删除，左上角 ‹ 返回）。
 */
import { useT } from "../use-language.ts";
export function ArchivedEntryRow({
	total,
	active = false,
	onOpen,
}: {
	total: number;
	/** 归档视图是否正开着（开着时这一行高亮） */
	active?: boolean;
	onOpen: () => void;
}) {
	const t = useT();
	if (total <= 0) return null;
	return (
		<button
			type="button"
			className={`archived-row-entry${active ? " archived-row-entry-on" : ""}`}
			title={`已归档 · ${total}（点一下查看，可批量恢复 / 删除）`}
			onClick={onOpen}
		>
			{/* 跟项目行的 📁 同一个尺寸/位置；图标与「归档」按钮共用一份（ArchiveIcon） */}
			<span className="proj-chevron" aria-hidden="true">
				<ArchiveIcon className="archived-row-entry-icon" />
			</span>
			<span className="archived-row-entry-name">
				{t("已归档", "Archived")} · {total}
			</span>
		</button>
	);
}
