/**
 * 一条会话的右键菜单（**两个入口共用这一份**）：
 *   - 侧栏那条会话行上点右键 / 点行尾 `⋯`；
 *   - **顶栏中间那颗会话标题**上点右键（用户要求：在那儿右键也要能改这条会话）。
 *
 * 为什么要抽成组件：以前这套菜单只活在 `SessionRow` 里，顶栏要复用就只能抄一遍 ——
 * 抄一份就容易出现「侧栏有、顶栏没有」或者两边文案/可用性不一致。
 *
 * 纪律（跟侧栏那份一致）：**不做假按钮**。还没有能力支撑的项（比如标为未读）
 * 就明确禁用并写清原因，而不是点下去没反应。
 */
import { ProjectMenuPopover, type MenuPoint } from "./ProjectMenuPopover.tsx";
import { useT } from "../use-language.ts";
import { useArmed } from "../use-armed.ts";

export function SessionMenu({
	point,
	anchor,
	title,
	pinned,
	splitSide,
	fork,
	onClose,
	onRename,
	onPin,
	onOpenInNewTab,
	onArchive,
	onDelete,
}: {
	/**
	 * 弹出位置（鼠标点）。**会话菜单一般传 `anchor` 就够**：那张菜单是针对「这一行」的，
	 * 挂在行下面 + 一条尾巴指过去比跟着鼠标走更清楚（见下面 `anchor`）。
	 */
	point?: MenuPoint | null;
	/**
	 * 这张菜单「属于」哪个元素（那一行 / 顶栏那颗标题）。
	 * 浮窗会拿它算定位与**小尾巴**的指向 —— 没有它时菜单像凭空浮着，
	 * 看不出是针对哪条会话的（用户 2026-10-29 的要求）。
	 */
	anchor?: HTMLElement | null;
	title: string;
	pinned: boolean;
	/**
	 * 菜单头一项：「把对话挪到另一侧」（跟分栏里那块工作区换个位置）。
	 *
	 * **只有分栏真的分成两块时才传**（面板开着、没铺开）—— 没有两块就没有“对调”这回事。
	 * 也只有顶栏那颗标题菜单传（侧栏行菜单不传）：这是“这一屏怎么摆”，不是“这条会话怎么了”。
	 */
	splitSide?: { chatOnRight: boolean; onMove: () => void };
	/**
	 * 「分叉」这一项：能不能点、为什么不能、点了做什么。
	 * 只有**当前正在看的那条会话**给得出（要从它最后一条消息上切，得有消息 id）；
	 * 侧栏行不传 → 还是那句「需要引擎的分叉能力」的禁用占位。
	 */
	fork?: { enabled: boolean; reason?: string; onFork: () => void };
	onClose: () => void;
	onRename: () => void;
	onPin: () => void;
	onOpenInNewTab: () => void;
	onArchive: () => void;
	/** **真删**（服务端 `unlink`，不可恢复）：界面上只有这一种删除 */
	onDelete: () => void;
}) {
	const t = useT();
	// 菜单里每一个动作都以「先收起菜单」开始：菜单还挂着就弹输入框 / 弹确认框，视觉上会叠在一起
	const act = (run: () => void) => () => {
		onClose();
		run();
	};
	/**
	 * 删除 = **两下**：第一下只是「上膛」，第二下才真删。
	 * 不用 `window.confirm`（它能被浏览器整页屏蔽，点了等于没点，见 delete-session.ts）。
	 */
	const del = useArmed();

	return (
		<ProjectMenuPopover point={point} anchor={anchor} className="pi-menu" closeOnLeave onClose={onClose}>
			{splitSide ? (
				<button
					type="button"
					className="proj-menu-item"
					title={t("和右边那块交换位置", "Swap places with the right part")}
					onClick={act(splitSide.onMove)}
				>
					{splitSide.chatOnRight
						? // 标签只写动作：括号里的解释挪到 title（悬停才看），菜单才不会被解释撑得又长又啰
							`← ${t("移至左侧", "Move to the left")}`
						: `→ ${t("移至右侧面板", "Move to the right panel")}`}
				</button>
			) : null}
			<button type="button" className="proj-menu-item" onClick={act(onPin)}>
				📌 {pinned ? t("取消置顶", "Unpin") : t("置顶", "Pin")}
			</button>
			{/* 重命名不是在菜单里改名：收起菜单后让那行（或顶栏那颗标题）变成输入框就地改 */}
			<button type="button" className="proj-menu-item" onClick={act(onRename)}>
				✏️ {t("重命名", "Rename")}
			</button>
			<button
				type="button"
				className="proj-menu-item"
				title={t("在新标签页打开这条会话（?session=…）", "Open this session in a new tab (?session=…)")}
				onClick={act(onOpenInNewTab)}
			>
				↗ {t("在新标签页打开", "Open in new tab")}
			</button>
			<button
				type="button"
				className="proj-menu-item"
				disabled={fork === undefined || !fork.enabled}
				title={
					fork === undefined
						? t("打开这条会话后，从它的标题上分叉", "Open this session, then fork from its title")
						: fork.enabled
							? t("从这条会话的最后一条消息派生一条新会话（原会话不动）", "Branch a new session from its last message")
							: (fork.reason ?? t("现在不能分叉", "Cannot fork right now"))
				}
				onClick={fork?.enabled ? act(fork.onFork) : undefined}
			>
				🌿 {t("分叉", "Fork")}
			</button>
			<button
				type="button"
				className="proj-menu-item"
				disabled
				title={t("需要已读状态（下一步）", "Needs read state (next step)")}
			>
				● {t("标为未读", "Mark unread")}
			</button>
			{/*
			 * 归档紧挨删除（用户 2026-10-29：“归档图标放到删除上面”）：
			 * 两者都是“把这条会话从眼前拿掉”，放一起才不用先扫一遍整张菜单；
			 * 批量菜单（SessionBatchMenu）本来就是这个顺序，两处对齐。
			 */}
			<button
				type="button"
				className="proj-menu-item"
				title={t("从列表里隐藏，可在「已归档」里找回", "Hide it from the list; find it again under Archived")}
				onClick={act(onArchive)}
			>
				🗄 {t("归档", "Archive")}
			</button>
			<button
				type="button"
				className={`proj-menu-item proj-menu-danger${del.armed ? " proj-menu-item-armed" : ""}`}
				title={
					del.armed
						? `再点一次就真删「${title}」的会话文件：不可恢复`
						: `把「${title}」连同磁盘上的会话文件一起删掉（不可恢复）；第一下只是确认`
				}
				onClick={() =>
					del.run(() => {
						onClose();
						onDelete();
					})
				}
				aria-label={del.armed ? t("再点一次确认彻底删除", "Click again to delete permanently") : t("彻底删除", "Purge")}
			>
				{del.armed ? t("🧨 再点一次彻底删除", "🧨 Click again to purge") : `🧨 ${t("彻底删除", "Purge")}`}
			</button>
		</ProjectMenuPopover>
	);
}
