/**
 * 「已归档」清单：**就地展开在侧栏列表的最后一行下面**（入口见 ArchivedEntryRow）。
 *
 * 以前点「已归档 · N」是切到一张独立视图：整个项目列表让位、左上角一颗 ‹ 返回，
 * 进来还得分组一个个点开才看得见会话 —— 用户嫌太麻烦，要「点一下直接展开」。
 * 所以现在分组**默认全展开**（想省地方再点组标题收起）。
 *
 * 多选方式**跟项目管理那一栏完全一致**（用户 2026-11-03）：
 *   - 点一下 = 打开这条会话；
 *   - **Shift** = 从锚点连选一段；
 *   - **Ctrl / ⌘** = 这一条加减选。
 * 所以每行不再挂勾选框、也不再挂「恢复」按钮 —— 勾选框和「全选 / 恢复」两排按钮
 * 把本来就不宽的行挤成三块，反而看不出会话名（用户 2026-11-03 的原话：全不要）。
 * 选中之后，顶部那条「已选 N 条 · 恢复 · 彻底删除 · ✕」才是批量操作的入口。
 *
 * 归档只是从主列表隐藏（settings.sessionPrefs.archived），数据仍在磁盘 —— 所以这里
 * 既能「恢复」，也能**批量选中后批量删除**（删除 = 真删会话文件，不可恢复）。
 */
import { useRef, useState } from "react";
import { deleteSessions } from "../delete-session.ts";
import { useArmed } from "../use-armed.ts";
import { rangeSelection, toggleSelection } from "../session-selection.ts";
import { ProjectFolderIcon } from "./ProjectFolderIcon.tsx";
import { useT } from "../use-language.ts";

export function ArchivedSessions({
	groups,
	onOpen,
	onRestore,
	onRestoreMany,
}: {
	groups: { name: string; items: { id: string; title: string }[] }[];
	onOpen: (id: string) => void;
	/** 恢复一条 */
	onRestore: (id: string) => void;
	/**
	 * 批量恢复：**一次请求**改整份 archived 列表。
	 * 以前是 for 循环调 onRestore，每条请求都基于同一份旧 archived 计算，
	 * 服务端又是整表覆盖 → 只有最后一条生效（选 5 条只回来 1 条）。
	 */
	onRestoreMany: (ids: string[]) => void;
}) {
	const t = useT();
	const total = groups.reduce((sum, group) => sum + group.items.length, 0);
	/** 选中的会话 id（顺序 = 点选的先后；只在「看得见的行」上结算，见 `visibleIds`） */
	const [selected, setSelected] = useState<string[]>([]);
	/** Shift 连选的锚点：最后一次**不带修饰键**或 Ctrl 点中的那一条 */
	const anchor = useRef<string | null>(null);
	/**
	 * **展开的**项目分组（默认一个都不展开，用户 2026-11-03：「点开已归档时只看到相关的项目，默认不要展开」）。
	 *
	 * 点「已归档 · N」先看到的是**项目清单**（`项目 · N`）；想看某个项目的归档会话再点它。
	 * 存「展开的」而不是「收起的」：以后新增的归档项目天然也是收着的 —— 展开一次不会越点越长。
	 */
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	/**
	 * 收起一个组时，把它底下的选中项一起剔掉。
	 *
	 * 不剔的话「已选 3 条」里可能有两条已经收进看不见的组里了 ——
	 * 那时候点「彻底删除」就删掉了眼睛没看着的东西（跟主列表的 pruneSelection 同一个道理）。
	 */
	const toggleExpanded = (name: string, ids: string[]) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(name)) {
				next.delete(name);
				// 收起来 = 里面的行看不见了：选中项一起剔掉，免得「已选 N 条」里有过会儿删不掉的幽灵
				const drop = new Set(ids);
				setSelected((currentSelected) => currentSelected.filter((id) => !drop.has(id)));
			} else {
				next.add(name);
			}
			return next;
		});
	const isExpanded = (name: string) => expanded.has(name);
	/** 眼睛看得见的行（从上到下）：Shift 连选只在这条序列上切一段 */
	const visibleIds = groups.flatMap((group) => (isExpanded(group.name) ? group.items.map((item) => item.id) : []));

	/**
	 * 删除选中 = **两下**：第一下上膛（按钮变红底、文案换成「再点一次」），第二下才删。
	 * 不用 `window.confirm`（能被浏览器整页屏蔽，点了等于没点，见 delete-session.ts）。
	 */
	const del = useArmed();
	const removeSelected = () => {
		const ids = [...selected];
		if (ids.length === 0) return;
		del.run(() => {
			deleteSessions(ids, "选中的归档会话");
			setSelected([]);
			anchor.current = null;
		});
	};

	const restoreSelected = () => {
		const ids = [...selected];
		if (ids.length === 0) return;
		if (ids.length === 1) onRestore(ids[0] as string);
		else onRestoreMany(ids);
		setSelected([]);
		anchor.current = null;
	};

	return (
		<div className="archived-inline">
			{/*
			 * 批量操作条：**只在选着东西时出现**，样式跟「项目管理」抬头那条选择条同一套
			 * （同一件事在两处不该长两个样）。没有「全选」了 —— 要全选用 Shift 从第一行拉到最末一行。
			 */}
			{selected.length > 0 ? (
				<div className="archived-inline-bar sidebar-selection">
					<span className="sidebar-selection-count" aria-live="polite">
						{t(`已选 ${selected.length} 条`, `${selected.length} selected`)}
					</span>
					<button
						type="button"
						className="sidebar-selbtn"
						title={t("把这些恢复回主列表", "Restore these back to the main list")}
						onClick={restoreSelected}
					>
						{t("恢复", "Restore")}
					</button>
					<button
						type="button"
						className={`sidebar-selbtn sidebar-selbtn-danger${del.armed ? " sidebar-selbtn-armed" : ""}`}
						title={
							del.armed
								? t("再点一次就真删这些会话文件：不可恢复", "Click again to permanently delete these session files")
								: t(
										"把选中的这些连同磁盘上的文件一起删掉（不可恢复）；第一下只是确认",
										"Permanently delete the selected sessions including their files — first click only arms it",
									)
						}
						onClick={removeSelected}
					>
						{del.armed ? t("确认彻底删除", "Confirm purge") : t("彻底删除", "Purge")}
					</button>
					<button
						type="button"
						className="sidebar-icon"
						title={t("取消选择", "Clear selection")}
						aria-label={t("取消选择", "Clear selection")}
						onClick={() => {
							setSelected([]);
							anchor.current = null;
						}}
					>
						✕
					</button>
				</div>
			) : null}

			<div className="archived-view-list archived-inline-list">
				{groups.map((group) => (
					<div className="archived-group" key={group.name}>
						<div className="archived-group-title">
							{/* 整行可点：收起 / 展开这个项目的归档（**默认展开**）；三角与侧栏项目行同一套 */}
							<button
								type="button"
								className="archived-group-toggle"
								onClick={() =>
									toggleExpanded(
										group.name,
										group.items.map((item) => item.id),
									)
								}
								aria-expanded={isExpanded(group.name)}
								title={
									isExpanded(group.name)
										? t("收起这个项目的归档", "Collapse this project's archive")
										: t("展开这个项目的归档", "Expand this project's archive")
								}
							>
								<span
									className={`sidebar-title-caret${isExpanded(group.name) ? " sidebar-title-caret-open" : ""}`}
									aria-hidden="true"
								/>
								{/* 和主列表项目行同一个图标（归档组是「收起来」的项目，所以用合着的文件夹） */}
								<ProjectFolderIcon open={false} />
								<span className="archived-group-name">
									{group.name} · {group.items.length}
								</span>
							</button>
						</div>
						{(isExpanded(group.name) ? group.items : []).map((item) => (
							<button
								type="button"
								// 选中态直接挂在行上：不再有勾选框，整行底色就是「这条选上了」
								className={`archived-open${selected.includes(item.id) ? " archived-row-on" : ""}`}
								key={item.id}
								title={t(
									`点一下选中 · Shift 连选 · Ctrl/⌘ 加减选 · 双击打开\n${item.id}`,
									`Click to select · Shift for a range · Ctrl/⌘ to add or remove · Double-click to open\n${item.id}`,
								)}
								onClick={(event) => {
									// Shift：从锚点连选一段
									if (event.shiftKey) {
										setSelected(rangeSelection(visibleIds, anchor.current, item.id));
										return;
									}
									// Ctrl / ⌘：这一条加减选
									if (event.ctrlKey || event.metaKey) {
										setSelected(toggleSelection(selected, item.id));
										anchor.current = item.id;
										return;
									}
									//
									// 普通点击 = **只选中这一条**（用户 2026-11-03：“点一下会话标题的时候就是选中”）。
									// 以前这里调 `onOpen`：打开会话会顺手把归档视图关掉，于是整块清单当场消失，
									// 看着像“点一下东西没了”。打开改成双击。
									setSelected([item.id]);
									anchor.current = item.id;
								}}
								onDoubleClick={() => onOpen(item.id)}
							>
								<span className="archived-title">{item.title}</span>
							</button>
						))}
					</div>
				))}
				{total === 0 ? <div className="side-panel-hint">{t("没有归档的会话")}</div> : null}
			</div>
		</div>
	);
}
