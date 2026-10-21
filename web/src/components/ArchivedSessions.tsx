/**
 * 「已归档」视图：入口在侧栏标题栏（🗄 图标），点进来后**整个列表区**切换到这个视图。
 *
 * 归档只是从主列表隐藏（settings.sessionPrefs.archived），数据仍在磁盘 —— 所以这里
 * 既能「恢复」，也能**批量选中后批量删除**（删除 = 文件改名成 `.deleted-时间戳`，可恢复）。
 */
import { useState } from "react";
import { deleteSessions } from "../delete-session.ts";

export function ArchivedSessions({
	groups,
	onBack,
	onOpen,
	onRestore,
}: {
	groups: { name: string; items: { id: string; title: string; time: string }[] }[];
	onBack: () => void;
	onOpen: (id: string) => void;
	onRestore: (id: string) => void;
}) {
	const total = groups.reduce((sum, group) => sum + group.items.length, 0);
	const [selected, setSelected] = useState<Set<string>>(new Set());

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

	const removeSelected = () => {
		const ids = [...selected];
		if (ids.length === 0) return;
		deleteSessions(ids, "选中的归档会话");
		setSelected(new Set());
	};

	const restoreSelected = () => {
		for (const id of selected) onRestore(id);
		setSelected(new Set());
	};

	return (
		<div className="archived-view">
			<div className="archived-view-head">
				<button type="button" className="archived-back" onClick={onBack} title="返回项目列表">
					‹
				</button>
				<span className="archived-view-title">已归档 · {total}</span>
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
					<span className="archived-bulk-count">已选 {selected.size} 条</span>
					<span className="topbar-spacer" />
					<button type="button" className="btn btn-tiny" onClick={restoreSelected} title="把这些恢复回主列表">
						恢复选中
					</button>
					<button
						type="button"
						className="btn btn-tiny btn-danger"
						onClick={removeSelected}
						title="删除这些（可从磁盘恢复）"
					>
						删除选中
					</button>
				</div>
			) : null}

			<div className="archived-view-list">
				{groups.map((group) => (
					<div className="archived-group" key={group.name}>
						<div className="archived-group-title">
							<span className="archived-group-name">
								{group.name} · {group.items.length}
							</span>
							<span className="topbar-spacer" />
							<button
								type="button"
								className="btn btn-tiny archived-group-select"
								title={
									groupAllSelected(group.items.map((item) => item.id)) ? "取消这个项目的全选" : "选中这个项目的全部"
								}
								onClick={() => toggleGroup(group.items.map((item) => item.id))}
							>
								{groupAllSelected(group.items.map((item) => item.id)) ? "全不选" : "全选"}
							</button>
						</div>
						{group.items.map((item) => (
							<div className={`archived-row${selected.has(item.id) ? " archived-row-on" : ""}`} key={item.id}>
								<input
									type="checkbox"
									checked={selected.has(item.id)}
									onChange={() => toggle(item.id)}
									title="选中这条（可批量恢复 / 删除）"
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
								<button type="button" className="msg-action" title="恢复到主列表" onClick={() => onRestore(item.id)}>
									恢复
								</button>
							</div>
						))}
					</div>
				))}
				{total === 0 ? <div className="side-panel-hint">没有归档的会话</div> : null}
			</div>
		</div>
	);
}
