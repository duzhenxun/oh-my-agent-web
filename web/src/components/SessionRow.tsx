import { useEffect, useRef, useState } from "react";
import type { PiSessionSummary } from "../types.ts";
import type { MenuPoint } from "./ProjectMenuPopover.tsx";
import { SessionMenu } from "./SessionMenu.tsx";
import { useT } from "../use-language.ts";
import { PLAIN_TEXT_INPUT } from "../plain-text-input.ts";

/** 相对时间（与 Sidebar 里那份一致；抽出来避免循环依赖）。
 * **不再画在行尾**（用户：「会话后面的时间不要了吧，这样能多显示一些」）：
 * 那一格常年占着 30px 上下，标题被截得更短；现在只在行上的悬停提示里给。 */
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
 * 两种打开方式共用同一张菜单：行上**点右键**，或点行尾那个 **⋯**
 * （行尾那颗「🗄 快速归档」已按用户要求去掉 —— 手机上手指一蹭就误归档）；
 * 归档本身仍在菜单里，多一步但可反悔。
 * 点别处自动收（portal + outside click）。
 *
 * 重命名是**就地编辑**：双击标题（或菜单里的「重命名」）这一行变成输入框，
 * 回车保存 / Esc 取消 / 点外面也保存 —— 不弹系统 prompt（那个窗口既丑又挡视线）。
 * 名字写进 pi 的会话文件（session_info），由外层负责发请求。
 *
 * 未实现但保留入口的：分叉、标为未读 —— 都明确禁用并写清原因，不做假按钮。
 *
 * 「跑完了、你还没看」的**小蓝点**（`unseen`）：被 `session-unseen.ts` 记住，
 * 点开这条会话（切过去）就抹掉 —— 圆点自己不是按钮，点击落在整行上，
 * 也就是说「点它 = 打开它」，跟用户要的「一旦点击后圆点就消失」一致。
 *
 * 选中态（`selected`）只负责画，不负责算：哪些行被选中、Shift 连选切哪一段，
 * 全在 `Sidebar` 里算（它才知道整条列表的可见顺序）。这里只把**修饰键**原样上报（`onSwitch`）。
 */
export function SessionRow({
	session,
	active,
	running,
	unseen = false,
	title,
	pinned,
	selected = false,
	menuPoint,
	onOpenMenu,
	onSwitch,
	onPin,
	onRename,
	onArchive,
	onDelete,
	onOpenInNewTab,
	onCloseMenu,
	draggable,
	onDragStart,
	onDragEnd,
	dragOver,
	onDragOver,
	onDragLeave,
	onDrop,
}: {
	session: PiSessionSummary;
	active: boolean;
	running: boolean;
	/** 跑完了、但还没点开看过（行尾一颗小蓝点；点开这条会话就消失） */
	unseen?: boolean;
	title: string;
	pinned: boolean;
	/** 多选中的一条（Shift 连选 / Ctrl·⌘ 加减选出来的那一批）：只换样式，不加交互 */
	selected?: boolean;
	/** 非空时菜单就浮在这个位置（右键点出来的地方） */
	menuPoint: MenuPoint | null;
	/** 右键这一行：把菜单弹在鼠标处 */
	onOpenMenu: (point: MenuPoint) => void;
	/**
	 * 点了这一行。修饰键原样带出去（选中逻辑在 Sidebar）：
	 * `shift` = 连选一段，`toggle` = Ctrl/⌘ 加减选，两个都假 = 普通点击（打开这条会话）。
	 */
	onSwitch: (modifiers: { shift: boolean; toggle: boolean }) => void;
	onPin: () => void;
	/** 提交新名字（就地编辑保存时调用） */
	onRename: (title: string) => void;
	onArchive: () => void;
	/** **真删**（服务端 `unlink`，不可恢复）：界面上只有这一种删除 */
	onDelete: () => void;
	/** 在新标签页打开这条会话（多开几个标签对照着看时用） */
	onOpenInNewTab: () => void;
	onCloseMenu: () => void;
	/** 拖动：可拖起（把会话拖到别的项目） */
	draggable?: boolean;
	onDragStart?: () => void;
	onDragEnd?: () => void;
	/** 拖动：作为「行内排序」的投放目标（项目分组排项目内顺序，置顶分组排置顶顺序） */
	dragOver?: boolean;
	onDragOver?: () => void;
	onDragLeave?: () => void;
	onDrop?: () => void;
}) {
	const t = useT();
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

	/** 这一行的 DOM：会话菜单要拿它当锚点（小尾巴指着这一行，见 ProjectMenuPopover） */
	const rowRef = useRef<HTMLDivElement>(null);

	/** 标题的裁剪盒（`.pi-row-title`）与里面的文字节点（`.pi-row-title-text`） */
	const titleBoxRef = useRef<HTMLSpanElement>(null);
	const titleTextRef = useRef<HTMLSpanElement>(null);

	/**
	 * 悬停时让被截断的标题「慢慢往后滑一段」（用户 2026-10-29：鼠标放上去能自己滚一下）。
	 *
	 * 为什么要在 JS 里量：滑动距离 = 「文字自然宽 − 可见宽」，这两个数纯 CSS 拿不到
	 * （`translateX(-100%)` 的 % 是文字自己的宽，不是盒子宽）。
	 * 每次悬停都重量一遍 —— 侧栏拖宽、改字号、行尾冒出「运行中」都会改变可见宽，
	 * 用旧值会滑过头或者滑不到头。量完只往盒子上写两个 CSS 变量，
	 * 真正的位移与时长交给 CSS 的 transition（不重排、不动布局，点一下就走的行不会跳）。
	 */
	const measureTitleScroll = () => {
		const box = titleBoxRef.current;
		const text = titleTextRef.current;
		if (!box || !text) return;
		/* 行尾那 64px 是悬停才铺的不透明底板（「🗄 ⋯」两个按钮，见 session-row.css）：
		 * 标题滑到那下面就被盖住，所以按「可见宽 − 64」算，滑到头时最后一个字正好露在底板左边。 */
		const coveredByButtons = running ? 0 : 64;
		const overflow = Math.ceil(text.getBoundingClientRect().width - (box.clientWidth - coveredByButtons));
		if (overflow <= 0) {
			box.style.removeProperty("--pi-title-shift");
			box.style.removeProperty("--pi-title-dur");
			return;
		}
		box.style.setProperty("--pi-title-shift", `-${overflow}px`);
		/* 约 **25px/s**（2026-10-29 用户：再慢一点）：句子是“跟读”而不是“扫过”，所以留足时间。
		 * 上限放到 12s：按这个速度，超出 200px 的长标题刚好滑完（再长也不再拖，不然看着像卡住）。 */
		const ms = Math.min(12000, Math.max(1500, Math.round((overflow / 25) * 1000)));
		box.style.setProperty("--pi-title-dur", `${ms}ms`);
	};

	const commit = () => {
		const next = draft.replace(/\s+/g, " ").trim().slice(0, 60);
		setEditing(false);
		if (next !== "" && next !== title) onRename(next);
	};

	return (
		<div
			ref={rowRef}
			className={`pi-row-wrap${active ? " pi-row-wrap-active" : ""}${selected ? " pi-row-wrap-selected" : ""}${running ? " pi-row-wrap-running" : ""}${dragOver ? " pi-row-drag-over" : ""}`}
			draggable={draggable}
			onDragStart={(event) => {
				// 设一个 dataTransfer 类型：否则部分浏览器拖拽起不来，drop 也收不到内容
				event.dataTransfer.setData("text/plain", session.id);
				event.dataTransfer.effectAllowed = "move";
				onDragStart?.();
			}}
			onDragEnd={onDragEnd}
			onDragOver={
				onDragOver
					? (event) => {
							// 只有真拖起了一条会话才当投放目标（避免把文件/文本拖进来误触发）
							if (event.dataTransfer?.types.includes("text/plain")) {
								event.preventDefault();
								onDragOver();
							}
						}
					: undefined
			}
			onDragLeave={onDragLeave}
			onDrop={
				onDrop
					? (event) => {
							event.preventDefault();
							event.stopPropagation(); // 别让项目级的「搬到这个项目」抢走
							onDrop();
						}
					: undefined
			}
			onContextMenu={(event) => {
				// 右键 = 菜单（原来那个「⋯」按钮的位置）
				event.preventDefault();
				/**
				 * macOS 上 **Ctrl+左键 = 二级点击**，浏览器会把它当 `contextmenu` 发出来 —— 而本工作台里
				 * Ctrl+单击是「加/减选」（见下面 onClick 的 `toggle`）。以前这里会把菜单也弹出来，
				 * 看起来就是「一选就冒出一个浮窗」（用户 2026-10-30：「ctrl+单击 时不要弹出右边的弹窗」）。
				 * 带 ctrl 的一律只当选中：顺便把系统菜单也 preventDefault 掉。
				 */
				if (event.ctrlKey) {
					onSwitch({ shift: false, toggle: true });
					return;
				}
				onOpenMenu({ x: event.clientX, y: event.clientY });
			}}
			onMouseEnter={measureTitleScroll}
		>
			<button
				type="button"
				className={`pi-row${active ? " pi-row-active" : ""}${selected ? " pi-row-selected" : ""}${pinned ? " pi-row-pinned" : ""}`}
				onClick={(event) => onSwitch({ shift: event.shiftKey, toggle: event.metaKey || event.ctrlKey })}
				// 时间不进布局，只在这个悬停提示里（鼠标停一下照样能看到「3小时」）
				title={`${session.cwd}\n${session.id}\n最后活动：${relativeTime(session.updatedAt)}`}
			>
				{editing ? (
					<input
						ref={inputRef}
						className="pi-row-title pi-row-title-input"
						/* 就地改名也是纯文本：不给系统「这是账号框」的信号（属性包见 plain-text-input.ts） */
						{...PLAIN_TEXT_INPUT}
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
						ref={titleBoxRef}
						className="pi-row-title"
						// 双击标题 = 就地改名（单击仍然是切会话，别抢它的语义）
						onDoubleClick={(event) => {
							event.preventDefault();
							event.stopPropagation();
							setEditing(true);
						}}
						title={t("双击改名")}
					>
						{/* 文字单独一层：悬停时平移的是这一层，外层继续负责裁剪与末尾淡出 */}
						<span ref={titleTextRef} className="pi-row-title-text">
							{title}
						</span>
					</span>
				)}
				{running ? (
					/* 只画转圈，不写「运行中」（用户 2026-10-29）：那三个字要占 30 多 px，
					   而会话标题才是这一行真正要看的东西 —— 状态交给转圈 + 悬浮提示。 */
					<span
						className="pi-running"
						role="img"
						aria-label={t("这个会话正在运行", "This session is running")}
						title={t("这个会话正在运行", "This session is running")}
					>
						<span className="pi-ring" aria-hidden="true" />
					</span>
				) : unseen ? (
					// 在跑的时候不画圆点（「跑完了」才有意义）；重新开跑时 session-unseen 也会把标记抹掉
					<span
						className="pi-unseen"
						role="img"
						aria-label={t("已跑完，还没看", "Finished, not reviewed")}
						title={t("跑完了、你还没看（点开这条会话就消失）", "Finished and not reviewed — open it to clear")}
					/>
				) : null}
			</button>
			<button
				type="button"
				className="pi-more"
				title={t("更多操作（置顶 / 重命名 / 归档…）")}
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
				<SessionMenu
					anchor={rowRef.current}
					title={title}
					pinned={pinned}
					onClose={onCloseMenu}
					onPin={onPin}
					onRename={() => setEditing(true)}
					onOpenInNewTab={onOpenInNewTab}
					onArchive={onArchive}
					onDelete={onDelete}
				/>
			) : null}
		</div>
	);
}
