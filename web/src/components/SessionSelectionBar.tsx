/**
 * 「已选 N 条 · 归档 · 删除 · ✕」—— 多选时挂在「项目管理」标题右边的那一条。
 *
 * 为什么要有它：批量操作的入口原来只有「右键落在选区上」。右键是个**隐式**动作 ——
 * 选完一批之后鼠标往往已经离开列表了，还得回去对准某一行再右键（用户 2026-10-29 提的）。
 *
 * 两处纪律跟右键菜单（`SessionBatchMenu`）完全一致，改一边记得改另一边：
 *   - 第一行先把「选了 N 条」写清楚（批量操作最怕不知道动了几个）；
 *   - 「删除」**两下**：第一下上膛、第二下真删，不用 `window.confirm`（能被整页屏蔽，
 *     屏蔽之后按钮就变成「点了没反应」，见 delete-session.ts 顶部那段）。
 *
 * 上膛状态放在**这个组件内部**：选区清空时整条会被卸载，状态跟着归零 ——
 * 不然「上膛了但没删」会留到下一次选中，一进来就是红的。
 */
import { useArmed } from "../use-armed.ts";
import { useT } from "../use-language.ts";

export function SessionSelectionBar({
	count,
	onArchive,
	onDelete,
	onClear,
}: {
	/** 选中条数（按钮文案、提示里都要说到具体几条） */
	count: number;
	onArchive: () => void;
	onDelete: () => void;
	onClear: () => void;
}) {
	const t = useT();
	const armed = useArmed();

	return (
		<span className="sidebar-selection">
			<span
				className="sidebar-selection-count"
				title={t(
					`已选中 ${count} 条会话（Shift 连选 · Ctrl/⌘ 加减选）`,
					`${count} session(s) selected (Shift for a range · Ctrl/⌘ to add or remove)`,
				)}
				aria-label={t(`已选中 ${count} 条会话`, `${count} session(s) selected`)}
				aria-live="polite"
			>
				{t(`已选 ${count} 条`, `${count} selected`)}
			</span>
			<button
				type="button"
				className="sidebar-selbtn"
				title={t(
					`把这 ${count} 条一起隐藏，可在「已归档」里找回或撤销`,
					`Hide all ${count}; find them under Archived or undo`,
				)}
				onClick={onArchive}
			>
				{t("归档", "Archive")}
			</button>
			<button
				type="button"
				className={`sidebar-selbtn sidebar-selbtn-danger${armed.armed ? " sidebar-selbtn-armed" : ""}`}
				title={
					armed.armed
						? t(
								"再点一次就真的删：文件改名成 .deleted-时间戳，能从磁盘恢复",
								"Click again to rename them to .deleted-<timestamp> (recoverable on disk)",
							)
						: t(`把选中的 ${count} 条一起删掉；第一下只是确认`, `Delete all ${count} — the first click only arms it`)
				}
				aria-label={
					armed.armed ? t("再点一次确认删除", "Click again to confirm delete") : t("删除选中的会话", "Delete selected")
				}
				onClick={() => armed.run(onDelete)}
			>
				{armed.armed ? t("确认删除", "Confirm") : t("删除", "Delete")}
			</button>
			<button
				type="button"
				className="sidebar-icon"
				title={t("取消选择", "Clear selection")}
				aria-label={t("取消选择", "Clear selection")}
				onClick={onClear}
			>
				✕
			</button>
		</span>
	);
}
