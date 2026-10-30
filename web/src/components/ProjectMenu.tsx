/**
 * 项目菜单的内容（新建会话/贴顶/移动/重命名/定位/终端/Finder）。
 * 两种打开方式共用这一张菜单：项目名上**点右键**，或点行尾那个 **＋**。
 *
 * 单独成文件的原因：菜单项有 7 个，塞回 Sidebar 会破 400 行护栏（ADR-0010）；
 * 定位（portal + fixed）在 ProjectMenuPopover 里，这里只管按钮与回调。
 */
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";
import { useArmed } from "../use-armed.ts";

export function ProjectMenu({
	point,
	anchor,
	onClose,
	pinned,
	onTogglePin,
	/** 在这个项目下新建会话（菜单第一项，最常用） */
	onNewSession,
	onMoveUp,
	onMoveDown,
	onRename,
	onOpenFiles,
	onOpenTerminal,
	onReveal,
	onDeleteAll,
	sessionCount,
}: {
	/**
	 * 弹出位置（鼠标点）。项目菜单**一般只传 `anchor`**：挂在那一行下面 + 一条尾巴指过去，
	 * 比跟着鼠标走清楚得多 —— 跟着鼠标时菜单会**盖住这一行本身**，
	 * 看起来根本不知道是哪一行的菜单（用户 2026-10-29 的原话）。
	 */
	point?: MenuPoint | null;
	/** 这一行（`.proj-head`）：浮窗的小尾巴要指着它，让人看出菜单是针对哪个项目的 */
	anchor?: HTMLElement | null;
	onClose: () => void;
	pinned: boolean;
	onTogglePin: () => void;
	onNewSession: () => void;
	onMoveUp: () => void;
	onMoveDown: () => void;
	onRename: () => void;
	onOpenFiles: () => void;
	onOpenTerminal: () => void;
	onReveal: () => void;
	/** 删除这个项目下的全部会话（会二次确认） */
	onDeleteAll: () => void;
	/** 供菜单显示条数 */
	sessionCount: number;
}) {
	const t = useT();
	/**
	 * 「删除全部会话」= **两下**：第一下上膛（按钮变红底、文案换成「再点一次确认」），
	 * 第二下才真删。不用 `window.confirm`：浏览器能整页屏蔽原生对话框，
	 * 那时点了等于没点、还不报错（2026-10-29「怎么删不掉啊？」就是这么来的）。
	 */
	const wipe = useArmed();
	/** 点完就收菜单（每个动作都是「一锤子」） */
	const act = (fn: () => void) => () => {
		fn();
		onClose();
	};

	return (
		<ProjectMenuPopover point={point} anchor={anchor} closeOnLeave onClose={onClose}>
			<button type="button" className="proj-menu-item" title="在这个项目下开一条新会话" onClick={act(onNewSession)}>
				💬 新建会话
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onTogglePin)}>
				{pinned ? "📌 取消置顶" : "📌 置顶项目"}
			</button>
			<button type="button" className="proj-menu-item" title="在同组内上移一格" onClick={act(onMoveUp)}>
				↑ 上移
			</button>
			<button type="button" className="proj-menu-item" title="在同组内下移一格" onClick={act(onMoveDown)}>
				↓ 下移
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onRename)}>
				✏️ 重命名…
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onOpenFiles)}>
				📁 在文件列表中定位
			</button>
			<button type="button" className="proj-menu-item" onClick={act(onOpenTerminal)}>
				⌨ 在终端中打开
			</button>
			<button
				type="button"
				className="proj-menu-item"
				title={t("在系统文件管理器里定位这个目录（只定位，不执行任何文件）")}
				onClick={act(onReveal)}
			>
				🔍 在 Finder 中显示
			</button>
			{/* 破坏性操作放最后、标红：删的是这条项目的全部会话，**真删文件、不可恢复**。
			 * 两下确认：第一下只上膛 —— 见文件里 `wipe` 那段注释。 */}
			<button
				type="button"
				className={`proj-menu-item proj-menu-danger${wipe.armed ? " proj-menu-item-armed" : ""}`}
				title={
					wipe.armed
						? t("再点一次就真删这些会话文件：不可恢复")
						: t("彻底删除这个项目下的全部会话（不可恢复）；第一下只是确认")
				}
				onClick={() =>
					wipe.run(() => {
						onClose();
						onDeleteAll();
					})
				}
			>
				{wipe.armed
					? t(`🗑 再点一次确认删除 · ${sessionCount}`, `🗑 Click again to delete · ${sessionCount}`)
					: t(`🗑 删除全部会话… · ${sessionCount}`, `🗑 Delete all sessions… · ${sessionCount}`)}
			</button>
		</ProjectMenuPopover>
	);
}
