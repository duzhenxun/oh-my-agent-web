import { useEffect, useRef, useState } from "react";
import type { PiSessionSummary } from "../types.ts";
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";

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
 * 一条会话 + 菜单（从 Sidebar 抽出来：400 行护栏）。
 *
 * 两种打开方式共用同一张菜单：行上**点右键**，或点行尾那个 **⋯**；
 * 点别处自动收（portal + outside click）。
 *
 * 重命名是**就地编辑**：双击标题（或菜单里的「重命名」）这一行变成输入框，
 * 回车保存 / Esc 取消 / 点外面也保存 —— 不弹系统 prompt（那个窗口既丑又挡视线）。
 * 名字写进 pi 的会话文件（session_info），由外层负责发请求。
 *
 * 未实现但保留入口的：分叉、标为未读 —— 都明确禁用并写清原因，不做假按钮。
 */
export function SessionRow({
	session,
	active,
	running,
	title,
	pinned,
	menuPoint,
	onOpenMenu,
	onSwitch,
	onPin,
	onRename,
	onArchive,
	onDelete,
	onOpenInNewTab,
	onCloseMenu,
}: {
	session: PiSessionSummary;
	active: boolean;
	running: boolean;
	title: string;
	pinned: boolean;
	/** 非空时菜单就浮在这个位置（右键点出来的地方） */
	menuPoint: MenuPoint | null;
	/** 右键这一行：把菜单弹在鼠标处 */
	onOpenMenu: (point: MenuPoint) => void;
	onSwitch: () => void;
	onPin: () => void;
	/** 提交新名字（就地编辑保存时调用） */
	onRename: (title: string) => void;
	onArchive: () => void;
	onDelete: () => void;
	/** 在新标签页打开这条会话（多开几个标签对照着看时用） */
	onOpenInNewTab: () => void;
	onCloseMenu: () => void;
}) {
	// 就地编辑：打开输入框 / 草稿 / 提交
	const [editing, setEditing] = useState(false);
	const [draft, setDraft] = useState(title);
	const inputRef = useRef<HTMLInputElement>(null);

	useEffect(() => {
		if (!editing) return;
		setDraft(title);
		// 打开就全选，直接打字替换（不用先删）
		requestAnimationFrame(() => {
			inputRef.current?.focus();
			inputRef.current?.select();
		});
	}, [editing, title]);

	const commit = () => {
		const next = draft.replace(/\s+/g, " ").trim().slice(0, 60);
		setEditing(false);
		if (next !== "" && next !== title) onRename(next);
	};

	const act = (fn: () => void) => () => {
		fn();
		onCloseMenu();
	};

	return (
		<div
			className="pi-row-wrap"
			onContextMenu={(event) => {
				// 右键 = 菜单（原来那个「⋯」按钮的位置）
				event.preventDefault();
				onOpenMenu({ x: event.clientX, y: event.clientY });
			}}
		>
			<button
				type="button"
				className={`pi-row${active ? " pi-row-active" : ""}`}
				onClick={onSwitch}
				title={`${session.cwd}\n${session.id}`}
			>
				{editing ? (
					<input
						ref={inputRef}
						className="pi-row-title pi-row-title-input"
						value={draft}
						onChange={(event) => setDraft(event.target.value)}
						onClick={(event) => event.stopPropagation()}
						onDoubleClick={(event) => event.stopPropagation()}
						onKeyDown={(event) => {
							if (event.key === "Enter") {
								event.preventDefault();
								commit();
							} else if (event.key === "Escape") {
								event.preventDefault();
								setEditing(false);
							}
						}}
						onBlur={commit}
					/>
				) : (
					<span
						className="pi-row-title"
						// 双击标题 = 就地改名（单击仍然是切会话，别抢它的语义）
						onDoubleClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							setEditing(true);
						}}
						title="双击改名"
					>
						{title}
					</span>
				)}
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
			<button
				type="button"
				className="pi-more"
				title="更多操作（置顶 / 重命名 / 归档…）"
				onClick={(event) => {
					// 点「⋯」= 和右键同一张菜单，只是从按钮下面弹出来
					event.stopPropagation();
					const rect = event.currentTarget.getBoundingClientRect();
					onOpenMenu({ x: rect.left, y: rect.bottom + 2 });
				}}
			>
				⋯
			</button>
			{menuPoint ? (
				<ProjectMenuPopover point={menuPoint} className="pi-menu" onClose={onCloseMenu}>
					<button type="button" className="proj-menu-item" onClick={act(onPin)}>
						📌 {pinned ? "取消置顶" : "置顶"}
					</button>
					<button
						type="button"
						className="proj-menu-item"
						onClick={() => {
							onCloseMenu();
							setEditing(true);
						}}
					>
						✏️ 重命名
					</button>
					<button
						type="button"
						className="proj-menu-item"
						title="在新标签页打开这条会话（?session=…）"
						onClick={act(onOpenInNewTab)}
					>
						↗ 在新标签页打开
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
						title="把会话文件改名到 .deleted-时间戳（可从磁盘恢复）"
						onClick={act(onDelete)}
					>
						🗑 删除
					</button>
				</ProjectMenuPopover>
			) : null}
		</div>
	);
}
