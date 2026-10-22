import { BRAND_NAME } from "./brand.ts";
import { useStickToBottom } from "./stick-to-bottom.ts";
import { useEffect, useRef, useState } from "react";
import {
	clampSidebarWidth,
	defaultCollapsed,
	isTablet,
	readStoredWidth,
	SIDEBAR_COLLAPSED_KEY,
	SIDEBAR_WIDTH_KEY,
} from "./sidebar-layout.ts";
import { setDraft, useAppState } from "./store.ts";
import { sessionIdFromUrl, sessionUrlFor } from "./session-url.ts";
import { cancelQueued, newChat, switchConversation } from "./ws.ts";
import { currentMobileShell } from "./mobile-shell-dom.ts";
import { ApprovalDialog, NoticeBar } from "./components/ApprovalDialog.tsx";
import { Composer } from "./components/Composer.tsx";
import { MessageList } from "./components/MessageList.tsx";
import { ActionSuggestions } from "./components/ActionSuggestions.tsx";
import { NewChatMeta } from "./components/NewChatMeta.tsx";
import { ConversationOutline } from "./components/ConversationOutline.tsx";
import { SidebarMenu } from "./components/SidebarMenu.tsx";
import { EnginePicker } from "./components/EnginePicker.tsx";
import { PreviewPanel, type PanelItem } from "./components/PreviewPanel.tsx";
import { Sidebar } from "./components/Sidebar.tsx";
import { StatusBar } from "./components/StatusBar.tsx";

export function App() {
	// 文件面板（M4）：跟着当前会话的工作区走
	// 侧栏：可收起 + 可拖宽（状态存 localStorage，刷新后保持）
	const [collapsed, setCollapsed] = useState(() =>
		defaultCollapsed({
			stored: localStorage.getItem(SIDEBAR_COLLAPSED_KEY),
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
	const [appbarHidden, setAppbarHidden] = useState(() => localStorage.getItem("agent-web:appbar-hidden") === "1");
	const [previewVisible, setPreviewVisible] = useState(true);
	/** 预览面板「铺开」：占满对话 + 预览两块区域（左侧栏保留） */
	const [previewWide, setPreviewWide] = useState(false);
	const [sideWidth, setSideWidth] = useState(() => readStoredWidth(localStorage.getItem(SIDEBAR_WIDTH_KEY)));
	const dragging = useRef(false);

	useEffect(() => {
		localStorage.setItem(SIDEBAR_COLLAPSED_KEY, collapsed ? "1" : "0");
	}, [collapsed]);
	useEffect(() => {
		localStorage.setItem("agent-web:appbar-hidden", appbarHidden ? "1" : "0");
	}, [appbarHidden]);
	useEffect(() => {
		localStorage.setItem(SIDEBAR_WIDTH_KEY, String(sideWidth));
	}, [sideWidth]);

	// 顶栏真实高度写进 CSS 变量：手机抽屉要靠它贴合，写死数字会留一条缝
	useEffect(() => {
		const bar = document.querySelector(".appbar");
		if (!bar) return;
		const apply = () =>
			document.documentElement.style.setProperty("--appbar-h", `${(bar as HTMLElement).offsetHeight}px`);
		apply();
		const observer = new ResizeObserver(apply);
		observer.observe(bar);
		return () => observer.disconnect();
	}, []);

	// 拖拽：pointer 事件挂在 document 上，鼠标移出侧栏边缘也不会中断
	const startResize = (event: React.PointerEvent<HTMLDivElement>) => {
		event.preventDefault();
		dragging.current = true;
		const startX = event.clientX;
		const startWidth = sideWidth;
		const onMove = (moveEvent: PointerEvent) => {
			if (!dragging.current) return;
			setSideWidth(clampSidebarWidth(startWidth + (moveEvent.clientX - startX)));
		};
		const onUp = () => {
			dragging.current = false;
			document.removeEventListener("pointermove", onMove);
			document.removeEventListener("pointerup", onUp);
		};
		document.addEventListener("pointermove", onMove);
		document.addEventListener("pointerup", onUp);
	};
	// 右侧面板的标签：文件与终端共用（终端也在右侧，标签上标出来）
	const [panelItems, setPanelItems] = useState<PanelItem[]>([]);
	/**
	 * 右侧面板此刻**真的在显示**吗：铺开（previewWide）会把 workspace 整块替换掉，
	 * 所以「铺开」必须和「面板可见 + 有内容」绑在一起 —— 不然收起面板时会剩一片空白，
	 * 连输入框都没有（用户只能靠再点开面板才能救回来）。
	 */
	const panelOpen = previewVisible && panelItems.length > 0;
	const [activeItem, setActiveItem] = useState<string | null>(null);
	const [termSeq, setTermSeq] = useState(0);
	const state = useAppState();
	const snapshot = state.snapshot;
	// 切会话时可能还没等到服务端快照：如果浏览器本地缓存里有这份正文，先铺上（首屏不等网络），
	// 快照一到 ws.ts 会把 preview 清掉，自动换成权威数据。
	const activeId = snapshot?.active.conversationId ?? null;
	const preview = state.preview && state.preview.conversationId !== activeId ? state.preview : null;
	const messages = preview?.messages ?? snapshot?.active.messages ?? [];
	// 刚点下、服务端还没把这一份快照推回来（乐观高亮已生效）—— 给一条「正在打开」提示，
	// 否则外网/手机上几百毫秒里界面看着像没反应，用户会再点一下。
	const switching = state.pendingActive !== null && state.pendingActive !== activeId;
	// 地址栏 ↔ 当前会话（?session=xxx）
	const urlSession = useRef<string | null>(sessionIdFromUrl(window.location.search));
	const appliedUrlSession = useRef(false);
	useEffect(() => {
		// 连上之后把地址栏里的会话打开（只做一次）
		if (appliedUrlSession.current || state.connection !== "open") return;
		appliedUrlSession.current = true;
		if (urlSession.current) void switchConversation(urlSession.current);
	}, [state.connection]);
	useEffect(() => {
		if (!snapshot) return;
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
	}, [snapshot?.active.conversationId]);

	// 浏览器标签页标题：`项目名-对话名`，多开几个标签时一眼能分清
	useEffect(() => {
		if (!snapshot) return;
		const id = snapshot.active.conversationId;
		if (!id) {
			document.title = BRAND_NAME;
			return;
		}
		// 会话可能在「本进程新建的」里，也可能只是 pi 里的历史会话（piProjects）
		const own = snapshot.conversations.find((item) => item.id === id);
		// 服务端可以省掉这份清单（见 protocol.ts）：缺了就当作没扫到，标题回落到自建会话
		const piProject = (snapshot.piProjects ?? []).find((project) =>
			project.sessions.some((session) => session.id === id),
		);
		const piSession = piProject?.sessions.find((session) => session.id === id);
		const project = (own?.workspace ?? piProject?.cwd ?? snapshot.files?.root ?? "").split("/").filter(Boolean).pop();
		const title = own?.title ?? piSession?.title ?? "";
		document.title = project && title ? `${project}-${title}` : BRAND_NAME;
	}, [snapshot?.active.conversationId, snapshot?.files?.root, snapshot?.conversations, snapshot?.piProjects]);

	// 粘底滚动：条数、末条正文长度、流式文本任一变化都算「内容更新」
	const lastTextLength =
		messages.at(-1)?.blocks.reduce((sum, block) => sum + (block.kind === "text" ? block.text.length : 0), 0) ?? 0;
	const scroll = useStickToBottom(
		`${messages.length}:${lastTextLength}:${snapshot?.running.streamingText?.length ?? 0}:${snapshot?.active.conversationId ?? ""}`,
		snapshot?.active.conversationId ?? null,
	);

	return (
		<div className="app">
			{switching || state.creating ? (
				<div className="switch-hint" role="status">
					{state.creating ? "正在新建会话…" : preview ? "本地缓存 · 正在同步…" : "正在打开会话…"}
				</div>
			) : null}
			{/* 顶部区域：横跨整个宽度，三栏都在它下面 */}
			<div className="appbar" hidden={appbarHidden}>
				{/* 手机：☰ 是抽屉开关（必须留）。
				    桌面：收起态才需要入口 —— 展开态直接点分割线上的小箭头（见 .side-collapse） */}
				{mobileShell ? (
					<button
						type="button"
						className="appbar-drawer"
						onClick={() => setCollapsed((value) => !value)}
						title="项目列表"
						aria-label="项目列表"
					>
						☰
					</button>
				) : collapsed ? (
					<button
						type="button"
						className="appbar-drawer appbar-drawer-open"
						onClick={() => setCollapsed(false)}
						title="展开项目列表"
						aria-label="展开项目列表"
					>
						<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.6} aria-hidden="true">
							<path d="M6 3.6 10.4 8 6 12.4" strokeLinecap="round" strokeLinejoin="round" />
						</svg>
					</button>
				) : null}
				<span className="brand">
					<img className="brand-icon" src="/favicon.svg?v=4" alt="" aria-hidden="true" />
					<span className="brand-name">{BRAND_NAME}</span>
				</span>
				<button type="button" className="appbar-new appbar-new-primary" onClick={() => newChat()} title="新建会话">
					<span className="appbar-new-icon" aria-hidden="true">
						💬
					</span>
					<span className="appbar-new-label">新会话</span>
				</button>
				{/* 预留区：以后放全局搜索 / 命令面板 */}
				<span className="appbar-slot" />
				{/* 智能体引擎切换：切完项目 / 模型 / 能力一并跟着换（ADR-0024） */}
				<EnginePicker />
				{/* 模型 / 技能 / 推送 / 设置：靠右对齐（窄屏只留图标） */}
				<SidebarMenu variant="full" placement="appbar" items={["models", "skills", "push", "settings"]} />
				{panelItems.length > 0 ? (
					<button
						type="button"
						className={`side-foot-btn appbar-panel-btn${previewVisible ? " side-foot-btn-on" : ""}`}
						onClick={() => {
							const next = !previewVisible;
							setPreviewVisible(next);
							// 收起时必须退出铺开：否则 workspace 和面板都不渲染 = 整块空白
							if (!next) setPreviewWide(false);
						}}
						title={previewVisible ? "收起右侧面板" : "展开右侧面板"}
					>
						<svg className="appbar-panel-icon" viewBox="0 0 16 16" aria-hidden="true">
							<rect
								x="1.6"
								y="2.6"
								width="12.8"
								height="10.8"
								rx="2.2"
								fill="none"
								stroke="currentColor"
								strokeWidth="1.4"
							/>
							<line x1="10.2" y1="2.6" x2="10.2" y2="13.4" stroke="currentColor" strokeWidth="1.4" />
						</svg>
						{previewVisible ? "收起" : "展开"}
					</button>
				) : null}
			</div>
			<div className="app-main">
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
								if (target.closest(".pi-archive, .pi-menu, .proj-more, .proj-menu")) return;
								// 其余落在整行（含 `.pi-row-wrap`）上的点击：切会话 → 收抽屉。
								if (!target.closest(".pi-row-wrap, .session-row, .archived-view-list *")) return;
								setTimeout(() => setCollapsed(true), 0);
							}}
						>
							<Sidebar
								conversations={snapshot?.conversations ?? []}
								activeId={state.pendingActive ?? snapshot?.active.conversationId ?? null}
								piProjects={snapshot?.piProjects ?? []}
								runningIds={Object.keys(snapshot?.runningByConversation ?? {})}
								onOpenTerminal={(cwd) => {
									const id = `term:${termSeq}:${cwd}`;
									setTermSeq((value) => value + 1);
									setPanelItems((current) => [...current, { id, kind: "terminal", cwd }]);
									setActiveItem(id);
								}}
								onOpenFile={(path, root) => {
									const id = `file:${root}:${path}`;
									setPanelItems((current) =>
										current.some((item) => item.id === id) ? current : [...current, { id, kind: "file", path, root }],
									);
									setActiveItem(id);
								}}
							/>
							{/* 分割线上的收起按钮：点一下把侧栏收起来（拖拽条仍是拖宽用） */}
							<button
								type="button"
								className="side-collapse"
								title="收起项目列表"
								aria-label="收起项目列表"
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
								title="拖动调整宽度（双击复位）"
								onPointerDown={startResize}
								onDoubleClick={() => setSideWidth(readStoredWidth(null))}
							/>
						</div>
					</>
				)}

				<div className="right-col">
					<div className={`right-upper${previewWide ? " right-upper-wide" : ""}`}>
						{previewWide && panelOpen ? null : (
							<div className="workspace">
								<main className="main" ref={scroll.ref}>
									{snapshot && messages.length === 0 ? (
										// 空会话：图标/名字/版本 + 一句招呼，整块居中（不占消息流、不需要滚动）
										<div className="newchat-hero">
											<NewChatMeta
												webVersion={snapshot.versions.web}
												engineName={snapshot.engine}
												engineVersion={snapshot.versions.engine}
												latestVersion={snapshot.versions.latest}
												outdated={snapshot.versions.outdated}
											/>
											<p className="newchat-hello">有什么我能帮你的吗？</p>
										</div>
									) : snapshot ? (
										<MessageList
											messages={messages}
											hasMoreBefore={snapshot.active.hasMoreBefore}
											// 实时 token / 速度只算「当前这个会话真的在跑」的回合（预览缓存里不算）
											running={
												preview === null &&
												snapshot.running.status !== "idle" &&
												snapshot.running.conversationId === snapshot.active.conversationId
											}
											// 每条消息按自己生成时的模型显示（id → 显示名）
											modelLabels={Object.fromEntries(snapshot.models.map((item) => [item.id, item.label]))}
											pending={(snapshot.queued ?? []).filter(
												(item) => item.conversationId === snapshot.active.conversationId,
											)}
											onRecallPending={(queueId: string) => {
												const item = snapshot.queued.find((entry) => entry.id === queueId);
												if (item) setDraft(item.text);
												cancelQueued(queueId);
											}}
											onCancelPending={(queueId: string) => cancelQueued(queueId)}
										/>
									) : (
										<div className="empty">等待服务端快照…（后端没起来的话看终端日志）</div>
									)}
									{scroll.stuck ? null : (
										<button type="button" className="jump-bottom" onClick={scroll.toBottom} title="回到最新">
											↓ 回到底部
										</button>
									)}
								</main>
								<ConversationOutline messages={messages} />

								{state.lastError ? <div className="error-bar">{state.lastError}</div> : null}
								<NoticeBar notices={snapshot?.notices ?? []} />
								{/* 下一步建议：放在输入区上方，空会话也看得见「想一想」 */}
								<div className="action-row-host">
									<ActionSuggestions
										actions={snapshot?.actions ?? []}
										running={
											snapshot?.running.status !== "idle" &&
											snapshot?.running.conversationId === (snapshot?.active.conversationId ?? null)
										}
									/>
								</div>
								<Composer
									running={
										snapshot?.running.status !== "idle" &&
										snapshot?.running.conversationId === (snapshot?.active.conversationId ?? null)
									}
									conversationId={snapshot?.active.conversationId ?? null}
								/>
							</div>
						)}

						{panelOpen ? (
							<PreviewPanel
								items={panelItems}
								activeId={activeItem ?? panelItems[0]?.id ?? ""}
								onActivate={setActiveItem}
								onCloseItem={(id) => {
									const next = panelItems.filter((item) => item.id !== id);
									setPanelItems(next);
									if (activeItem === id) setActiveItem(null);
									// 关掉最后一项 = 面板消失：铺开态也要退出，否则对话区跟着一起没了
									if (next.length === 0) setPreviewWide(false);
								}}
								onCloseAll={() => {
									setPanelItems([]);
									setActiveItem(null);
									setPreviewWide(false);
								}}
								onWideChange={setPreviewWide}
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

			{snapshot?.pendingApproval ? <ApprovalDialog approval={snapshot.pendingApproval} /> : null}
		</div>
	);
}
