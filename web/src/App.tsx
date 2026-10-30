import { UPGRADE_COMMAND } from "./brand.ts";
import { basename } from "./path-utils.ts";
import { useStickToBottom } from "./stick-to-bottom.ts";
import { nextAnchorTarget, type AnchorSeen } from "./anchor-target.ts";
import { useVoiceCues } from "./use-voice-cues.ts";
// 「跑完了、你还没看」的小圆点：喂帧在这里，画圆点在侧栏（session-unseen.ts）
import { useUnseenFinishWatch } from "./use-unseen-finish.ts";
import { ToastHost } from "./components/ToastHost.tsx";
import { useDocumentFullscreen } from "./use-fullscreen.ts";
import { ImageViewer } from "./components/ImageViewer.tsx";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
	clampSidebarWidth,
	defaultCollapsed,
	isTablet,
	readStoredWidth,
	SIDEBAR_COLLAPSED_KEY,
	SIDEBAR_WIDTH_KEY,
	sidebarMaxWidth,
} from "./sidebar-layout.ts";
import {
	getAppState,
	setDraft,
	setNewSessionEphemeral,
	setNewSessionWorkspace,
	startNewSession,
	useAppSelector,
} from "./store.ts";
import { shortcutFor, type ShortcutId } from "./shortcuts.ts";
import { toggleShortcutSheet } from "./shortcut-sheet.ts";
import { useShortcuts } from "./use-shortcuts.ts";
import { SPLIT_CHAT_SIDE_KEY, readStored, writeStored } from "./ui-prefs.ts";
import { PANEL_STATE_KEY, parsePanelState, restorePanelItems, serializePanelState } from "./preview-tabs-pref.ts";
import { sessionIdFromUrl, sessionUrlFor } from "./session-url.ts";
import {
	cancelQueued,
	forkSession,
	persistConversation,
	renameSession,
	suggestSessionTitle,
	switchConversation,
} from "./ws.ts";
import { focusComposer } from "./composer-focus.ts";
import { PLAIN_TEXT_INPUT } from "./plain-text-input.ts";
import { appendQuote, quoteOf } from "./selection-quote.ts";
import {
	addAnnotation,
	annotationBlock,
	annotationNumber,
	findSameSpot,
	markQuoted,
	readAnnotations,
	removeAnnotation,
	setAnnotationComment,
	writeAnnotations,
	type Annotation,
} from "./annotations.ts";
import { AnnotationSummary } from "./components/AnnotationSummary.tsx";
import type { SelectionAddInput } from "./components/SelectionToolbar.tsx";
import { showToast } from "./toast.ts";
import { closeEphemeralChat } from "./close-ephemeral.ts";
import { nextTreeRoot } from "./file-tree-model.ts";
import { realPathForToken, toolPathUses } from "./changed-files.ts";
import type { UiMessage } from "./types.ts";
import { archiveSession, toggleSessionPin } from "./session-actions.ts";
import { deleteSession } from "./delete-session.ts";
import { SessionMenu } from "./components/SessionMenu.tsx";
import { currentMobileShell } from "./mobile-shell-dom.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { NewChatMeta } from "./components/NewChatMeta.tsx";
import { ConversationOutline } from "./components/ConversationOutline.tsx";
import { SidebarMenu, type Panel as MenuPanel } from "./components/SidebarMenu.tsx";
import { APPBAR_ITEMS, APPBAR_TEMPCHAT_DEFAULT, APPBAR_TEMPCHAT_KEY } from "./ui-prefs.ts";
import { useAppbarItems } from "./use-appbar-items.ts";
import { useStoredBool } from "./use-stored-bool.ts";
import { AgentsLiveBadge } from "./components/AgentsLiveBadge.tsx";
import { NewChatButton } from "./components/NewChatButton.tsx";
import { TempChatButton } from "./components/TempChatButton.tsx";
import { NewProjectDialog } from "./components/NewProjectDialog.tsx";
import { ShortcutSheet } from "./components/ShortcutSheet.tsx";
import { turnStartedAtOf } from "./subagent-view.tsx";
import { PreviewPanel, disposePanelItem, type PanelItem, type WorkTool } from "./components/PreviewPanel.tsx";
// 分栏里的临时聊天：它们不是「我的会话」，要从左侧清单里滤掉
import { isSideConversation, sideChannelFor } from "./side-chat.ts";
import { ConversationIcon } from "./components/ConversationIcon.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { ContentSearch } from "./components/ContentSearch.tsx";
import { StatusBar } from "./components/StatusBar.tsx";
import { useT } from "./use-language.ts";
import { useBrandName } from "./use-brand-name.ts";

export function App() {
	const t = useT();
	// 顶栏自称（logo 后面那串）：设置 → 外观 里可以隐藏或改名（本机偏好）
	const brand = useBrandName();
	/** 浏览器标签页标题用同一个名字（用户改过名，标签页也跟着改） */
	const brandName = brand.name;
	// 文件面板（M4）：跟着当前会话的工作区走
	// 侧栏：可收起 + 可拖宽（状态存 localStorage，刷新后保持）
	const [collapsed, setCollapsed] = useState(() =>
		defaultCollapsed({
			stored: readStored(SIDEBAR_COLLAPSED_KEY),
			tablet: typeof window !== "undefined" && isTablet((text) => window.matchMedia(text).matches),
		}),
	);
	/** 单栏（手机外壳）判定：手机上 ☰ 是抽屉开关，桌面上它换成「收起 / 展开」的箭头 */
	const [mobileShell, setMobileShell] = useState(() => currentMobileShell());
	useEffect(() => {
		const sync = () => setMobileShell(currentMobileShell());
		window.addEventListener("resize", sync);
		window.addEventListener("orientationchange", sync);
		return () => {
			window.removeEventListener("resize", sync);
			window.removeEventListener("orientationchange", sync);
		};
	}, []);
	/** 顶部栏是否收起（底部状态栏的「▴ 顶部」切换，状态存 localStorage） */
	const [appbarHidden, setAppbarHidden] = useState(() => readStored("agent-web:appbar-hidden") === "1");
	/** 整页全屏：状态只认 `document.fullscreenElement`（Esc / 浏览器自带方式退出也跟得上），见 use-fullscreen.ts */
	const fullscreen = useDocumentFullscreen();
	/**
	 * 刷新前的右侧分栏状态（标签 / 聚焦哪条 / 开没开）—— 只读一次。
	 * 读在这里（`previewVisible` / `panelItems` / `activeItem` 的初值都要用它），
	 * 三个 state 的初始值因此都来自同一份快照。
	 */
	const restoredPanel = useRef<ReturnType<typeof parsePanelState>>(
		parsePanelState(readStored(PANEL_STATE_KEY)) ?? { tabs: [], active: null, open: false },
	);
	/**
	 * 右侧分栏「开着吗」（顶栏最右那颗分栏图标 / 底部状态栏的展开按钮）。
	 * 默认**关**：不点就还是原来那个「只有对话」的样子；开了之后即便一个标签都没有，
	 * 也会显示工具落地页（文件 / 终端 / 临时聊天 / 网页）。
	 */
	const [previewVisible, setPreviewVisible] = useState(() => restoredPanel.current?.open ?? false);
	/** 预览面板「铺开」：占满对话 + 预览两块区域（左侧栏保留） */
	const [previewWide, setPreviewWide] = useState(false);
	/**
	 * 全文搜索浮层（「文件管理」标题栏那面放大镜 / ⌘⇧F 打开）。
	 * 浮层挂在 App 上而不是侧栏里：选中一条结果要能开右侧面板并跳到那一行，
	 * 而面板状态就在这一层；顺带侧栏收起了、手机上抽屉关着，⌘⇧F 也照样能搜。
	 */
	/** 顶栏中间那颗会话名：双击就地改名（跟侧栏会话行同一套规矩：回车提交 / Esc 取消 / 失焦也提交） */
	const [headingEditing, setHeadingEditing] = useState(false);
	/**
	 * 顶栏标题前那枚气泡图标按下去的「正在起名」状态。
	 *
	 * 起名要跑一次模型（几秒），没反馈就像没点上 —— 所以跑的时候图标转起来、按钮置灰，
	 * 回包后再亮回来。失败原因由服务端 notice / 回包里的 error 推到提示条，这里只管开关。
	 */
	const [titling, setTitling] = useState(false);
	const [headingDraft, setHeadingDraft] = useState("");
	const headingInputRef = useRef<HTMLInputElement>(null);
	/** 顶栏那颗标题（`.appbar-slot`）：会话菜单的小尾巴要指着它（跟侧栏会话行同一套） */
	const headingSlotRef = useRef<HTMLSpanElement>(null);
	/**
	 * 「会话标题永远落在对话这一栏的上面」：标题槽本身在顶栏里是紧跟在左段（品牌 / 新会话 / 全屏）
	 * 后面的，而左段宽度是**按内容定的**、刻意跟侧栏宽度解耦（之前用户明确要过「拖侧栏时顶部不动」）。
	 * 于是侧栏一宽，标题的默认起点就跑到侧栏上空去了（用户 2026-10-30 的截图：标题骑在项目列表
	 * 上面，左边跨过了对话栏那条线）。
	 *
	 * 这里在布局后量一次「对话栏左沿相对顶栏主段的偏移」，把标题按这个偏移推开；宽度也只到
	 * 对话栏右沿 —— 分栏开着时对话栏变窄，标题就跟着窄，不会盖到右边那块上去。
	 * 用**测量**而不是算：侧栏宽度 + 各处 padding / gap + 分栏、换边、手机抽屉都会动，算不准。
	 */
	const [headingInset, setHeadingInset] = useState(0);
	const [headingWidth, setHeadingWidth] = useState<number | null>(null);
	const appbarMainRef = useRef<HTMLDivElement | null>(null);
	const workspaceRef = useRef<HTMLDivElement | null>(null);
	const rightColRef = useRef<HTMLDivElement | null>(null);
	const [contentSearchOpen, setContentSearchOpen] = useState(false);
	/**
	 * 「新建项目」对话框在这一层画（以前挂在 Sidebar 里）。
	 *
	 * 为什么搬上来：**侧栏收起时整个 Sidebar 不挂载**，而快捷键「新项目」要随时能用 ——
	 * 挂在下面的话收着侧栏按 ⌘M 就是「点了没反应」。侧栏里那颗「＋ 新建项目」现在通过
	 * `onNewProject` 回调上来，两处共用同一份 state。
	 */
	const [newProjectOpen, setNewProjectOpen] = useState(false);
	/**
	 * 分栏里**对话在哪一侧**（ADR：跟工作区对调）。
	 *
	 * 默认对话在左、工作区在右。用户要求能对调：右键顶栏那颗会话标题 → 菜单第一项
	 * 「移至右侧面板 / 移至左侧」一键换边，偏好记在本机（跟侧栏宽度同一档界面偏好）。
	 * 实现上只换 `.right-upper` 的 flex 方向（CSS `row-reverse`）+ 把分隔线和拖拽条换边，
	 * DOM 顺序不动 —— 这样标签顺序、焦点顺序、无障碍树都还是“对话在前”。
	 */
	const [chatSide, setChatSide] = useState<"left" | "right">(() =>
		readStored(SPLIT_CHAT_SIDE_KEY) === "right" ? "right" : "left",
	);
	const moveChatSide = () => {
		const next = chatSide === "right" ? "left" : "right";
		setChatSide(next);
		writeStored(SPLIT_CHAT_SIDE_KEY, next);
	};
	/**
	 * 「文件 ▾」下拉框选中的那个项目，`null` = 跟随当前会话工作区。
	 *
	 * **必须在 App 这一层**：以前它是 Sidebar 自己的 state，而全文搜索浮层挂在 App 上、
	 * 只能拿到 `snapshot.files.root`（会话工作区）—— 于是下拉框切到 A 项目、
	 * 搜出来还是 B 项目的行（用户截图里正是这个）。现在两边共用同一个数：
	 * 下拉框选哪个项目，内容搜索就**只在那个项目里**搜。
	 */
	const [fileTreeRoot, setFileTreeRoot] = useState<string | null>(null);
	/**
	 * 「把这个文件在两棵树里定位出来」的信号（左树 + 面板里的文件列表）。
	 *
	 * 为什么要一个信号而不是让两边自己看 `activePath`：切标签 / 在树里点文件都会改 activePath，
	 * 若每变一次就展开 + 滚一遍，用户手动翻到的地方会被一次次抽走。
	 * 只有**真的“打开了一个文件”**（内容搜索 / 文件搜索 / 改动 chip / 树里点）才撞 seq，
	 * 树接到新 seq 才动手：逐层展开祖先目录，最后把那一行选上并滚进视野。
	 */
	const [fileReveal, setFileReveal] = useState<{ path: string; seq: number }>({ path: "", seq: 0 });
	/**
	 * 左侧「文件管理」展开着没有 —— **提到 App 这一层**，是因为右侧工具落地页那张「文件」卡
	 * 现在的作用就是「把左边这一块打开」，然后从左边挑文件（点文件才开标签）。
	 * 以前 Sidebar 自己关着这个状态，外面够不着，落地页只能自己再开一个重复的文件树标签。
	 */
	const [filesOpen, setFilesOpen] = useState(false);
	/**
	 * 「分栏铺到顶」（顶栏让位 + 右侧面板升到窗口最顶上，标签条占顶栏右半段）：
	 * 分栏开着、没铺开（铺开时左半边本来是面板）、不是手机壳（手机上分栏是整屏）才做。
	 */
	const splitLifted = previewVisible && !previewWide && !mobileShell;
	/**
	 * 「铺开」时的同一个动作：面板占满侧栏右边那一整块，于是它也升到窗口最顶上，
	 * 顶栏的中间/右半段（模型、设置、全屏、分栏那一串）就整个被它盖住 ——
	 * 只留下侧栏上方那一点点顶栏，标签条一直往左靠到侧栏边上。
	 * 这会儿不给顶栏让位（不设 padding-right）：让位是为了「给标签条腾地方」，
	 * 而铺开时标签条本来就占满整条，顶栏那半段被盖住即可。
	 * 想退出铺开：标签条最右边那颗 ⇄ 还在（它一直亮着）。
	 */
	const wideLifted = previewVisible && previewWide && !mobileShell;
	/**
	 * 「分栏铺到顶」的宽度：面板左边缘 → 窗口右边。
	 * 写进 `--split-w` 后，顶栏用它做 padding-right —— 右边的模型/设置/全屏/分栏这几颗
	 * 就跟着中间那块屏往左移，让出的一段正好给右侧面板的标签条（它升到了窗口最顶上）。
	 *
	 * 为什么量而不是算：面板宽度在面板自己手里（拖拽改宽 / 铺开 / 手机整屏 / 用户改过的宽度），
	 * 量一次 getBoundingClientRect 才是真值。
	 * 面板自己的「全屏」是 position:fixed 盖整窗，那时不升降（顶栏本来就被它盖住了）。
	 */
	useEffect(() => {
		const root = document.documentElement;
		if (!splitLifted) {
			root.style.setProperty("--split-w", "0px");
			root.style.setProperty("--top-lane", "0px");
			return;
		}
		const apply = () => {
			const bar = document.querySelector(".appbar") as HTMLElement | null;
			const panel = document.querySelector(".preview-panel") as HTMLElement | null;
			if (!bar || !panel) {
				root.style.setProperty("--split-w", "0px");
				return;
			}
			const barBox = bar.getBoundingClientRect();
			const panelBox = panel.getBoundingClientRect();
			// 让出去的宽度永远量「面板把它那一侧的顶栏挤掉了多少」：
			//   常态（面板在右）= 顶栏右边 → 面板左边缘；
			//   对调（面板在左）= 面板右边缘 → 顶栏左边。
			// 两种都量真元素，所以拖宽、换标签、窗口缩放都自动跟上。
			const gap = chatSide === "right" ? panelBox.right - barBox.left : barBox.right - panelBox.left;
			root.style.setProperty("--split-w", `${Math.max(0, Math.round(gap))}px`);
			/**
			 * 「左边那一路」（品牌 / 新会话 / 侧栏开关）那一组的右沿。
			 *
			 * **只有侧栏收起时才是问题**：那一刻面板贴到窗口最左边，它升到顶栏的标签条也顶到 0，
			 * 把这组盖住。所以给标签条让出这段宽度，这一组和它右边那道竖线就留在原地（用户要求）。
			 * 侧栏展开时面板本来就从侧栏右边开始，**再让就是白让**（标签条前面空出一大块，
			 * 用户截图里那个红框）—— 所以这种情况必须是 0。
			 */
			const side = document.querySelector(".appbar > .appbar-side") as HTMLElement | null;
			const lane =
				chatSide === "right" && collapsed && side ? Math.round(side.getBoundingClientRect().right - barBox.left) : 0;
			root.style.setProperty("--top-lane", `${Math.max(0, lane)}px`);
		};
		apply();
		// 拖宽、换标签、窗口缩放、铺开/收起：全靠观察真元素，不再手动同步一份宽度
		// （box: border-box：顶栏的 padding 会被这个数字改，只看 border-box 才不会自己振自己）
		const observer = new ResizeObserver(apply);
		for (const element of [
			document.querySelector(".appbar"),
			document.querySelector(".preview-panel"),
			document.querySelector(".appbar > .appbar-side"),
		]) {
			if (element) observer.observe(element, { box: "border-box" });
		}
		window.addEventListener("resize", apply);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", apply);
		};
	}, [splitLifted, chatSide, collapsed]);
	/** 分栏显示的是落地页而不是某个标签（点「+」或刚打开分栏时） */
	// 恢复出标签时不该盖一张「工具落地页」：有标签就直接回到标签上（没有才显示落地页）
	const [panelLanding, setPanelLanding] = useState(() => (restoredPanel.current?.tabs.length ?? 0) === 0);
	const [sideWidth, setSideWidth] = useState(() => readStoredWidth(readStored(SIDEBAR_WIDTH_KEY)));
	const dragging = useRef(false);

	useEffect(() => {
		writeStored(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	}, [collapsed]);
	useEffect(() => {
		writeStored("agent-web:appbar-hidden", appbarHidden ? "1" : "0");
	}, [appbarHidden]);
	useEffect(() => {
		writeStored(SIDEBAR_WIDTH_KEY, String(sideWidth));
	}, [sideWidth]);

	// 顶栏真实高度写进 CSS 变量：手机抽屉 / 右侧面板要靠它贴合，写死数字会留一条缝
	//
	// `box: "border-box"`：要量的是 `offsetHeight`（含内边距），而 ResizeObserver 默认只盯
	// **content-box** —— 手机上会话名那一行是靠 `.appbar` 的 padding-bottom 让出来的，
	// content-box 根本不变，默认设置下这个变量会一直停在旧值（抽屉与面板跟着错位）。
	useEffect(() => {
		const bar = document.querySelector(".appbar");
		if (!bar) return;
		const apply = () => {
			document.documentElement.style.setProperty("--appbar-h", `${(bar as HTMLElement).offsetHeight}px`);
		};
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(bar, { box: "border-box" });
		return () => observer.disconnect();
	}, []);

	// 拖拽：pointer 事件挂在 document 上，鼠标移出侧栏边缘也不会中断
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		/**
		 * 拖动期间给 `<html>` 挂一个 `is-resizing`：
		 * `preventDefault()` 只挡住"按下这一帧"的默认行为，鼠标稍微偏到文字上照样会把
		 * 侧栏/对话里的字拖成蓝底选中（松手后选区还留着）。类名里由 CSS 统一 `user-select: none`
		 * 与 `cursor: col-resize`，比在每个元素上写一遍可靠。
		 */
		document.documentElement.classList.add("is-resizing");
		const startX = event.clientX;
		/**
		 * 起点用**实际显示宽度**，不是存储值：窄窗下 CSS 把侧栏夹到 42vw，存储里可能还是 516px ——
		 * 拿 516 当起点的话，往左拖 10px 只是把 516 改成 506，屏幕上那 235px 一动不动（「拖不动」）。
		 */
		const startWidth = Math.min(sideWidth, sidebarMaxWidth(window.innerWidth));
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			// 上限跟着窗口算（`sidebarMaxWidth`，与 responsive.css 的 42vw 同一条规则）：
			// 窄窗里拖到上限就停，不存一个永远显示不出来的宽度
			setSideWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX), sidebarMaxWidth(window.innerWidth)));
		};
		const onUp = () => {
			dragging.current = false;
			document.documentElement.classList.remove("is-resizing");
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
			document.removeEventListener("pointercancel", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
		// 触控笔被系统收走 / 窗口失焦时不会来 pointerup：不兜住就会一直"粘"在拖动状态
		document.addEventListener("pointercancel", onUp);
	};
	// 右侧面板的标签：文件与终端共用（终端也在右侧，标签上标出来）
	const [panelItems, setPanelItems] = useState<PanelItem[]>(() => restorePanelItems(restoredPanel.current?.tabs ?? []));
	/**
	 * 在右侧面板打开一个文件（文件树点文件、消息尾部「改动过的文件」点 chip 都走这里）。
	 *
	 * `reveal` 只给消息里那些 chip 用：点「改动过的文件」时面板可能正收着，
	 * 而用户要看的就是它 —— 不顺手打开就等于点了没反应。
	 * 文件树不传：那块本来就在左侧，用户可能只是在浏览，不替他决定右栏开不开。
	 */
	/**
	 * 打开某个文件（侧栏文件树 / 消息里的路径 chip / 面板里的文件列表都走这一个口）。
	 *
	 * **打开就是要看**：不管从哪儿点的，三件事一起做 ——
	 *   1. 没有这个标签就加一条，有就切过去（同一个文件不会出现两份）；
	 *   2. 退出「工具落地页」（那四张「文件 / 终端 / 临时聊天 / 网页」的卡片）；
	 *   3. 分栏没开就打开它。
	 * 以前 2、3 只对「消息里的 chip」生效（一个 `reveal` 开关），于是从左边文件树点文件时
	 * 标签开出来了、右边却还停在落地页上 —— 看着像「点了没打开」。
	 */
	/**
	 * 分栏开关：**顶栏最右那颗**和**面板标签条最右那颗**共用这一份
	 * （面板升到顶栏那一行之后，这一排的最右端就落到标签条上了）。
	 */
	const toggleSplit = useCallback(() => {
		const next = !previewVisible;
		setPreviewVisible(next);
		// 打开时没标签 → 先给落地页；已有标签 → 直接回到上一次那个
		if (next) setPanelLanding(panelItems.length === 0);
		// 收起时必须退出铺开：否则 workspace 和面板都不渲染 = 整块空白
		if (!next) setPreviewWide(false);
	}, [previewVisible, panelItems.length]);

	/**
	 * 当前会话工作区的**镜子**：`openFileInPanel` 声明在 `snapshot` 之前，不能直接引 `workspaceRoot`
	 * （依赖数组在定义那一瞬就要读到它，会撞 TDZ）；回调只在用户操作时才跑，那时 ref 已经填好了。
	 */
	const workspaceRootRef = useRef<string | null>(null);
	const openFileInPanel = useCallback((path: string, fileRoot: string, mode?: "diff", line?: number) => {
		const id = `file:${fileRoot}:${path}`;
		setPanelItems((current) => {
			const existing = current.find((item) => item.id === id);
			if (!existing)
				return [
					...current,
					{ id, kind: "file", path, root: fileRoot, ...(mode ? { mode } : {}), ...(line ? { line } : {}) },
				];
			// 已经开着：只把「这次想要的那一屏」换掉 —— 从 chip 点进来是要看改动、从全文搜索点进来是要看某一行，
			// 不能因为标签早开着就忽略（否则点搜索结果没反应，像是没搜到）
			if (existing.kind !== "file") return current;
			if (existing.mode === mode && existing.line === line) return current;
			return current.map((item) => (item.id === id ? { ...item, mode, line } : item));
		});
		setActiveItem(id);
		setPanelLanding(false);
		setPreviewVisible(true);
		// 左边也跟着走过去：文件不在左树当前根下面时，先把根切到它所属的项目
		// （不切的话它根本不在这棵树里，展开再多层也定位不到）。
		// 打开的是会话工作区里的文件：保留 `null`（= 「文件 ▾」仍跟随当前会话，不被默默改成固定值）。
		setFileTreeRoot((current) => nextTreeRoot(current, workspaceRootRef.current, fileRoot));
		setFileReveal((current) => ({ path, seq: current.seq + 1 }));
	}, []);
	/**
	 * 消息里那些 chip 的回调必须是**稳定引用**：MessageView 是 memo 的，
	 * 每次父组件渲染都换一个新箭头函数会让整屏消息跟着重算（流式期间每帧都渲染）。
	 * `mode: "diff"` = 点「改动过的文件」直接看「改了什么」，而不是先看一遍全文。
	 */
	const openFileFromMessage = useCallback(
		(path: string, root: string | null) => openFileInPanel(path, root ?? "", "diff"),
		[openFileInPanel],
	);
	/**
	 * 右侧面板此刻**真的在显示**吗：铺开（previewWide）会把 workspace 整块替换掉，
	 * 所以「铺开」必须和「面板可见 + 有内容」绑在一起 —— 不然收起面板时会剩一片空白，
	 * 连输入框都没有（用户只能靠再点开面板才能救回来）。
	 */
	const panelOpen = previewVisible;
	// 刷新前聚焦的那条；它可能已经不在（文件删了 / 变了），渲染时会回落到第一条
	const [activeItem, setActiveItem] = useState<string | null>(() => restoredPanel.current?.active ?? null);
	/**
	 * 记住右侧分栏这一屏（标签 / 聚焦哪条 / 开没开）：刷新后原样回来。
	 * 存得很小（只存路径与地址），每次变化写一次也没负担；写失败（隐私模式）就算了。
	 */
	useEffect(() => {
		writeStored(PANEL_STATE_KEY, serializePanelState(panelItems, activeItem, previewVisible));
	}, [panelItems, activeItem, previewVisible]);
	const [termSeq, setTermSeq] = useState(0);
	/** 分栏里那些工具标签的序号（网页 / 临时聊天各自递增，标签不重名） */
	const [toolSeq, setToolSeq] = useState(0);
	/** 关一个标签：临时聊天要把那条独立通道也断开（否则 SSE 会一直挂着） */
	/**
	 * 关标签：右键菜单的四种「关当前 / 左侧 / 右侧 / 全部」都走这一个口。
	 *
	 * 临时聊天要顺手把那条独立通道断开（否则 SSE 一直挂着）；关光了就回落地页 ——
	 * 用户关的是「这些标签」，不是「分栏」。
	 */
	const closePanelTabs = useCallback((ids: string[]) => {
		if (ids.length === 0) return;
		const kill = new Set(ids);
		setPanelItems((current) => {
			for (const item of current) if (kill.has(item.id)) disposePanelItem(item);
			const next = current.filter((item) => !kill.has(item.id));
			if (next.length === 0) setPanelLanding(true);
			return next;
		});
		setActiveItem((current) => (current && kill.has(current) ? null : current));
	}, []);
	/** 标签拖拽换序：只动顺序，不动内容（终端的 PTY、网页的历史都不受影响） */
	const reorderPanelTabs = useCallback((ids: string[]) => {
		setPanelItems((current) => {
			const byId = new Map(current.map((item) => [item.id, item]));
			const next = ids.map((id) => byId.get(id)).filter((item): item is PanelItem => item !== undefined);
			// 数量对不上（中途开了/关了标签）就不改，免得把新标签弄丢
			return next.length === current.length ? next : current;
		});
	}, []);
	/** 顶栏菜单当前打开哪个面板（受控：子代理徽标也要能把它顶到「子代理」那一格） */
	const [menuPanel, setMenuPanel] = useState<MenuPanel>(null);
	/**
	 * 顶栏到底显示哪些入口：设置里「顶栏」那组勾选框说了算（存 localStorage）。
	 * 默认只显示模型 / 技能 / 语音 / MCP（见 `APPBAR_ITEM_DEFAULT_ON`）。
	 * 「设置」永远留着 —— 它就是把这些入口重新勾回来的地方。
	 */
	const [appbarItems] = useAppbarItems();
	/** 顶栏那颗「临时会话」要不要画：设置 → 界面 → 顶栏里勾（默认不显示，见 ui-prefs） */
	const [showTempChat] = useStoredBool(APPBAR_TEMPCHAT_KEY, APPBAR_TEMPCHAT_DEFAULT);
	const menuItems: MenuPanel[] = [...APPBAR_ITEMS.filter((item) => appbarItems[item]), "settings"];
	/**
	 * 这里不能再走全量订阅（store 的默认钩子）：draft 每敲一个字符都会 setAppState，
	 * 全量订阅会把侧栏（几百行项目 / 会话）和整屏消息一起重渲染 —— 打字先卡住输入框自己。
	 */
	const snapshot = useAppSelector((state) => state.snapshot);
	const creating = useAppSelector((state) => state.creating);
	const newSession = useAppSelector((state) => state.newSession);
	const pendingActive = useAppSelector((state) => state.pendingActive);
	/** 刚发出 `new_chat`、服务端还没把视图切过来：这一小段不能让屏幕退回上一条会话的正文（见下面 `messages`） */
	const pendingNewChat = useAppSelector((state) => state.pendingNewChat);
	const lastError = useAppSelector((state) => state.lastError);
	const connection = useAppSelector((state) => state.connection);
	/** 本地缓存先铺上的会话正文（切会话首屏用）：服务端快照一到就退休 */
	const previewCache = useAppSelector((state) => state.preview);
	/**
	 * 消息正文里常只写文件名（`query-workflows.md`），**真实地址在工具参数里**。
	 * 这里只镜一份「最新的消息数组」：索引在**点击时**才算（流式期间每帧都会重渲染，
	 * 每次把所有工具参数 JSON 解一遂太贵）。
	 */
	const messagesRef = useRef<UiMessage[]>([]);
	/**
	 * 消息里点了「文件路径」：不强制 diff —— 打开的是这个文件本身
	 * （html 渲染成页面、md 看正文、其它看源码，由预览面板自己判断）。
	 * 只写了文件名的：先换回模型当时用的真实地址，换不回来就交给服务端按文件名/后缀去找。
	 */
	const openPathFromMessage = useCallback(
		(path: string) => {
			const real = realPathForToken(path, toolPathUses(messagesRef.current)) ?? path;
			openFileInPanel(real, snapshot?.files?.root ?? "");
		},
		[openFileInPanel, snapshot?.files?.root],
	);
	// 切会话时可能还没等到服务端快照：如果浏览器本地缓存里有这份正文，先铺上（首屏不等网络），
	// 快照一到 ws.ts 会把 preview 清掉，自动换成权威数据。
	const activeId = snapshot?.active.conversationId ?? null;
	const workspaceRoot = snapshot?.files?.root ?? null;
	// 把它镜到 ref 里给 `openFileInPanel` 用（那个回调声明在前面，拿不到这个常量）
	workspaceRootRef.current = workspaceRoot;
	/** 内容搜索的根：优先跟「文件 ▾」下拉框，没选过才回落到会话工作区（两边同一个数） */
	const searchRoot = fileTreeRoot ?? workspaceRoot;
	/**
	 * 面板里此刻真的在看的那个文件（跟 PreviewPanel 同一个取法：`activeItem`，没选就第一条）。
	 * 左边那棵树靠它把对应行选上 —— 所以手动切标签时两边的“当前文件”也对得上，
	 * 而不只是点开的那一下才对齐。
	 */
	const activePanelFile = (() => {
		const item = panelItems.find((entry) => entry.id === (activeItem ?? panelItems[0]?.id ?? ""));
		return item !== undefined && item.kind === "file" ? item : null;
	})();

	/**
	 * 传给侧栏的东西必须**引用稳定**：Sidebar 是 memo 的，而正文每帧都在变 ——
	 * 这里要是用内联数组 / 内联箭头，每帧都是新引用，memo 立刻被击穿（等于没加）。
	 * 快照的结构共享（ws.ts → snapshot-share.ts）保证「内容没变」的分片引用也不变。
	 */
	const sidebarConversations = useMemo(
		() => (snapshot?.conversations ?? []).filter((item) => !isSideConversation(item.id)),
		[snapshot?.conversations],
	);
	const sidebarProjects = useMemo(() => snapshot?.piProjects ?? [], [snapshot?.piProjects]);
	const sidebarRunningIds = useMemo(
		() => Object.keys(snapshot?.runningByConversation ?? {}),
		[snapshot?.runningByConversation],
	);
	/**
	 * 终端标签 id 里的自增序号放 ref 里：回调才能保持零依赖。
	 * 依赖 state 的话，每开一次终端回调就换一次引用，侧栏跟着重渲染一轮。
	 */
	const termSeqRef = useRef(termSeq);
	const openTerminal = useCallback((cwd: string) => {
		const id = `term:${termSeqRef.current}:${cwd}`;
		termSeqRef.current += 1;
		setTermSeq(termSeqRef.current);
		setPanelItems((current) => [...current, { id, kind: "terminal", cwd }]);
		setActiveItem(id);
		// 侧栏点「终端」就是要看到它：分栏没开 / 正在落地页都要拉回标签上
		setPreviewVisible(true);
		setPanelLanding(false);
	}, []);
	const openContentSearch = useCallback(() => setContentSearchOpen(true), []);
	const openNewProjectDialog = useCallback(() => setNewProjectOpen(true), []);
	const revealPathInTree = useCallback((path: string) => {
		// 文件名搜索点了目录：不开文件，只让左树展开到那儿（见 SidebarFiles 的 onPick）
		setFileReveal((current) => ({ path, seq: current.seq + 1 }));
	}, []);
	/**
	 * 落地页上点一个工具：文件 / 终端 / 临时聊天 / 网页。
	 *
	 * 「文件」和「临时聊天」同一个工具只开一个（再点一次就切回去，不往标签栏里堆）：
	 * 文件树是「看工作区」的固定窗口，临时聊天则是一个能一直问下去的窗口；
	 * 网页与终端相反 —— 多开才是正常的（几个站点、几个 shell）。
	 */
	const openTool = useCallback(
		(tool: WorkTool) => {
			/**
			 * 「文件」这张卡不在这里开标签：它做的是「把左边那栏文件管理打开」——
			 * 挑文件发生在左边，点文件才在右边多一个标签（用户要求的顺序）。
			 * 手机上顺手把抽屉抽出来，否则展开了也看不见。
			 */
			if (tool === "files") {
				setFilesOpen(true);
				setCollapsed(false);
				return;
			}
			setPreviewVisible(true);
			setPanelLanding(false);
			if (tool === "side") {
				/**
				 * 临时聊天**可以开多条**（用户要求）：每条一条标签、一条独立通道、一条独立临时会话，
				 * 互不干扰（比如「这条查日志 / 那条写文案」）。以前这里有个「已经有一条就切回去」的
				 * 限制，等于只能开一个。
				 */
				const id = `side:${toolSeq}`;
				setPanelItems((current) => [...current, { id, kind: "side" }]);
				setActiveItem(id);
				setToolSeq((value) => value + 1);
				return;
			}
			const id = `${tool}:${toolSeq}`;
			setToolSeq((value) => value + 1);
			setPanelItems((current) => [
				...current,
				tool === "terminal" ? { id, kind: "terminal", cwd: workspaceRoot } : { id, kind: "web", url: "" },
			]);
			setActiveItem(id);
		},
		[toolSeq, workspaceRoot],
	);
	/**
	 * 可自定义快捷键（设置 → 快捷键）：键表存在本机，这套派发器只负责「按到的组合键 → 动作」。
	 *
	 * 为什么用 ref 存最近的闭包而不是把一堆 state 塞进依赖数组：
	 * 快捷键监听只在挂载时装一次（每次重挂都会漏掉「按下与松开之间」的事件，
	 * 流式期间还会因为 state 一直在变而反复重挂），所以动作表用 ref 取最新的一份。
	 */
	const [shortcuts] = useShortcuts();
	const shortcutsRef = useRef(shortcuts);
	shortcutsRef.current = shortcuts;
	const runShortcutAction = useCallback(
		(id: ShortcutId) => {
			switch (id) {
				case "newChat":
					startNewSession();
					return;
				case "newProject":
					// 对话框在 App 这一层：侧栏收起时整个 Sidebar 不挂载，挂在它里面的话快捷键就哑了
					setNewProjectOpen(true);
					return;
				case "tempChat":
					openTool("side");
					return;
				case "settings":
					setMenuPanel("settings");
					return;
				case "openRight":
					if (!previewVisible) toggleSplit();
					return;
				case "closeRight":
					if (previewVisible) toggleSplit();
					return;
				case "toggleLeft":
					setCollapsed((value) => !value);
					return;
				case "files":
					// 跟右侧落地页那张「文件」卡同一个行为：左树打开、并确保侧栏展开（否则展开了也看不见）
					setFilesOpen(true);
					setCollapsed(false);
					return;
				case "terminal":
					openTool("terminal");
					return;
				case "contentSearch":
					setContentSearchOpen(true);
					return;
				case "cheatSheet":
					toggleShortcutSheet();
					return;
			}
		},
		[openTool, previewVisible, toggleSplit],
	);
	const runShortcutRef = useRef(runShortcutAction);
	runShortcutRef.current = runShortcutAction;
	/**
	 * 全局快捷键派发（全部可改：设置 → 快捷键）。
	 *
	 * 三个必须的过滤：
	 *  - `event.repeat`：按住不放不连环开面板；
	 *  - `event.defaultPrevented`：设置里「录制组合键」那一层会在捕获阶段截胡并 `preventDefault`，
	 *    这里就别再执行一遍（否则录一个 ⌘K 会顺手开一条新会话）；
	 *  - 没带 Mod / Alt 的组合根本不会产生（`comboFromEvent` 的约定），所以在输入框里打字安全。
	 */
	useEffect(() => {
		const onKey = (event: KeyboardEvent) => {
			if (event.repeat || event.defaultPrevented) return;
			const id = shortcutFor(shortcutsRef.current, event);
			if (!id) return;
			event.preventDefault();
			runShortcutRef.current(id);
		};
		window.addEventListener("keydown", onKey);
		return () => window.removeEventListener("keydown", onKey);
	}, []);

	/**
	 * 「在临时聊天中提问」（选中文字后那颗右边的按钮）：
	 * 开（或切回）右侧那条临时聊天，把选中那段当引用**预填**进它的输入框。
	 * 只开一条：跟落地页上那张「临时聊天」卡同一个规矩，不往标签栏里堆。
	 */
	const askInSideChat = useCallback(
		(text: string) => {
			setPreviewVisible(true);
			setPanelLanding(false);
			const existing = panelItems.filter((item) => item.kind === "side");
			const id = existing.length > 0 ? (existing[existing.length - 1]?.id ?? "side:0") : `side:${toolSeq}`;
			if (existing.length === 0) {
				setToolSeq((value) => value + 1);
				setPanelItems((current) => [...current, { id, kind: "side" }]);
			}
			setActiveItem(id);
			// 引用后面留一个空行：紧接着就是「你要问什么」
			sideChannelFor(id).setDraft(`${quoteOf(text)}

`);
		},
		[panelItems, toolSeq],
	);
	/**
	 * 抬头「↑ 有新版」点一下：在右侧面板开一个终端标签，并把升级命令**自动敲进去 + 回车**。
	 *
	 * 为什么走终端而不是直接调 `aw upgrade`：升级要装全局包、可能卡网络或权限，
	 * 用户在终端里能看全过程、能自己重试；而且「装完记得重启」也是他能直接执行的动作。
	 * 面板要是收着，得顺手展开 —— 不然命令在跑，人却看不到任何反应。
	 */
	const upgradeInTerminal = useCallback(
		(command: string) => {
			// 每次点都是一个新 id：重复点不能把上一轮正在跑的安装终端顶掉（那是用户要看的东西）
			const id = `term:upgrade:${Date.now().toString(36)}`;
			setPanelItems((current) => [
				...current,
				{ id, kind: "terminal", cwd: workspaceRoot, label: "终端 · 升级", initialCommand: command },
			]);
			setActiveItem(id);
			setPreviewVisible(true);
			setPanelLanding(false);
		},
		[workspaceRoot],
	);
	const preview = previewCache && previewCache.conversationId !== activeId ? previewCache : null;
	/**
	 * 「新会话界面」（`store.ts` 的 `newSession`）：点了「新会话」，服务端**什么都还没建**。
	 *
	 * 这一刻屏幕上要装成「一条空会话」：不带任何旧消息、没有旧会话的标题、
	 * 工具行里（模型左边）多出「项目 · 分支」（`NewSessionScope`）。整屏**不碰服务端**，
	 * 直到用户发出第一条消息才 `new_chat`（见 `ws.ts` 的 `createSessionAndSend`）——
	 * 用户明确要求：别每点一次「新会话」，项目列表里就多一条空会话。
	 *
	 * `pendingNewChat`（`ws.ts` 的 `newChat`）是同一屏的尾巴：`new_chat` 已经发出、服务端
	 * 还没把视图切过去的那一个往返。这段时间里 `snapshot.active` 仍是**上一条会话** ——
	 * 要是还按它渲染，屏幕上就先闪一段别人的对话，然后才换成新会话（用户 2026-10-30：
	 * 「新会话第一次发文字的时候，屏幕上会闪现出来一些别的文字，好像串台」）。
	 * 没 新会话屏 的建会话入口（斜杠 `/new`、新建项目对话框）也走这一位，效果一样：空对话。
	 */
	const messages = newSession || pendingNewChat ? [] : (preview?.messages ?? snapshot?.active.messages ?? []);
	// 给「点消息里的文件链接」用（声明在它上面的那个 callback 通过 ref 取最新一份）
	messagesRef.current = messages;
	/**
	 * 当前这条会话是不是「临时对话」（= pi 的 `--no-session`：只活在内存里）。
	 * 是的话顶部挂一条提示条：用户必须能随时看出来「这些东西关掉就没了」。
	 */
	const activeConversation = snapshot?.conversations.find((item) => item.id === snapshot.active.conversationId) ?? null;
	const ephemeralActive = newSession || pendingNewChat ? false : activeConversation?.ephemeral === true;
	/**
	 * 当前这条会话的「项目名 + 会话名」——**顶栏中间那颗标题与浏览器标签页标题共用同一份**。
	 *
	 * 会话可能在「本进程新建的」清单里，也可能只是 pi 里的历史会话（`piProjects`）；
	 * 服务端可以省掉后一份清单（见 protocol.ts），而自家清单里也可能还没有它。
	 * 两处都不拿着就返回空，宁可不显示，也不要凭空编一个名字。
	 */
	const activeHeading = (() => {
		// 新会话界面：标题写「新对话」，项目名跟着这条新会话的项目走（选下拉框时立刻跟着变）
		// 建会话在飞的那段（`pendingNewChat`，如 `/new`）也归这一档：那一刻 active 还是上一条，
		// 照画就是别人的标题挂在这块空屏上。
		if (newSession || pendingNewChat) {
			const workspace = newSession ? newSession.workspace : (snapshot?.files?.root ?? null);
			return {
				project: workspace ? basename(workspace) : "",
				title: t("新对话", "New chat"),
			};
		}
		const id = snapshot?.active.conversationId ?? null;
		if (!snapshot || !id) return { project: "", title: "" };
		const own = snapshot.conversations.find((item) => item.id === id);
		const piProject = (snapshot.piProjects ?? []).find((project) =>
			project.sessions.some((session) => session.id === id),
		);
		const piSession = piProject?.sessions.find((session) => session.id === id);
		return {
			project: basename(own?.workspace ?? piProject?.cwd ?? snapshot.files?.root ?? ""),
			title: own?.title ?? piSession?.title ?? "",
		};
	})();
	/** 顶栏标题上右键：弹的是**跟侧栏那一行同一张菜单**（`SessionMenu`），动的是当前这条会话 */
	/** 顶栏标题那张菜单开着没有（位置与尾巴都由锚点元素自己算，不需要鼠标点） */
	const [headingMenu, setHeadingMenu] = useState(false);
	/**
	 * 菜单的锚点 = **那颗标题本身**（不是整块 `.appbar-slot`）。
	 * 整块很宽（撑满剩余宽度），拿它当锚点会让菜单贴到最右边、尾巴离标题十万八千里；
	 * 拿标题当锚点，菜单就长在标题旁边、尾巴正好指着「现在是哪条会话」（用户 2026-10-29 的要求）。
	 */
	const [headingMenuAnchor, setHeadingMenuAnchor] = useState<HTMLElement | null>(null);
	/**
	 * 顶栏那张菜单要的东西：当前会话 id + 是否置顶 + 归档/删除都走 `session-actions.ts`
	 * （跟侧栏同一份实现：会话偏好是整表覆盖写的，各写一份就会互相覆盖）。
	 */
	const activeSessionId = snapshot?.active.conversationId ?? null;
	/**
	 * 这条对话里的「标注」（选中文字 → 编号 + 可选评论，见 annotations.ts）。
	 * 按会话分开存在 localStorage 里：换会话就整批换掉，不会把 A 的编号画到 B 的正文上。
	 * 默认收起 —— 正文里已经有编号了，输入区上方只回答「我标了几处」。
	 */
	const [annotations, setAnnotations] = useState<Annotation[]>([]);
	const [annotationsOpen, setAnnotationsOpen] = useState(false);
	const [focusedAnnotation, setFocusedAnnotation] = useState<string | null>(null);
	useEffect(() => {
		setAnnotations(readAnnotations(window.localStorage, activeSessionId));
		setAnnotationsOpen(false);
		setFocusedAnnotation(null);
	}, [activeSessionId]);

	/**
	 * 真正拿去画、拿去发的标注。
	 *
	 * 「新会话」界面恒为空：那一刻 `active.conversationId` 还指着**上一条**会话
	 * （地址栏要等第一条消息发出去才换），照旧用它会把这旧会话的「N 条注释」画到
	 * 空白的欢迎页上；Composer 还会把它们当成待发内容 —— 回车就把别人的标注
	 * 混进了这条新会话。
	 * `pendingNewChat`（`new_chat` 在飞）同理：那一段 active 也还是上一条会话。
	 */
	const shownAnnotations: readonly Annotation[] = newSession || pendingNewChat ? [] : annotations;

	/**
	 * 「添加到会话」（在对话里选中一段文字后那颗）：**一次做完两件事**。
	 *
	 *   1. 在正文里留一个编号（`annotations.ts`）—— 那段文字被标住了，回看时认得出位置；
	 *   2. 输入框**里面**那颗「N 条注释」多一条（评论在那边就地补写，见 AnnotationSummary）。
	 *
	 * 以前这是两颗钮（「添加到对话」往草稿里塞引用 + 「标注」留编号），用户得先想清楚
	 * 自己要的是哪个；其实它们就是同一件事。**草稿一个字都不动**：标的时候用户往往
	 * 正在打自己的问题，往里塞东西就是在抢他的输入 —— 想真把引文写进草稿就点列表里的
	 * 「放进输入框」。
	 */
	const addSelectionToSession = useCallback(
		(input: SelectionAddInput) => {
			// 同一处再点一次：不叠第二个编号（编号是用来跟正文对位的），也不重复动任何东西
			if (input.anchor !== null && findSameSpot(annotations, input.messageId, input.anchor) >= 0) {
				showToast({ text: t("这一处已经在会话里了", "That spot is already in this session"), ttl: 2000 });
				return;
			}
			if (input.anchor === null || input.messageId === "") {
				// 量不到锚点（DOM 刚好被换掉）：至少给一句话，不要点了没反应
				showToast({
					text: t("这一段量不出位置，试一下重新选中", "Could not locate that passage — try selecting it again"),
				});
				return;
			}
			const createdAt = Date.now();
			const next = addAnnotation(annotations, {
				id: `${input.messageId}:${createdAt}:${annotations.length}`,
				messageId: input.messageId,
				anchor: input.anchor,
				// 评论在工具栏那一步就写好了（小输入框，可留空）；不再弹第二次框拦一道
				comment: input.comment,
				createdAt,
			});
			setAnnotations(next);
			writeAnnotations(window.localStorage, activeSessionId, next);
			/**
			 * **不自动展开**（用户要求：「标完只留胶囊」）。
			 * 以前每标一段就往输入框里摊一整块（编号 + 原文 + 改评论/放进输入框/✕），
			 * 连续标几句就变成一大片噪声；而且评论刚在上面那颗小输入框里写完，
			 * 再摊一遍等于把同一个东西说两遍。要核要改就点那颗「N 条注释」自己展开。
			 */
			setFocusedAnnotation(null);
			showToast({ text: t("已添加到会话", "Added to this session"), ttl: 2000 });
		},
		[annotations, activeSessionId, t],
	);

	/** 删掉一条标注（列表里那颗 ✕）：正文里的编号跟着重排 */
	const removeAnnotationById = useCallback(
		(id: string) => {
			const next = removeAnnotation(annotations, id);
			setAnnotations(next);
			writeAnnotations(window.localStorage, activeSessionId, next);
			if (focusedAnnotation === id) setFocusedAnnotation(null);
		},
		[annotations, activeSessionId, focusedAnnotation],
	);

	/**
	 * 标注随消息发出去之后清空（`Composer` 发完回调 `onAnnotationsSent`）。
	 * 不清的话，下次草稿空着再按回车就会把同一批又发一遍。
	 */
	const clearSentAnnotations = useCallback(() => {
		setAnnotations([]);
		writeAnnotations(window.localStorage, activeSessionId, []);
		setAnnotationsOpen(false);
		setFocusedAnnotation(null);
	}, [activeSessionId]);

	/**
	 * 「放进输入框」：把这条标注的原文（引用块）+ 我自己的评论接进草稿。
	 * 编号也写进去（跟「一键发送全部标注」一致）：正文里那串编号模型看不见，不写就无从对应。
	 * 评论跟引用**空一行**隔开：粘在一起会被当成引文的一部分，模型分不清哪句是我说的。
	 *
	 * 接进草稿之后把这条标成 `quoted`：发送时它就不会再被自动追加一遍（不然同一段发两次）。
	 */
	const quoteAnnotation = useCallback(
		(item: Annotation) => {
			const number = annotationNumber(annotations, item.id);
			const block = annotationBlock(item, number > 0 ? number : 1);
			setDraft(appendQuote(getAppState().draft, block));
			const next = markQuoted(annotations, item.id);
			setAnnotations(next);
			writeAnnotations(window.localStorage, activeSessionId, next);
			window.setTimeout(focusComposer, 0);
			showToast({ text: t("已放进输入框", "Added to the input"), ttl: 2200 });
		},
		[t, annotations, activeSessionId],
	);

	/** 列表里就地写/改一条的评论（空串 = 清掉）：正文里的编号和胶囊上的说法都会跟着变 */
	const updateAnnotationComment = useCallback(
		(id: string, comment: string) => {
			const next = setAnnotationComment(annotations, id, comment);
			setAnnotations(next);
			writeAnnotations(window.localStorage, activeSessionId, next);
		},
		[annotations, activeSessionId],
	);

	/**
	 * 跳到正文里那一处：滚到那条消息、闪一下边框。
	 * 消息 id → DOM id 的拼法跟 MessageList 一致（`msg-<id>`）；消息已经被分页 / 删掉就什么都不做。
	 */
	const jumpToAnnotation = useCallback((item: Annotation) => {
		const target = document.getElementById(`msg-${item.messageId}`);
		if (target === null) return;
		target.scrollIntoView({ block: "center", behavior: "smooth" });
		// 先摘掉再强读一次布局，动画才会重新播（连点同一条也能再闪一次）
		target.classList.remove("annot-flash");
		void target.offsetWidth;
		target.classList.add("annot-flash");
		window.setTimeout(() => target.classList.remove("annot-flash"), 1300);
	}, []);

	/** 点正文里的编号：打开列表并定位到那一条（列表本身在输入区上方） */
	const focusAnnotation = useCallback((id: string) => {
		setAnnotationsOpen(true);
		setFocusedAnnotation(id);
		window.setTimeout(() => document.getElementById(`annot-row-${id}`)?.scrollIntoView({ block: "nearest" }), 0);
	}, []);
	const activeSessionPinned = activeSessionId
		? (snapshot?.settings.sessionPrefs.pinned ?? []).includes(activeSessionId)
		: false;
	/** 双击顶栏标题进入改名：草稿先钺上当前名字，输入框全选着（不用先删） */
	useEffect(() => {
		if (!headingEditing) return;
		setHeadingDraft(activeHeading.title);
		requestAnimationFrame(() => {
			headingInputRef.current?.focus();
			headingInputRef.current?.select();
		});
	}, [headingEditing, activeHeading.title]);
	/**
	 * 提交改名：清洗规则与侧栏会话行一致（空白归一 + 最长 60 字），
	 * 没真改就不发请求（否则每次双击再失焦都白推一次快照）。
	 */
	const commitHeading = () => {
		const id = snapshot?.active.conversationId ?? null;
		const next = headingDraft.replace(/\s+/g, " ").trim().slice(0, 60);
		setHeadingEditing(false);
		if (id && next !== "" && next !== activeHeading.title) renameSession(id, next);
	};
	/** 能不能从某条消息派生分支：引擎得有这能力，临时对话不行（没有会话文件可 fork） */
	const canFork = (snapshot?.engineCapabilities.forkChat ?? false) && !ephemeralActive;
	/**
	 * 临时对话能不能「转正」（保存为正式对话）：要引擎把内存会话落成真会话文件。
	 *
	 * 跟右侧那条临时聊天同一条判据（见 `SideChat.tsx`）：codex 这类引擎没有这一位，
	 * 那颗按钮点下去只会报 `engine.unsupported` —— 不如不画。提示条本身保留（那条事实是真的）。
	 */
	const canPersistEphemeral = snapshot?.engineCapabilities.ephemeralChat === true;
	/**
	 * 本轮起点 = 最后一条用户消息的时间。
	 * 顶栏的子代理徽标只认这一轮：发新消息之后，上一问的子代理（以及那个小图标）应当退场。
	 */
	const turnStartedAt = turnStartedAtOf(messages);
	/** 归本会话（或与会话无关）的错误才显示 */
	const visibleError =
		lastError &&
		(lastError.conversationId === null || lastError.conversationId === (snapshot?.active.conversationId ?? null))
			? lastError.text
			: null;
	// 刚点下、服务端还没把这一份快照推回来（乐观高亮已生效）。
	//
	// 只在**屏幕上什么都没有**的时候才给这颗泡泡：
	//   · 有本地缓存预览（`preview`）→ 正文已经铺满屏幕了，再盖一颗「正在同步…」
	//     只会让人觉得慢（用户 2026-10-30：「内容不是瞬间就出来了吗？为什么老显示这个」）。
	//     这一下服务端实测只有 0~10ms，剩下的时间全是本机渲染，泡泡没有任何信息量；
	//   · 没有缓存（第一次开这条会话）→ 屏幕是空的，这时候它真的在报「还没好，等一下」。
	const switching = pendingActive !== null && pendingActive !== activeId && preview === null;
	// 地址栏 ↔ 当前会话（?session=xxx）
	const urlSession = useRef<string | null>(sessionIdFromUrl(window.location.search));
	const appliedUrlSession = useRef(false);
	/** 这个标签页「认为自己正在看」的会话：重连后拿它跟服务端对账（见下面那个 effect） */
	const believedSession = useRef<string | null>(urlSession.current);
	useEffect(() => {
		const id = snapshot?.active.conversationId ?? null;
		if (id) believedSession.current = id;
	}, [snapshot?.active.conversationId]);
	useEffect(() => {
		if (connection !== "open") return;
		// 首次连上：把地址栏里的会话打开
		if (!appliedUrlSession.current) {
			appliedUrlSession.current = true;
			if (urlSession.current) void switchConversation(urlSession.current);
			return;
		}
		/**
		 * 以后每次重连：自己再声明一次「我在看哪条会话」。
		 *
		 * 服务端把「每个客户端在看哪」存在内存里（ADR-0033），重启 / 切引擎 / 视图被淘汰之后就忘了；
		 * 忘了以后给这个客户端的快照里 `active.conversationId` 就是 null —— 右侧**整块空白**
		 * （消息、思考、工具卡全没了，看上去像回合挂了），而服务端那条会话其实还好好的。
		 * 以前这里只做一次（`appliedUrlSession`），所以这之后只能靠用户手动点侧栏或刷新。
		 */
		if (getAppState().newSession) return; // 在「新会话界面」：别把人拽回上一条
		const target = believedSession.current;
		if (target) void switchConversation(target);
	}, [connection]);
	useEffect(() => {
		if (!snapshot) return;
		// 新会话界面（还没真建会话）：地址栏先别动。它现在指向上一条会话，
		// 等第一条消息发出去、新会话建好了，下面这行会跟着换过去。
		if (getAppState().newSession) return;
		// 只有地址栏仍保持初始值时才等待初始会话；用户点击侧栏后 ws.ts 已先改了地址，不能继续被旧值卡住。
		if (
			urlSession.current !== null &&
			sessionIdFromUrl(window.location.search) === urlSession.current &&
			snapshot.active.conversationId !== urlSession.current
		)
			return;
		urlSession.current = null;
		const href = sessionUrlFor(window.location.href, snapshot.active.conversationId);
		if (href !== `${window.location.pathname}${window.location.search}${window.location.hash}`) {
			window.history.replaceState(null, "", href);
		}
	}, [snapshot?.active.conversationId, newSession]);

	// 浏览器标签页标题：`对话名 - 项目名`，多开几个标签时一眼能分清
	// （跟顶栏中间那颗标题用的是同一份 `activeHeading`）。
	// 顺序**对话名在前**：标签页宽度有限，浏览器从头截断，项目名放前面时
	// 一眼看到的全是同一个项目名，对话名反而被省略号吃掉。
	useEffect(() => {
		const { project, title } = activeHeading;
		document.title = project && title ? `${title} - ${project}` : brandName;
	}, [activeHeading.project, activeHeading.title, brandName]);

	// 粘底滚动：条数、末条正文长度、流式文本任一变化都算「内容更新」
	const lastTextLength =
		messages.at(-1)?.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.text.length : 0), 0) ?? 0;
	/**
	 * 当前会话这一轮的真实进度（预览缓存里的旧快照不算）：
	 * 只在它不为 null 时才给消息区挂实时数字与「正在运行 / 等待」提示。
	 */
	const liveRunning =
		preview === null &&
		snapshot !== null &&
		snapshot.running.status !== "idle" &&
		snapshot.running.conversationId === snapshot.active.conversationId
			? snapshot.running
			: null;
	// 声音提示 + 语音播报：只盯「回合状态跳变」，一轮只响一次（见 use-voice-cues.ts）
	useVoiceCues(snapshot);
	// 「跑完了、你还没看」：同一份跳变，喂给侧栏的圆点（session-unseen.ts）
	useUnseenFinishWatch();
	const scroll = useStickToBottom(
		`${messages.length}:${lastTextLength}:${snapshot?.running.streamingText?.length ?? 0}:${snapshot?.active.conversationId ?? ""}`,
		snapshot?.active.conversationId ?? null,
	);
	const lastMessage = messages.at(-1);
	/** 「最后一条消息」的 id：顶栏那颗标题的右键菜单拿它做「从这儿分叉」（任何角色都行） */
	const lastMessageId = lastMessage?.id ?? null;
	/**
	 * 最后一条**用户消息**（插队的不算）。
	 *
	 * 为什么不是 `messages.at(-1)`：发出的瞬间服务端就会插一条 assistant 占位消息，
	 * 于是「末尾」立刻变成 assistant —— 早先按「末尾是 user」判断，锚点就永远不会触发
	 * （用户 2026-10-30：「还是没顶上去」）。盯最后一条用户消息才稳。
	 */
	const lastUserId = (() => {
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const item = messages[index];
			if (item && item.role === "user" && !item.steer) return item.id;
		}
		return null;
	})();
	/**
	 * 最新一条**排队 / 插队**消息的 id。
	 *
	 * 点建议按钮 / 快捷短语发出时，如果这一轮还在跑，消息先落进 `queued`（排队），
	 * 而不是 `messages`。以前锚点只盯 `messages` 里的用户消息 —— 于是这种「点出来的」消息
	 * 完全没人顶，就贴在输入框上方那一格（用户 2026-10-30：「不像我手动回车那样发到上面去」）。
	 */
	const lastQueuedId = (() => {
		const conversation = snapshot?.active.conversationId ?? null;
		const queued = (snapshot?.queued ?? []).filter((item) => item.conversationId === conversation);
		return queued.at(-1)?.id ?? null;
	})();
	/**
	 * 自己刚发出消息 → **把这条顶到视口上方**（用户 2026-10-30，照 codex）。
	 *
	 * 以前是「回到底部」：于是发出后画面贴着底边，回答是从最下面一行一行往上长，
	 * 屏幕下区挤、上区空着，眼睛要一直跟着底边走。现在发出去的消息自己往上顶（离顶 18px），
	 * 回答就从中上部往下长：跟读文档一样，视线是顺着往下走的。
	 *
	 * 回答短的时候不会跳回底部、超过一屏才继续跟着底边走（见 `stick-to-bottom.ts` 的两种模式）。
	 *
	 * **换会话不锚**：打开一条旧会话应该落在最新进度（底部），而不是被拽到「最后一条用户消息」处。
	 * **插队消息不锚**：那是打断正在跑的一轮，中途把画面抽到上方会很慌。
	 *
	 * **必须用 `useLayoutEffect`**：`useStickToBottom` 里跟 signal 的那个是**被动 effect**，
	 * 顺序上比这里晚；用 `useEffect` 会先按旧状态滚一次底，然后才被拉回上方 —— 一帧里先下后上。
	 */
	const anchorRef = useRef<AnchorSeen>({
		conversation: null,
		messageId: null,
		queuedId: null,
	});
	useLayoutEffect(() => {
		/**
		 * 顶到那条消息上方。节点没挂上就下一帧再试 —— 以前 `getElementById` 拿到 null
		 * 就静默放弃（`anchorTo(null)` 直接 return），表现就是「有时候顶了，有时候没顶」。
		 */
		const anchorToId = (id: string, tries = 4): void => {
			const node = document.getElementById(`msg-${id}`);
			if (node) {
				scroll.anchorTo(node);
				return;
			}
			if (tries > 0) requestAnimationFrame(() => anchorToId(id, tries - 1));
		};
		const next = nextAnchorTarget(anchorRef.current, {
			conversation: snapshot?.active.conversationId ?? null,
			messageId: lastUserId,
			queuedId: lastQueuedId,
		});
		anchorRef.current = next.seen;
		if (next.target !== null) anchorToId(next.target);
	}, [lastUserId, lastQueuedId, snapshot?.active.conversationId, scroll.anchorTo]);

	/**
	 * 侧栏 / 抽屉开关：**顶栏里一颗都不画**（桌面和手机一样，用户：「手机版的也一样哦」）。
	 *
	 * 收起 / 展开就是分割线上那对舌形箭头，两个方向、同一个位置：
	 *   展开态：`side-collapse`（`<`）骑在分栏线上，跟侧栏顶部对齐；
	 *   收起态：`side-expand`（`>`）挂在左侧边缘，跟它同一个高度。
	 * 以前这里还有一颗方图标（现在是全屏那颗在用的 `.appbar-side-btn` 样式），手机上更是只剩它 ——
	 * 于是同一件事有方图标 / 舌形两种样子、位置还差一整个顶栏高度（用户连着报了三次「要一样」）。
	 */

	/**
	 * 把「会话标题」摆到对话栏的范围内：左沿对齐对话栏左沿，宽度不越过对话栏右沿。
	 *
	 * 时机：布局后量（`useLayoutEffect`），免得用户看到标题先跳一下；
	 * 跟着変的东西靠 ResizeObserver 盯：拖侧栏分割线、开关分栏、拉窗口都会改对话栏宽度。
	 */
	useLayoutEffect(() => {
		const main = appbarMainRef.current;
		const chat = workspaceRef.current ?? rightColRef.current;
		if (!main || !chat) return;
		const measure = () => {
			const mainBox = main.getBoundingClientRect();
			const box = chat.getBoundingClientRect();
			// 顶栏被藏起来（`hidden`）/ 元素还没布局时 rect 全是 0：那一瞬不动，否则会把标题推到奇怪的地方
			if (mainBox.width === 0 || box.width === 0) return;
			const inset = Math.max(0, Math.round(box.left - mainBox.left));
			const width = Math.round(box.width);
			setHeadingInset((current) => (current === inset ? current : inset));
			setHeadingWidth((current) => (current === width ? current : width));
		};
		measure();
		const observer = new ResizeObserver(measure);
		observer.observe(main);
		observer.observe(chat);
		window.addEventListener("resize", measure);
		return () => {
			observer.disconnect();
			window.removeEventListener("resize", measure);
		};
		// 对话栏会在「铺开」时整块不渲染 / 侧栏收起时位置大变：这些都重新挂一次量尺
	}, [collapsed, mobileShell, sideWidth, previewVisible, previewWide, chatSide, appbarHidden]);

	return (
		<div
			className={`app${splitLifted ? " app-split" : ""}${wideLifted ? " app-wide-lift" : ""}${
				chatSide === "right" ? " app-flip" : ""
			}${collapsed ? " app-collapsed" : ""}`}
		>
			{switching || creating ? (
				<div className="switch-hint" role="status">
					{creating ? t("正在新建会话…", "Creating session…") : t("正在打开会话…", "Opening session…")}
				</div>
			) : null}
			{/* 顶部区域：**分成两段** —— 左边一段（`.appbar-side`）放「品牌 + 新会话 + 全屏」，
			   右边一段是各种入口。
			   左段的宽度**跟着它自己的内容走，跟侧栏宽度无关**（用户：「顶部这个宽度要固定，
			   下面的侧边栏变化跟上面没有关系」）：以前这里内联写 `width: sideWidth`，
			   拖宽侧栏时上面这段跟着变、品牌名忽长忽短。现在宽度在 CSS 里按内容定
			   （`.appbar-side-fixed`），拖侧栏只动下面那一栏。 */}
			<div className="appbar" hidden={appbarHidden}>
				<div
					className={`appbar-side${collapsed || mobileShell ? "" : " appbar-side-fixed"}`}
					// 宽度全靠 CSS：展开态 `max-content`（跟内容走，与侧栏宽度无关），收起 / 手机上也是
					// 跟内容走 —— 所以这里不再写内联宽度
				>
					{/* 侧栏 / 抽屉开关**不在顶栏**：桌面和手机都走那一对舌形箭头
					    （见下面 `side-collapse` / `side-expand` 两处，位置与图标完全一致）。 */}
					<span className="brand">
						{/* logo 也能关、也能换（设置 → 外观 → 顶栏名称）：换过就用本机那张 data URL */}
						{brand.logoShown ? (
							<img className="brand-icon" src={brand.logo || "/favicon.svg?v=4"} alt="" aria-hidden="true" />
						) : null}
						{/* 名字可以在设置 → 外观里隐藏或改名；藏掉后只留图标，宽度让给「新会话」 */}
						{brand.shown ? <span className="brand-name">{brand.name}</span> : null}
					</span>
					{/*
					 * 「新会话」：**常驻顶栏**，侧栏展开 / 收起都是这一颗（用户要求：放到顶部，
					 * 跟侧栏收起时出现的位置一样）。不再跟着侧栏开合换地方。
					 * 只有顶栏本身被藏起来（`appbarHidden`，状态栏那颗 ▴/▾）时，这一整条才不画，
					 * 那一刻由侧栏抬头接管同一颗（`Sidebar` 的 `appbarHidden` 分支，见 Sidebar.tsx）——
					 * 所以两处仍是「同一动作、任一时刻只有一颗」，只是优先级换成了「顶栏优先」。
					 * 「临时对话」那颗已去掉。
					 */}
					<NewChatButton />
					{/*
					 * 整页全屏（用户：「这里再加一个全屏按钮，可以加竖线左边」）。
					 *
					 * 位置：**顶栏左段的最右边**。原先它左边还有一道 `.appbar-divider` 跟「品牌 / 新会话」
					 * 分段，但这一段本身就窄，那道线紧贴着「新会话」胶囊、视觉上像是多出来的一根，
					 * 用户「全屏左边那条竖线不要」—— 已去掉，只留这颗方按钮。
					 *
					 * `supported` 为 false 时整组不画（iOS Safari 不支持元素全屏）：
					 * 点了没反应比没有按钮更糟。状态由 `fullscreenchange` 兜着，Esc 退出也亮/灭得对。
					 */}
					{fullscreen.supported ? (
						<span className="appbar-side-end">
							<button
								type="button"
								className={`appbar-side-btn${fullscreen.active ? " appbar-side-btn-on" : ""}`}
								onClick={fullscreen.toggle}
								aria-pressed={fullscreen.active}
								title={fullscreen.active ? t("退出全屏", "Exit full screen") : t("全屏", "Full screen")}
								aria-label={fullscreen.active ? t("退出全屏", "Exit full screen") : t("全屏", "Full screen")}
							>
								{/* 四角图标：进全屏是「往外张」，已在全屏时是「往里收」——同一个语汇，方向相反 */}
								<svg
									className="appbar-side-btn-icon"
									viewBox="0 0 16 16"
									fill="none"
									stroke="currentColor"
									strokeWidth={1.4}
									strokeLinecap="round"
									strokeLinejoin="round"
									aria-hidden="true"
								>
									{fullscreen.active ? (
										<>
											<path d="M2.6 6.4h3.8V2.6" />
											<path d="M13.4 6.4H9.6V2.6" />
											<path d="M2.6 9.6h3.8v3.8" />
											<path d="M13.4 9.6H9.6v3.8" />
										</>
									) : (
										<>
											<path d="M6.4 2.6H2.6v3.8" />
											<path d="M9.6 2.6h3.8v3.8" />
											<path d="M6.4 13.4H2.6V9.6" />
											<path d="M9.6 13.4h3.8V9.6" />
										</>
									)}
								</svg>
							</button>
						</span>
					) : null}
				</div>
				{/*
				 * 标题一侧整组（会话名 + 子代理徽标 + 入口排 + 分栏）单独包一层：它同时是**尺寸容器**
				 * （app-bar.css 里的 `@container`）—— 要量的就是「左侧那段吃完之后还剩多宽」。
				 * 以前容器是 `.appbar` 自己，量的是**整条栏**（≈ 窗口宽），没扣掉侧栏宽度：
				 * 侧栏一宽，入口排还以为自己有地方放文案，于是把会话标题挤成几个像素、自己也被挤出窗口
				 * （用户报的「才这么宽，顶部标题就不显示了」）。包起来之后 `900px` 那个阈值量的就是
				 * 真正可用的宽度，侧栏拖多宽、分栏抢多少都能如实反映出来。
				 */}
				<div className="appbar-main" ref={appbarMainRef}>
					{/*
					 * 中间那块：当前会话的名字（「这回在跟谁聊」以前只藏在浏览器标签页里）。
					 * 左对齐、跟对话区同一条左边线；**双击就地改名**（跟侧栏会话行同一套规矩）；
					 * **右键出菜单**（跟侧栏那一行同一张：置顶 / 重命名 / 新标签页 / 归档 / 删除）——
					 * 整块空白也算「当前这条会话」，所以处理器挂在槽位上而不是只挂在文字上。
					 * 项目名不写在这儿了 —— 底栏右下角已经有一份；这里只留一枚「打开的文件夹」当上下文，
					 * 完整工作区路径放在悬停提示里。
					 */}
					<span
						ref={headingSlotRef}
						className="appbar-slot"
						/* 左沿 / 宽度都锁在「对话这一栏」里（量的值，见上面 headingInset 的注释） */
						style={{ marginLeft: headingInset, maxWidth: headingWidth ?? undefined }}
						onContextMenu={
							activeSessionId
								? (event) => {
										event.preventDefault();
										const title = (event.currentTarget as HTMLElement).querySelector(
											".appbar-title, .appbar-title-input",
										);
										setHeadingMenuAnchor((title as HTMLElement | null) ?? (event.currentTarget as HTMLElement));
										setHeadingMenu(true);
									}
								: undefined
						}
					>
						{activeHeading.title ? (
							headingEditing ? (
								<input
									ref={headingInputRef}
									className="appbar-title-input"
									/* 改会话名也是纯文本：别让 Safari 当成账号框挂出密码钥匙 / 联想条
									   （属性包见 plain-text-input.ts） */
									{...PLAIN_TEXT_INPUT}
									value={headingDraft}
									onChange={(event) => setHeadingDraft(event.target.value)}
									onKeyDown={(event) => {
										if (event.key === "Enter") {
											event.preventDefault();
											commitHeading();
										} else if (event.key === "Escape") {
											event.preventDefault();
											setHeadingEditing(false);
										}
									}}
									onBlur={commitHeading}
								/>
							) : (
								<span
									className="appbar-title"
									title={
										activeHeading.project
											? `${activeHeading.project}\n${t("双击改会话名", "Double-click to rename")}`
											: t("双击改会话名", "Double-click to rename")
									}
									onDoubleClick={(event) => {
										event.preventDefault();
										setHeadingEditing(true);
									}}
								>
									{/* 这一行是**会话标题**，所以图标也得是「会话」而不是目录
									    （用户：「这上面属于会话的标题，放文件夹不合适吧」）：
									    一枚对话气泡（`ConversationIcon`）+ 淡蓝底小徽标。
									    以前这里先后放过「打开的文件夹」「合着的文件夹」——语义都对不上，
									    看着像「这条会话是个目录」。徽标底色仍用主色 14%，
									    跟仓里的类型徽标（TSX / CSS）同一个语言，读作「标签」而不是「按钮」。 */}
									{activeHeading.project ? (
										/* 这枚气泡现在是**按钮**：点一下让 AI 按当前会话内容重新起名
										   （用户：「点这个小图标，按现在会话内容让 AI 起一个最优质最简洁的名字」）。
										   双击标题仍然是手动改名，两者不抢：图标走 AI，文字走手改。 */
										<button
											type="button"
											className={`appbar-title-badge${titling ? " appbar-title-badge-busy" : ""}`}
											disabled={titling}
											title={t("让 AI 按当前会话内容重新起名", "Let AI rename this session from its content")}
											aria-label={t("让 AI 按当前会话内容重新起名", "Let AI rename this session from its content")}
											onClick={(event) => {
												// 不冒泡：外面那层是「双击改名」，点图标不该顶掉那个手势
												event.preventDefault();
												event.stopPropagation();
												if (!activeSessionId || titling) return;
												setTitling(true);
												void suggestSessionTitle(activeSessionId).finally(() => setTitling(false));
											}}
										>
											<ConversationIcon className="appbar-title-badge-icon" />
										</button>
									) : null}
									<span className="appbar-title-name">{activeHeading.title}</span>
								</span>
							)
						) : null}
						{/* 顶栏这颗标题的右键菜单：跟侧栏会话行**同一张**（`SessionMenu`），
						 * 只是动的是「当前正在看的这条」。弹在鼠标坐标处。 */}
						{headingMenu && activeSessionId ? (
							<SessionMenu
								anchor={headingMenuAnchor}
								title={activeHeading.title}
								pinned={activeSessionPinned}
								fork={{
									// 从这条会话的**最后一条消息**上切：结果就是「把这轮聊到这儿的内容复制一份、
									// 接着往下说」，原会话一个字不动（服务端 fork_session 干的活）
									enabled: canFork && lastMessageId !== null,
									reason: ephemeralActive
										? t("临时会话不能派生分支，先「保存为正式对话」")
										: !(snapshot?.engineCapabilities.forkChat ?? false)
											? t("当前引擎不支持分叉")
											: t("这条会话还没有消息，没有可分叉的点"),
									onFork: () => {
										if (activeSessionId && lastMessageId) forkSession(activeSessionId, lastMessageId);
									},
								}}
								// 分栏真的分成两块时才有“换边”这回事（铺开时对话区本来就不画）
								splitSide={
									panelOpen && !previewWide ? { chatOnRight: chatSide === "right", onMove: moveChatSide } : undefined
								}
								onClose={() => setHeadingMenu(false)}
								onPin={() => toggleSessionPin(activeSessionId)}
								// 改名 = 把顶栏那颗标题就地变成输入框（跟双击同一个动作）
								onRename={() => setHeadingEditing(true)}
								onOpenInNewTab={() =>
									window.open(sessionUrlFor(window.location.href, activeSessionId), "_blank", "noopener")
								}
								onArchive={() => archiveSession(activeSessionId, activeHeading.title, t)}
								onDelete={() => deleteSession(activeSessionId, activeHeading.title || activeSessionId)}
							/>
						) : null}
					</span>
					{/* 智能体引擎切换（ADR-0024）不在这排：它固定在底部状态栏「放行」（审批模式）后面 ——
				    那是「这一步怎么跑」的开关，跟审批模式并排（见 StatusBar）。 */}
					{/* 子代理徽标：几个在跑 / 各自花了多少，点开就是浮层（没有子代理时不占位） */}
					<AgentsLiveBadge onOpenPanel={() => setMenuPanel("agents")} turnStartedAt={turnStartedAt} />
					{/* 模型 / 技能 / 推送 / 语音 / 插件 / MCP / 子代理：显示哪些由设置 → 顶栏决定，设置永远在（窄屏只留图标） */}
					<SidebarMenu
						variant="full"
						placement="appbar"
						items={menuItems}
						panel={menuPanel}
						onPanelChange={setMenuPanel}
						/*
						 * 「临时会话」：在**右侧**新开一条临时聊天（不落盘、关掉就没了，也是落地页那张
						 * 「临时聊天」卡同一个动作）。
						 *
						 * 位置：**永远排在这一排的最左边第一个**，不跟着面板排序走（用户要求）。
						 * 以前是「插在技能左边」—— 面板顺序一改，它就被带着跑到别处去了。
						 * 为什么放顶栏：它开的是右边那块，跟侧栏开没开没关系 —— 以前挂在侧栏抬头，
						 * 侧栏一收起就摸不着了。图标 / 文案跟着隔壁那排入口的开关走（同一个模子）。
						 */
						leadingAction={
							showTempChat
								? ({ showIcon, showLabel }) => (
										<TempChatButton
											showIcon={showIcon}
											showLabel={showLabel}
											onClick={() => {
												openTool("side");
												// 手机上抽屉是盖在内容上的：不收起就正好盖住刚开出来的那条
												if (currentMobileShell()) setCollapsed(true);
											}}
										/>
									)
								: undefined
						}
					/>
					{/*
					 * 分栏开关：点一下把屏幕分成两块 —— 左边还是对话，右边是工作区
					 * （文件 / 终端 / 临时聊天 / 网页）；没标签时右边是工具落地页，
					 * 所以第一下点开也不会是一块空白。
					 * 面板一升到顶栏那一行（分栏 / 铺开），这一排的最右端就是面板标签条的右端，
					 * 那颗按钮由 PreviewPanel 画（同一个 toggleSplit），这里就不再重复画一颗。
					 */}
					{/* 「设置那一串入口 | 分栏」之间竖一道线（跟侧栏右边那道同一种画法：
				    1px `--border`、拉满顶栏高度）—— 分栏是「这一屏怎么摆」，跟前一排「开哪个面板」
				    不是同一类动作，分开好看也好认。面板升到顶栏那一行时这颗按钮不画了，
				    那条线由 `.appbar-split-divider` 接替。 */}
					{splitLifted || wideLifted ? null : <span className="appbar-divider" aria-hidden="true" />}
					{splitLifted || wideLifted ? null : (
						<button
							type="button"
							className={`side-foot-btn appbar-panel-btn${previewVisible ? " side-foot-btn-on" : ""}`}
							onClick={toggleSplit}
							aria-pressed={previewVisible}
							title={
								previewVisible
									? chatSide === "right"
										? t("收起左侧工作区", "Collapse the left work area")
										: t("收起右侧工作区", "Collapse the right work area")
									: chatSide === "right"
										? t(
												"分栏：左边开一个工作区（文件 / 终端 / 临时聊天 / 网页）",
												"Split view: a work area on the left (files / terminal / side chat / web)",
											)
										: t(
												"分栏：右边开一个工作区（文件 / 终端 / 临时聊天 / 网页）",
												"Split view: a work area on the right (files / terminal / side chat / web)",
											)
							}
						>
							<svg className="appbar-panel-icon" viewBox="0 0 16 16" aria-hidden="true">
								{/* 描边尺寸向左边那排线性图标看齐（内缩到 2.2~13.8，别把 18px 的图标盒子填满） */}
								<rect
									x="2.2"
									y="4"
									width="11.6"
									height="8.2"
									rx="1.8"
									fill="none"
									stroke="currentColor"
									strokeWidth="1.3"
								/>
								{/* 竖线 = 「工作区在哪一侧」：换边后画到左边，跟面板实际位置对得上 */}
								<line
									x1={chatSide === "right" ? "6" : "10"}
									y1="4"
									x2={chatSide === "right" ? "6" : "10"}
									y2="12.2"
									stroke="currentColor"
									strokeWidth="1.3"
								/>
							</svg>
						</button>
					)}
					{/*
					 * 分栏那一段的小分割符：分栏开着时右侧面板升到了窗口最顶（它的标签条就占顶栏右半段），
					 * 这条竖线就是「顶栏 | 标签条」之间的那一道 —— 它是顶栏的最后一个元素，
					 * 而顶栏又多让出了 `--split-w` 的右内边距，所以它正好落在分栏的那条边界上。
					 */}
					{splitLifted ? <span className="appbar-split-divider" aria-hidden="true" /> : null}
					{/*
					 * 对调之后，分栏开关**留在这个窗口的右上角**（用户要求：这颗按钮的位置不能变）。
					 * 情况是：面板跑到左边去了，它自己标签条右端那颗「收起分栏」就落到窗口中线上了 ——
					 * 所以那一刻面板不再画它（`showSplitButton={false}`），由这里补一颗在顶栏最右端；
					 * 图标里那道竖线标的是「工作区现在在哪一侧」，所以在左边就画在左边。
					 */}
					{splitLifted && chatSide === "right" ? (
						<>
							<span className="appbar-divider" aria-hidden="true" />
							<button
								type="button"
								className="side-foot-btn appbar-panel-btn side-foot-btn-on"
								onClick={toggleSplit}
								aria-pressed={previewVisible}
								title={t("收起左侧工作区", "Collapse the left work area")}
							>
								<svg className="appbar-panel-icon" viewBox="0 0 16 16" aria-hidden="true">
									<rect
										x="2.2"
										y="4"
										width="11.6"
										height="8.2"
										rx="1.8"
										fill="none"
										stroke="currentColor"
										strokeWidth="1.3"
									/>
									<line x1="6" y1="4" x2="6" y2="12.2" stroke="currentColor" strokeWidth="1.3" />
								</svg>
							</button>
						</>
					) : null}
				</div>
			</div>
			<div className="app-main">
				{/*
				 * 「展开项目列表」：舌形小箭头（`>`），**顶栏在不在、桌面还是手机都一样**。
				 *
				 * 以前它只在「顶栏藏起来、侧栏也收起」时出现（那时顶栏那颗方图标跟着没了，才补一颗兜底）。
				 * 现在它是唯一那颗：收起之后左边那一栏整块不在了，「把左栏拉回来」一直在这个位置；
				 * 手机上同理（抽屉开着看 `side-collapse`，关着看这颗），所以不再分平台。
				 */}
				{collapsed ? (
					<button
						type="button"
						className="side-expand"
						onClick={() => setCollapsed(false)}
						title={t("展开项目列表", "Expand project list")}
						aria-label={t("展开项目列表", "Expand project list")}
					>
						<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
							<path d="M6 3.6 10.4 8 6 12.4" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</button>
				) : null}
				{collapsed ? null : (
					<>
						{/* 手机端：抽屉外的遮罩，点一下收起（桌面态 CSS 里 display:none） */}
						<div className="side-backdrop" onClick={() => setCollapsed(true)} aria-hidden="true" />
						<div
							className="side-host"
							style={{ width: sideWidth }}
							// 手机上点会话后收起抽屉。注意要在**冒泡阶段**做：
							// 用 capture 会先卸载侧栏，那一行的 onClick（切会话）就再也跑不到了 ——
							// 这正是「点了没反应」的原因。
							onClick={(event) => {
								// 单栏（≤400px，抽屉盖在内容上）：点会话后顺手收起抽屉
								if (!currentMobileShell()) return;
								const target = event.target as HTMLElement;
								// 行内「归档」、项目行「+」、右键菜单：都是「就地操作」，
								// 抽屉一收菜单就跟着没了（看起来像“点了没反应”），所以留给它们自己处理。
								if (target.closest(".pi-menu, .proj-more, .proj-menu")) return;
								// 其余落在整行（含 `.pi-row-wrap`）上的点击：切会话 → 收抽屉。
								if (!target.closest(".pi-row-wrap, .session-row, .newchat-pill, .archived-view-list *")) return;
								setTimeout(() => setCollapsed(true), 0);
							}}
						>
							<Sidebar
								conversations={sidebarConversations}
								/* 新会话界面不高亮任何一行：这条会话还不存在（旧会话亮着会让人以为「就是它」） */
								activeId={newSession ? null : (pendingActive ?? snapshot?.active.conversationId ?? null)}
								piProjects={sidebarProjects}
								runningIds={sidebarRunningIds}
								/* 顶栏被藏起来了没有：「新会话」平时在顶栏，只有藏起来时才回落到侧栏抬头里画一颗 */
								appbarHidden={appbarHidden}
								onOpenTerminal={openTerminal}
								onOpenFile={openFileInPanel}
								onSearchContents={openContentSearch}
								onNewProject={openNewProjectDialog}
								fileOpen={filesOpen}
								onFileOpenChange={setFilesOpen}
								root={fileTreeRoot}
								onRootChange={setFileTreeRoot}
								activePath={activePanelFile?.path ?? null}
								revealSeq={fileReveal.seq}
								/* 空串（还没定位过）= 交回 `activePath`，别把默认目标盖成空 */
								revealPath={fileReveal.path || null}
								onRevealPath={revealPathInTree}
								/* 收起这一栏：**只有分割线上那颗舌形箭头**（侧栏底部那颗小的已去掉） */
							/>
							{/*
							 * 分割线上那颗「收起」小箭头：**顶栏在不在都画**（用户：「有顶部时，这时也要加一个
							 * 收起侧边栏的图标呀」）—— 它骑在分栏线上、就在侧栏右上角，是最顺手的那一处（
							 * 以前只顶栏藏起来时才出现，于是有顶栏时那里空着一个洞）。
							 *
							 * 此刻的「收起」**只有这一颗**：侧栏底部那颗小方块已按用户要求去掉（「这里这个不要呀」）——
							 * 同一件事有一个足够顺手的入口就够了，两处两个样子反而让人犹豫点哪颗。
							 * 手机单栏靠顶栏的抽屉开关，这颗由 CSS 收掉（见 project-icon.css）。
							 */}
							<button
								type="button"
								className="side-collapse"
								title={t("收起项目列表", "Collapse project list")}
								aria-label={t("收起项目列表", "Collapse project list")}
								// 别让按下的这一帧被拖拽条接走（否则会变成一次 0 位移的拖动）
								onPointerDown={(event) => event.stopPropagation()}
								onClick={() => setCollapsed(true)}
							>
								<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
									<path d="M10 3.6 5.6 8 10 12.4" strokeLinecap="round" strokeLinejoin="round" />
								</svg>
							</button>
							{/* 拖拽条：右边边缘 6px，双击回到默认宽度 */}
							<div
								className="side-resizer"
								role="separator"
								aria-orientation="vertical"
								title={t("拖动调整宽度（双击复位）", "Drag to resize (double-click to reset)")}
								onPointerDown={startResize}
								onDoubleClick={() => setSideWidth(readStoredWidth(null))}
							/>
						</div>
					</>
				)}

				<div className="right-col" ref={rightColRef}>
					<div
						className={`right-upper${previewWide ? " right-upper-wide" : ""}${chatSide === "right" ? " right-upper-flip" : ""}`}
					>
						{previewWide && panelOpen ? null : (
							<div className="workspace" ref={workspaceRef}>
								<main className="main" ref={scroll.ref}>
									{snapshot && messages.length === 0 ? (
										// 空会话：图标/名字/版本 + 一句招呼，整块居中（不占消息流、不需要滚动）
										<div className="newchat-hero">
											<NewChatMeta
												webVersion={snapshot.versions.web}
												latestVersion={snapshot.versions.latest}
												outdated={snapshot.versions.outdated}
												onUpgrade={() => upgradeInTerminal(UPGRADE_COMMAND)}
											/>
											<p className="newchat-hello">{t("有什么我能帮你的吗？", "What can I help you with?")}</p>
										</div>
									) : snapshot ? (
										<MessageList
											messages={messages}
											hasMoreBefore={snapshot.active.hasMoreBefore}
											// 实时 token / 速度只算「当前这个会话真的在跑」的回合（预览缓存里不算）
											running={liveRunning !== null}
											// 「正在运行 bash…」：过程容器默认折扇，中间在干什么得单独给一行
											activeTool={liveRunning?.activeTool ?? null}
											// 「模型调用被打断，正在自动重试（1/2）」：挂在同一条实时动作行上
											retrying={liveRunning?.retrying ?? null}
											// 每条消息按自己生成时的模型显示（id → 显示名）
											modelLabels={Object.fromEntries(snapshot.models.map((item) => [item.id, item.label]))}
											// 「改动过的文件」：把工具参数里的绝对路径折成相对工作区，点 chip 就能预览
											workspaceRoot={snapshot.files?.root ?? null}
											onOpenFile={openFileFromMessage}
											// 消息里的路径（报告产物清单 / 行内代码）点一下就在右侧预览
											onOpenPath={openPathFromMessage}
											pending={(snapshot.queued ?? []).filter(
												(item) => item.conversationId === snapshot.active.conversationId,
											)}
											onRecallPending={(queueId: string) => {
												const item = snapshot.queued.find((entry) => entry.id === queueId);
												if (item) setDraft(item.text);
												cancelQueued(queueId);
											}}
											onCancelPending={(queueId: string) => cancelQueued(queueId)}
											// 下一步建议：挂在消息流末尾（最后一条消息的用量尾注下面），跟消息一起滚
											actions={snapshot.actions ?? []}
											// 子代理卡片：按「开始时间」分配给各自那条助手消息，嵌在消息流里
											// （过程之后、正文之前）；新一轮派的会在下面新长一块，不复用旧的
											subagentRuns={snapshot.subagents ?? []}
											// 从这条消息派生新会话（分支）：服务端建好后自动切过去，原对话不动
											onFork={
												canFork && snapshot.active.conversationId
													? (messageId: string) => forkSession(snapshot.active.conversationId as string, messageId)
													: undefined
											}
											/* 选中文字后的动作：左边收进这条会话（引用 + 编号），右边带去临时聊天 */
											onAddSelectionToSession={addSelectionToSession}
											onAskSelectionInSideChat={askInSideChat}
											annotations={shownAnnotations}
											onFocusAnnotation={focusAnnotation}
										/>
									) : (
										<div className="empty">{t("等待服务端快照…（后端没起来的话看终端日志）")}</div>
									)}
									{/*
									 * 「回答区」占位（用户 2026-10-30，照 codex）：发出消息后把它顶到上方，
									 * 下面这段空白就是回答要长的地方。高度由 `useStickToBottom` 算（`scroll.pad`），
									 * 回答变长它自己收缩到 0，画面顺势交回「跟着底部」。
									 * **必须是容器内部的一个元素**：给 `<main>` 加 padding-bottom 撑不出可滚动空间。
									 */}
									{scroll.pad > 0 ? (
										<div className="scroll-anchor-tail" style={{ height: scroll.pad }} aria-hidden="true" />
									) : null}
								</main>
								<ConversationOutline messages={messages} />

								{/* 错误条按会话归位：换了会话就不该再挂着别人那一轮的错
								    （`conversationId === null` 是连不上服务端这类与会话无关的错，照样显示） */}
								{visibleError ? <div className="error-bar">{visibleError}</div> : null}
								<NoticeBar
									notices={snapshot?.notices ?? []}
									activeConversationId={snapshot?.active.conversationId ?? null}
								/>
								{/* 临时对话提示条：一条会话只活内存，不说清楚「关掉就没了」等于骗人。
								    文案求短（一部长句占满整行），完整解释放 title —— 想读的人悬停就看得到。 */}
								{ephemeralActive && snapshot?.active.conversationId ? (
									<div className="ephemeral-banner">
										<span
											className="ephemeral-banner-text"
											title={
												canPersistEphemeral
													? t(
															"消息只保存在内存里，不落盘、不进历史；关闭或退出服务后就没了。想留就点右边「保存为正式对话」。",
															"Messages live in memory only: nothing is written to disk, nothing shows up in history, and it is gone once closed or the server restarts. Use “Save as a regular chat” to keep it.",
														)
													: t(
															"这条对话不写进本工作台的会话文件、也不进历史，关闭或退出服务后就没了。当前引擎没有「转正」能力，所以不提供保存。",
															"This chat is never written to a workbench session file and never shows up in history; it is gone once closed or the server restarts. The current engine cannot promote it to a saved session, so no save button is offered.",
														)
											}
										>
											{canPersistEphemeral
												? t("💬 临时会话：仅存内存，关闭即销毁。", "💬 Temp session: in-memory only, gone on close.")
												: t("💬 临时会话：不落盘，关闭即消失。", "💬 Temp session: never saved, gone on close.")}
										</span>
										{canPersistEphemeral ? (
											<button
												type="button"
												className="ephemeral-save"
												onClick={() => persistConversation(snapshot.active.conversationId as string)}
												title={t("把这条对话写成真正的会话文件", "Write this chat to a real session file")}
											>
												💾 {t("保存为正式对话", "Save as a regular chat")}
											</button>
										) : null}
										<button
											type="button"
											className="ephemeral-close"
											onClick={() =>
												closeEphemeralChat(snapshot.active.conversationId as string, activeConversation?.title ?? "")
											}
											title={
												canPersistEphemeral
													? t(
															"关闭这条临时会话（内容直接丢弃，不可恢复；想留先「保存为正式对话」）",
															"Close this temp session (content is discarded, not recoverable; use “Save as a regular chat” to keep it)",
														)
													: t(
															"关闭这条临时会话（内容直接丢弃，不可恢复）",
															"Close this temp session (content is discarded, not recoverable)",
														)
											}
										>
											✕ {t("关闭", "Close")}
										</button>
									</div>
								) : null}
								{/* 「回到最新」放在**输入框顶上**（它自己占一行，不浮在正文上）。
								    以前它是滚动区里的 sticky：只能悬在正文右下角，最后一屏的字被它压住一块，
								    而且每滚到一个新位置都得重新找它。现在紧贴输入框上沿、**水平居中**。
								    形态：箭头 + 文案（文案曾被去掉、现在又按用户要求加回来），
								    但仍是**透明底、无描边、无投影** —— 它只是「下面还有新内容」的提示，
								    不该长成一颗抢眼的胶囊；悬停时才给一点浅底。 */}
								{scroll.stuck ? null : (
									<div className="composer-wrap jump-bottom-host">
										<button
											type="button"
											className="jump-bottom"
											onClick={scroll.toBottom}
											title={t("回到最新", "Jump to latest")}
											aria-label={t("回到最新", "Jump to latest")}
										>
											<svg
												viewBox="0 0 16 16"
												fill="none"
												stroke="currentColor"
												strokeWidth={1.6}
												strokeLinecap="round"
												strokeLinejoin="round"
												aria-hidden="true"
											>
												<path d="M8 3.6v8.8" />
												<path d="M4.3 9 8 12.7 11.7 9" />
											</svg>
											{/* 文案回来了（用户：「这个还是加上文案吧」）：光一枚箭头在大屏、低对比度下
											    不够说明它干什么 —— 「回到底部」能一下说清「点了会往哪儿走」。 */}
											<span className="jump-bottom-label">{t("回到最新", "Jump to latest")}</span>
										</button>
									</div>
								)}
								<Composer
									/* 「N 条注释」挂在输入框**里面**（不是输入框外面单独一行）：
									   它就是「这条会话待发的内容」，待在正在打字的那个框里才对得上 */
									annotationSummary={
										<AnnotationSummary
											annotations={shownAnnotations}
											open={annotationsOpen}
											focusedId={focusedAnnotation}
											onToggle={() => setAnnotationsOpen((current) => !current)}
											onRemove={removeAnnotationById}
											onQuote={quoteAnnotation}
											onJump={jumpToAnnotation}
											onComment={updateAnnotationComment}
										/>
									}
									running={
										!newSession &&
										/* 建会话在飞时 active 还是上一条：那一轮的「运行中」不该画到这块空屏上 */
										!pendingNewChat &&
										snapshot?.running.status !== "idle" &&
										snapshot?.running.conversationId === (snapshot?.active.conversationId ?? null)
									}
									conversationId={newSession || pendingNewChat ? null : (snapshot?.active.conversationId ?? null)}
									/* 标注算待发内容：有标注时发送按钮亮着，回车直接把它们发出去 */
									annotations={shownAnnotations}
									onAnnotationsSent={clearSentAnnotations}
									/* 「@ 提及」面板行尾的「在右侧打开」：走同一套标签体系（不会出现两份预览） */
									onOpenFile={(path, root) => openFileInPanel(path, root ?? workspaceRoot ?? "")}
									/* 新会话界面：多一行「项目 · 分支」；建好会话后这块变回 null，那行就没了 */
									newSession={
										newSession
											? {
													workspace: newSession.workspace,
													ephemeral: newSession.ephemeral,
													onWorkspaceChange: setNewSessionWorkspace,
													onEphemeralChange: setNewSessionEphemeral,
												}
											: null
									}
								/>
							</div>
						)}

						{panelOpen ? (
							<PreviewPanel
								items={panelItems}
								activeId={activeItem ?? panelItems[0]?.id ?? ""}
								landing={panelLanding}
								onActivate={(id) => {
									setActiveItem(id);
									setPanelLanding(false);
								}}
								onCloseTabs={closePanelTabs}
								onReorder={reorderPanelTabs}
								onShowLanding={() => setPanelLanding(true)}
								onPickTool={openTool}
								onWideChange={setPreviewWide}
								onToggleSplit={toggleSplit}
								root={workspaceRoot}
								chatOnRight={chatSide === "right"}
								showSplitButton={!(splitLifted && chatSide === "right")}
								revealSeq={fileReveal.seq}
								onRevealFile={(path, fileRoot) => {
									// 「文件列表」那颗开关：除了常驻一棵树，还要把人带到当前这个文件（左右两边）
									setFileTreeRoot((current) => nextTreeRoot(current, workspaceRoot, fileRoot));
									setFileReveal((current) => ({ path, seq: current.seq + 1 }));
								}}
								onOpenFile={(path) => openFileInPanel(path, workspaceRoot ?? "")}
								/* 预览里候选文件被点中：用它**那个标签的根**打开（不一定是当前会话工作区） */
								onOpenFilePath={openFileInPanel}
							/>
						) : null}
					</div>
					{/* 状态栏只在**右侧工作区**这一栏（左边那栏底部是文件管理，各用各的） */}
					<StatusBar
						snapshot={snapshot}
						appbarHidden={appbarHidden}
						onToggleAppbar={() => setAppbarHidden((value) => !value)}
					/>
				</div>
			</div>

			{/* 全文搜索浮层：入口在「文件管理」标题栏（⌘⇧F 也能开），结果点开就跳到那一行。
			 * 搜的是**「文件 ▾」下拉框选中的那个项目**（没选 = 当前会话工作区）——
			 * 下拉框切到别的项目时，搜出来的行也必须来自那个项目，不能再去会话工作区里搜。 */}
			{/* 快捷键速查表：全局挂一次，开它走 `shortcut-sheet.ts` 的模块状态（⌘/ 或设置里那颗按钮） */}
			<ShortcutSheet />

			{newProjectOpen ? <NewProjectDialog onClose={() => setNewProjectOpen(false)} /> : null}

			<ContentSearch
				open={contentSearchOpen}
				root={searchRoot}
				onClose={() => setContentSearchOpen(false)}
				onOpen={(path, line) => openFileInPanel(path, searchRoot ?? "", undefined, line)}
			/>

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
			{/* 可撤销的轻提示（归档后「撤销 / 查看」等）：全局挂一次，见 toast.ts */}
			<ToastHost />
			{/* 对话里点图片原地弹大图：全局挂一次，见 image-viewer.ts */}
			<ImageViewer />
		</div>
	);
}
