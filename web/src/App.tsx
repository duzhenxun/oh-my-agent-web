import { useCallback, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { useCodex } from "./lib/useCodex";
import { applyTheme, loadTheme, saveTheme, type Theme } from "./lib/theme";
import { useDragResize, useMediaQuery, useStoredBoolean, useStoredNumber } from "./lib/layout";
import { Sidebar } from "./components/Sidebar";
import { Header } from "./components/Header";
import { ChatView } from "./components/ChatView";
import { Composer } from "./components/Composer";
import { ApprovalDialog } from "./components/ApprovalDialog";
import { FilePanel } from "./components/FilePanel";
import { SessionLogs } from "./components/SessionLogs";
import { Toasts } from "./components/Toasts";
import { IconAlert, IconPanelRight, IconRefresh } from "./components/Icons";

/* Sidebar width bounds — the CSS default is `DEFAULT_SIDEBAR_WIDTH`. */

function useTheme(): [Theme, (theme: Theme) => void] {
	const [theme, setTheme] = useState<Theme>(loadTheme);
	useEffect(() => {
		applyTheme(theme);
		saveTheme(theme);
	}, [theme]);
	return [theme, setTheme];
}

/* Sidebar width bounds — also mirrored by `--sidebar-w` in styles.css. */
const DEFAULT_SIDEBAR_WIDTH = 288;
const MIN_SIDEBAR_WIDTH = 220;
const MAX_SIDEBAR_WIDTH = 560;

export function App(): ReactNode {
	const { connection, status, activeThread, startThread, reconnect, streamingTurnId, interrupt } = useCodex();
	const [theme, setTheme] = useTheme();
	// Two distinct states: a drawer toggle for narrow viewports, and a persistent
	// collapse for desktop. One header button drives whichever applies.
	const [sidebarOpen, setSidebarOpen] = useState(false);
	const [sessionLogsThreadId, setSessionLogsThreadId] = useState<string | null>(null);
	const [collapsed, setCollapsed] = useStoredBoolean("cw-sidebar-collapsed", false);
	const [sidebarWidth, setSidebarWidth] = useStoredNumber("cw-sidebar-width", DEFAULT_SIDEBAR_WIDTH);
	const isNarrow = useMediaQuery("(max-width: 768px)");
	const rootRef = useRef<HTMLDivElement>(null);

	const sidebarDrag = useDragResize({
		axis: "x",
		sign: 1,
		size: sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH,
		min: MIN_SIDEBAR_WIDTH,
		/** Never let the sidebar eat the transcript on a small window. */
		max: typeof window === "undefined" ? MAX_SIDEBAR_WIDTH : Math.min(MAX_SIDEBAR_WIDTH, Math.round(window.innerWidth * 0.5)),
		onResize: setSidebarWidth,
		disabled: collapsed || isNarrow,
	});
	const resetSidebarWidth = useCallback(() => setSidebarWidth(DEFAULT_SIDEBAR_WIDTH), [setSidebarWidth]);
	const sidebarStyle = { "--sidebar-w": `${sidebarWidth ?? DEFAULT_SIDEBAR_WIDTH}px` } as CSSProperties;

	const showSidebar = useCallback(() => {
		if (isNarrow) setSidebarOpen(true);
		else setCollapsed(false);
	}, [isNarrow, setCollapsed]);

	const toggleSidebar = useCallback(() => {
		if (isNarrow) setSidebarOpen((v) => !v);
		else setCollapsed(!collapsed);
	}, [isNarrow, collapsed, setCollapsed]);

	const newThread = useCallback(() => {
		void startThread();
		setSidebarOpen(false);
	}, [startThread]);
	const openSessionLogs = useCallback((threadId: string) => setSessionLogsThreadId(threadId), []);

	// Global shortcuts: ⌘/Ctrl+K focus search, ⌘/Ctrl+N new thread, ⌘/Ctrl+B sidebar.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			const mod = e.metaKey || e.ctrlKey;
			if (!mod) return;
			const key = e.key.toLowerCase();
			if (key === "k") {
				e.preventDefault();
				// Searching needs the sidebar visible — reveal it, then focus.
				if (isNarrow) setSidebarOpen(true);
				else setCollapsed(false);
				requestAnimationFrame(() => {
					const input = rootRef.current?.querySelector<HTMLInputElement>(".search-box input");
					input?.focus();
					input?.select();
				});
			} else if (key === "n") {
				e.preventDefault();
				newThread();
			} else if (key === "b") {
				e.preventDefault();
				if (isNarrow) setSidebarOpen((v) => !v);
				else setCollapsed((v) => !v);
			}
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [newThread, isNarrow, setCollapsed]);

	// Esc interrupts the running turn ("esc to interrupt"). The composer already
	// claims Esc for its mention menu and modals claim it in capture phase, so we
	// skip events they have handled and never fight an open dialog.
	useEffect(() => {
		const onKey = (e: KeyboardEvent) => {
			if (e.key !== "Escape" || e.defaultPrevented) return;
			if (!streamingTurnId) return;
			if (document.querySelector(".modal-backdrop")) return;
			void interrupt();
		};
		document.addEventListener("keydown", onKey);
		return () => document.removeEventListener("keydown", onKey);
	}, [streamingTurnId, interrupt]);

	const showBanner = connection !== "open";
	const bannerMessage = status?.error
		? status.error
		: connection === "connecting"
			? "Connecting to the codex server…"
			: "Disconnected from the codex server. Reconnecting…";

	return (
		<div className={`app${collapsed && !isNarrow ? " sidebar-collapsed" : ""}`} ref={rootRef} style={sidebarStyle}>
			<div className={`sidebar-container${sidebarOpen ? " open" : ""}${sidebarDrag.dragging ? " dragging" : ""}`}>
				<Sidebar
					onClose={isNarrow ? () => setSidebarOpen(false) : toggleSidebar}
					onNewThread={newThread}
					onOpenSessionLogs={openSessionLogs}
				/>
				{!isNarrow ? (
					<div
						className="resize-handle vertical"
						role="separator"
						aria-orientation="vertical"
						aria-label="Resize sidebar"
						title="Drag to resize · double-click to reset"
						onPointerDown={sidebarDrag.onPointerDown}
						onDoubleClick={resetSidebarWidth}
					/>
				) : null}
			</div>
			{sidebarOpen && isNarrow ? <div className="drawer-scrim" onClick={() => setSidebarOpen(false)} aria-hidden /> : null}

			{collapsed && !isNarrow ? (
				<button className="sidebar-rail" aria-label="Show sidebar" title="Show sidebar (⌘B)" onClick={showSidebar}>
					<IconPanelRight size={15} />
				</button>
			) : null}

			<main className="main">
				<Header
					onOpenSidebar={toggleSidebar}
					sidebarVisible={isNarrow ? sidebarOpen : !collapsed}
					theme={theme}
					onSetTheme={setTheme}
					onOpenSessionLogs={() => activeThread && openSessionLogs(activeThread.id)}
				/>
				{showBanner ? (
					<div className="connection-banner" role="alert">
						<IconAlert size={15} />
						<span>{bannerMessage}</span>
						<button className="btn ghost small" onClick={reconnect}>
							<IconRefresh size={13} /> Retry
						</button>
					</div>
				) : null}
				<ChatView onOpenSidebar={showSidebar} />
				<Composer />
			</main>

			<FilePanel />
			{sessionLogsThreadId ? <SessionLogs threadId={sessionLogsThreadId} onClose={() => setSessionLogsThreadId(null)} /> : null}
			<ApprovalDialog />
			<Toasts />
		</div>
	);
}
