/**
 * 多选之后的右键菜单：**批量归档 / 批量删除**。
 *
 * 为什么单开一份、不塞进 `SessionMenu`：那张菜单讲的是「**这一条**会话怎么了」
 * （置顶 / 重命名 / 分叉 / 新标签页…），多选状态下这些项要么无意义、要么得重新定义
 * （比如「重命名 12 条」）。混在一起会点错 —— 这里只放**对一批会话都成立**的动作。
 *
 * 交互纪律跟单条菜单一致：
 *   - 「删除」仍然**两下**（第一下上膛、第二下真删），不用 `window.confirm`（能被整页屏蔽）；
 *   - 条数写在**按钮文案**里（「归档这 7 条」）—— 抬头那行「已选 N 条 + Shift/Ctrl 提示」
 *     已经去掉了（用户 2026-10-29：「上面这段文案不要」）：条数在侧栏抬头那颗胶囊里一直看得见，
 *     再在菜单里重复一遍只是多吃两行高度。
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
	/** 选中的条数（只用于按钮文案：「归档这 N 条」） */
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
			<button
				type="button"
				className="proj-menu-item"
				title={t(
					`把这 ${count} 条一起隐藏，可在「已归档」里找回或撤销`,
					`Hide all ${count}; find them under Archived or undo`,
				)}
				onClick={act(onArchive)}
			>
				🗄 {t(`归档这 ${count} 条`, `Archive ${count}`)}
			</button>
			<button
				type="button"
				className={`proj-menu-item proj-menu-danger${del.armed ? " proj-menu-item-armed" : ""}`}
				title={
					del.armed
						? t(
								`再点一次就真删这 ${count} 个会话文件：不可恢复`,
								`Click again to permanently delete these ${count} session file(s) — not recoverable`,
							)
						: t(
								`把选中的 ${count} 条连同磁盘上的文件一起删掉（不可恢复）；第一下只是确认`,
								`Permanently delete the selected ${count} including their files — first click only arms it`,
							)
				}
				aria-label={
					del.armed
						? t("再点一次确认彻底删除", "Click again to delete permanently")
						: t("彻底删除选中的会话", "Permanently delete selected sessions")
				}
				onClick={() =>
					del.run(() => {
						onClose();
						onDelete();
					})
				}
			>
				{del.armed
					? t(`🧨 再点一次彻底删除这 ${count} 条`, `🧨 Click again to purge ${count}`)
					: t(`🧨 彻底删除这 ${count} 条`, `🧨 Purge ${count}`)}
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onClear)}>
				✕ {t("取消选择", "Clear selection")}
			</button>
		</ProjectMenuPopover>
	);
}
