import type { PiSessionSummary } from "../types.ts";

/** 相对时间（与 Sidebar 里那份一致；抽出来避免循环依赖 */
function relativeTime(ts: number, now = Date.now()): string {
	const diff = Math.max(0, now - ts);
	const minute = 60_000;
	if (diff < minute) return "刚刚";
	if (diff < 60 * minute) return `${Math.floor(diff / minute)}分`;
	if (diff < 24 * 60 * minute) return `${Math.floor(diff / (60 * minute))}小时`;
	const days = Math.floor(diff / (24 * 60 * minute));
	if (days < 30) return `${days}天`;
	const months = Math.floor(days / 30);
	return months < 12 ? `${months}个月` : `${Math.floor(months / 12)}年`;
}

/**
 * 一条会话 + 右侧「⋯」菜单（从 Sidebar 抽出来：400 行护栏）。
 *
 * 已实现：置顶 / 重命名 / 归档（都存在 settings.sessionPrefs）。
 * 未实现但保留入口的：分叉、标为未读、删除 —— 都明确禁用并写清原因，
 * 不做"点了没反应"的假按钮。
 */
export function SessionRow({
	session,
	active,
	running,
	title,
	pinned,
	menuOpen,
	onToggleMenu,
	onSwitch,
	onPin,
	onRename,
	onArchive,
	onCloseMenu,
}: {
	session: PiSessionSummary;
	active: boolean;
	running: boolean;
	title: string;
	pinned: boolean;
	menuOpen: boolean;
	onToggleMenu: () => void;
	onSwitch: () => void;
	onPin: () => void;
	onRename: () => void;
	onArchive: () => void;
	onCloseMenu: () => void;
}) {
	const act = (fn: () => void) => () => {
		fn();
		onCloseMenu();
	};

	return (
		<div className="pi-row-wrap">
			<button
				type="button"
				className={`pi-row${active ? " pi-row-active" : ""}`}
				onClick={onSwitch}
				title={`${session.cwd}\n${session.id}`}
			>
				<span className="pi-row-title">{title}</span>
				{running ? (
					<span className="pi-running" title="这个会话正在运行">
						<span className="pi-ring" aria-hidden="true" />
						运行中
					</span>
				) : (
					<span className="pi-row-time">{relativeTime(session.updatedAt)}</span>
				)}
			</button>
			<button
				type="button"
				className="pi-archive"
				title="归档（从列表隐藏，可在「已归档」里找回）"
				onClick={(event) => {
					event.stopPropagation();
					onArchive();
				}}
			>
				🗄
			</button>
			<button type="button" className="pi-more" title="更多操作" onClick={onToggleMenu}>
				⋯
			</button>
			{menuOpen ? (
				<div className="pi-menu" role="menu">
					<button type="button" className="proj-menu-item" onClick={act(onPin)}>
						📌 {pinned ? "取消置顶" : "置顶"}
					</button>
					<button type="button" className="proj-menu-item" onClick={act(onRename)}>
						✏️ 重命名
					</button>
					<button type="button" className="proj-menu-item" onClick={act(onArchive)}>
						🗄 归档（从列表隐藏）
					</button>
					<button type="button" className="proj-menu-item" disabled title="需要引擎的分叉能力（下一步）">
						🌿 分叉
					</button>
					<button type="button" className="proj-menu-item" disabled title="需要已读状态（下一步）">
						● 标为未读
					</button>
					<button
						type="button"
						className="proj-menu-item proj-menu-danger"
						disabled
						title="会删除 pi 的会话文件，需要二次确认 + 可撤销（下一步）"
					>
						🗑 删除
					</button>
				</div>
			) : null}
		</div>
	);
}
