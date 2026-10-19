import { useState } from "react";

/**
 * 「已归档 · N」折叠区：归档只是从列表隐藏（settings.sessionPrefs.archived），
 * 数据仍在磁盘上，这里可以一键恢复。
 */
export function ArchivedSessions({
	items,
	onRestore,
}: {
	items: { id: string; title: string }[];
	onRestore: (id: string) => void;
}) {
	const [open, setOpen] = useState(false);
	if (items.length === 0) return null;
	return (
		<section className="archived">
			<button
				type="button"
				className="archived-head"
				onClick={() => setOpen((value) => !value)}
				title="已归档的会话（数据仍在磁盘，只是不显示）"
			>
				<span className="archived-caret">{open ? "⌄" : "›"}</span>
				🗄 已归档 · {items.length}
			</button>
			{open ? (
				<div className="archived-list">
					{items.map((item) => (
						<div className="archived-row" key={item.id}>
							<span className="archived-title" title={item.id}>
								{item.title}
							</span>
							<button type="button" className="msg-action" title="恢复到列表" onClick={() => onRestore(item.id)}>
								恢复
							</button>
						</div>
					))}
				</div>
			) : null}
		</section>
	);
}
