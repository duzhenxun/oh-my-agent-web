/**
 * 「已归档」视图（对齐参考实现）：点侧栏底部的入口后，**整个列表区**切换到归档视图，
 * 顶部是一个「‹ 已归档 · N」返回条，下面是按项目分组的归档会话，点条目可以直接打开查看。
 *
 * 归档只是从主列表隐藏（settings.sessionPrefs.archived），数据仍在磁盘。
 */
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
	return (
		<div className="archived-view">
			<div className="archived-view-head">
				<button type="button" className="archived-back" onClick={onBack} title="返回项目列表">
					‹
				</button>
				<span className="archived-view-title">已归档 · {total}</span>
				<span className="topbar-spacer" />
			</div>
			<div className="archived-view-list">
				{groups.map((group) => (
					<div className="archived-group" key={group.name}>
						<div className="archived-group-title">
							{group.name} · {group.items.length}
						</div>
						{group.items.map((item) => (
							<div className="archived-row" key={item.id}>
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
