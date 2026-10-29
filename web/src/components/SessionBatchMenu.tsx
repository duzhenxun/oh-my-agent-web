/**
 * 多选之后的右键菜单：**批量归档 / 批量删除**。
 *
 * 为什么单开一份、不塞进 `SessionMenu`：那张菜单讲的是「**这一条**会话怎么了」
 * （置顶 / 重命名 / 分叉 / 新标签页…），多选状态下这些项要么无意义、要么得重新定义
 * （比如「重命名 12 条」）。混在一起会点错 —— 这里只放**对一批会话都成立**的动作。
 *
 * 交互纪律跟单条菜单一致：
 *   - 「删除」仍然**两下**（第一下上膛、第二下真删），不用 `window.confirm`（能被整页屏蔽）；
 *   - 菜单第一行把「选了 N 条」写清楚 —— 批量操作最怕的就是不知道会动到几条。
 *
 * 选择本身在 `Sidebar` 里：普通点击选一条，Shift 连选一段，Ctrl/⌘ 逐条加减选。
 * 右键落在「已经被选中的那几条」上才会走到这里（否则还是单条菜单）。
 */
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";
import { useArmed } from "../use-armed.ts";

export function SessionBatchMenu({
	point,
	anchor,
	count,
	onArchive,
	onDelete,
	onClear,
	onClose,
}: {
	/** 右键位置（批量菜单永远跟着鼠标弹：它不属于某一行，而属于这一片选区） */
	point?: MenuPoint | null;
	/** 兜底锚点（目前不传；留着跟单条菜单同一个签名） */
	anchor?: HTMLElement | null;
	/** 选中的条数（写进菜单头和按钮文案，避免「不知道动了几个」） */
	count: number;
	onArchive: () => void;
	onDelete: () => void;
	/** 取消选择（菜单里也给一个出口，鼠标用户不必去找空白处点一下） */
	onClear: () => void;
	onClose: () => void;
}) {
	const t = useT();
	const act = (run: () => void) => () => {
		onClose();
		run();
	};
	const del = useArmed();

	return (
		<ProjectMenuPopover point={point} anchor={anchor} className="pi-menu" closeOnLeave onClose={onClose}>
			<div className="pi-menu-head">
				{t(`已选 ${count} 条`, `${count} selected`)}
				<div className="pi-menu-head-hint">{t("Shift 连选 · Ctrl/⌘ 加减选", "Shift for a range · Ctrl/⌘ to add or remove")}</div>
			</div>
			<button
				type="button"
				className="proj-menu-item"
				title={t(`把这 ${count} 条一起隐藏，可在「已归档」里找回或撤销`, `Hide all ${count}; find them under Archived or undo`)}
				onClick={act(onArchive)}
			>
				🗄 {t(`归档这 ${count} 条`, `Archive ${count}`)}
			</button>
			<button
				type="button"
				className={`proj-menu-item proj-menu-danger${del.armed ? " proj-menu-item-armed" : ""}`}
				title={
					del.armed
						? t("再点一次就全部改名成 .deleted-时间戳（可从磁盘恢复）", "Click again to rename them all to .deleted-<timestamp>")
						: t(`把选中的 ${count} 条一起删掉；第一下只是确认`, `Delete all ${count} — the first click only arms it`)
				}
				aria-label={del.armed ? t("再点一次确认删除", "Click again to confirm delete") : t("删除选中的会话", "Delete selected")}
				onClick={() =>
					del.run(() => {
						onClose();
						onDelete();
					})
				}
			>
				{del.armed ? t(`🗑 再点一次删除这 ${count} 条`, `🗑 Click again to delete ${count}`) : t(`🗑 删除这 ${count} 条`, `🗑 Delete ${count}`)}
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onClear)}>
				✕ {t("取消选择", "Clear selection")}
			</button>
		</ProjectMenuPopover>
	);
}
