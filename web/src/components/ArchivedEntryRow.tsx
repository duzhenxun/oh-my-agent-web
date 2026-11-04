import { ArchiveIcon } from "./ArchiveIcon.tsx";
import { useT } from "../use-language.ts";

/**
 * 侧栏列表里的「已归档 · N」入口（列表最后一行，跟项目文件夹同一层）。
 *
 * 点它就是**就地展开 / 收起**归档的会话（清单直接画在这一行下面，见 ArchivedSessions）。
 * 以前点它是切到一张独立视图：整个项目列表让位、左上角多一颗 ‹ 返回，进来还得分组
 * 一个个点开才看得见 —— 太绕，改成「点一下直接展开」。
 */
export function ArchivedEntryRow({
	total,
	open,
	onToggle,
}: {
	total: number;
	/** 归档清单是否正展开着（只影响无障碍状态与提示文字） */
	open: boolean;
	onToggle: () => void;
}) {
	const t = useT();
	if (total <= 0) return null;
	return (
		<button
			type="button"
			className="archived-row-entry"
			aria-expanded={open}
			title={
				open
					? t("收起归档的会话", "Collapse archived sessions")
					: t(
							`已归档 · ${total}（点一下展开，可恢复 / 删除）`,
							`Archived · ${total} (click to expand; restore or delete)`,
						)
			}
			onClick={onToggle}
		>
				{/* 这里**不画折叠三角**（用户 2026-11-03）：这一行是「另一块清单」的入口，
			 * 不是项目那种可折叠的文件夹；三角留在名字左边反而像个没对齐的子弹头。 */}
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
