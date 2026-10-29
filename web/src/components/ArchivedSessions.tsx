/**
 * 「已归档」视图：入口在侧栏标题栏（🗄 图标），点进来后**整个列表区**切换到这个视图。
 *
 * 归档只是从主列表隐藏（settings.sessionPrefs.archived），数据仍在磁盘 —— 所以这里
 * 既能「恢复」，也能**批量选中后批量删除**（删除 = 文件改名成 `.deleted-时间戳`，可恢复）。
 */
import { useState } from "react";
import { deleteSessions } from "../delete-session.ts";
import { useArmed } from "../use-armed.ts";
import { ProjectFolderIcon } from "./ProjectFolderIcon.tsx";
import { useT } from "../use-language.ts";

export function ArchivedSessions({
	groups,
	onBack,
	onOpen,
	onRestore,
	onRestoreMany,
}: {
	groups: { name: string; items: { id: string; title: string; time: string }[] }[];
	onBack: () => void;
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
	const [selected, setSelected] = useState<Set<string>>(new Set());
	/**
	 * 展开着的项目分组（**默认一个都不展开**）。
	 *
	 * 归档动辄几十条、项目又有七八个，全展开时一屏只够看一个项目（用户的原话：
	 * 「默认展开的话有点多」）。收起态仍显示 `项目 · N`，想知道有多少条不用点开。
	 * 存的是「展开的」而不是「收起的」—— 以后新增的归档项目自然也是收起的。
	 */
	const [expanded, setExpanded] = useState<Set<string>>(new Set());
	const toggleExpanded = (name: string) =>
		setExpanded((current) => {
			const next = new Set(current);
			if (next.has(name)) next.delete(name);
			else next.add(name);
			return next;
		});

	const toggle = (id: string) =>
		setSelected((current) => {
			const next = new Set(current);
			if (next.has(id)) next.delete(id);
			else next.add(id);
			return next;
		});

	const allIds = groups.flatMap((group) => group.items.map((item) => item.id));
	const allSelected = allIds.length > 0 && allIds.every((id) => selected.has(id));

	/** 某一组是否全选了（空了不算全选） */
	const groupAllSelected = (ids: string[]) => ids.length > 0 && ids.every((id) => selected.has(id));

	/** 组内全选 / 全不选（不动其它组的选择） */
	const toggleGroup = (ids: string[]) => {
		const all = groupAllSelected(ids);
		setSelected((current) => {
			const next = new Set(current);
			for (const id of ids) {
				if (all) next.delete(id);
				else next.add(id);
			}
			return next;
		});
	};

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
			setSelected(new Set());
		});
	};

	const restoreSelected = () => {
		const ids = [...selected];
		if (ids.length === 0) return;
		if (ids.length === 1) onRestore(ids[0] as string);
		else onRestoreMany(ids);
		setSelected(new Set());
	};

	return (
		<div className="archived-view">
			<div className="archived-view-head">
				<button type="button" className="archived-back" onClick={onBack} title={t("返回项目")}>
					‹
				</button>
				<span className="archived-view-title">
					{t("已归档", "Archived")} · {total}
				</span>
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-tiny"
					disabled={allIds.length === 0}
					onClick={() => setSelected(allSelected ? new Set() : new Set(allIds))}
					title={allSelected ? "取消全选" : "全选"}
				>
					{allSelected ? "全不选" : "全选"}
				</button>
			</div>

			{selected.size > 0 ? (
				<div className="archived-bulk">
					<span className="archived-bulk-count">
						{t("已选", "Selected")} {selected.size} {t("条", "items")}
					</span>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={restoreSelected} title={t("把这些恢复回主列表")}>
						恢复选中
					</button>
					<button
						type="button"
						className={`btn btn-tiny btn-danger${del.armed ? " proj-menu-item-armed" : ""}`}
						onClick={removeSelected}
						title={del.armed ? t("再点一次就删掉（可从磁盘恢复）") : t("删除这些（可从磁盘恢复）；第一下只是确认")}
					>
						{del.armed ? t("再点一次确认") : t("删除选中")}
					</button>
				</div>
			) : null}

			<div className="archived-view-list">
				{groups.map((group) => (
					<div className="archived-group" key={group.name}>
						<div className="archived-group-title">
							{/* 整行可点：展开 / 收起这个项目的归档（默认收起）；三角与侧栏项目行同一套 */}
							<button
								type="button"
								className="archived-group-toggle"
								onClick={() => toggleExpanded(group.name)}
								aria-expanded={expanded.has(group.name)}
								title={expanded.has(group.name) ? "收起这个项目的归档" : "展开这个项目的归档"}
							>
								<span
									className={`sidebar-title-caret${expanded.has(group.name) ? " sidebar-title-caret-open" : ""}`}
									aria-hidden="true"
								/>
								{/* 和主列表项目行同一个图标（归档组是「收起来」的项目，所以用合着的文件夹） */}
								<ProjectFolderIcon open={false} />
								<span className="archived-group-name">
									{group.name} · {group.items.length}
								</span>
							</button>
							<span className="topbar-spacer" />
							<button
								type="button"
								className="btn btn-tiny archived-group-select"
								title={
									groupAllSelected(group.items.map((item) => item.id))
										? t("取消这个项目的全选", "Unselect everything in this project")
										: t("选中这个项目的全部", "Select everything in this project")
								}
								onClick={() => toggleGroup(group.items.map((item) => item.id))}
							>
								{groupAllSelected(group.items.map((item) => item.id))
									? t("全不选", "Select none")
									: t("全选", "Select all")}
							</button>
						</div>
						{(expanded.has(group.name) ? group.items : []).map((item) => (
							<div className={`archived-row${selected.has(item.id) ? " archived-row-on" : ""}`} key={item.id}>
								<input
									type="checkbox"
									checked={selected.has(item.id)}
									onChange={() => toggle(item.id)}
									title={t("选中这条（可批量恢复 / 删除）")}
								/>
								<button
									type="button"
									className="archived-open"
									onClick={() => onOpen(item.id)}
									title={`打开这条会话\n${item.id}`}
								>
									<span className="archived-title">{item.title}</span>
									<span className="archived-time">{item.time}</span>
								</button>
								<button
									type="button"
									className="msg-action"
									title={t("恢复到主列表")}
									onClick={() => onRestore(item.id)}
								>
									恢复
								</button>
							</div>
						))}
					</div>
				))}
				{total === 0 ? <div className="side-panel-hint">{t("没有归档的会话")}</div> : null}
			</div>
		</div>
	);
}
