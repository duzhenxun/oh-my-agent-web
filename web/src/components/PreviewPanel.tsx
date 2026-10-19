import { useCallback, useEffect, useRef, useState } from "react";
import { FileViewer } from "./FilePreview.tsx";
import { TerminalPanel } from "./TerminalPanel.tsx";

/** 右侧面板里的一个标签：文件或终端（终端也复用这块地方，标签上写明） */
export type PanelItem =
	{ id: string; kind: "file"; path: string; root: string } | { id: string; kind: "terminal"; cwd: string | null };

const WIDTH_KEY = "agent-web.preview.width";
const MIN_WIDTH = 360;
const MAX_WIDTH = 1200;

function readWidth(): number {
	const raw = Number(localStorage.getItem(WIDTH_KEY));
	return Number.isFinite(raw) && raw >= MIN_WIDTH ? Math.min(raw, MAX_WIDTH) : 620;
}

/**
 * 右侧预览面板（第 2 步）：多标签 + 可收起 + 可拖宽（记住宽度）+ 可全屏。
 *
 * 与之前弹窗的区别：弹窗一次只能看一个文件、还会挡住对话；面板常驻，
 * 改代码时对照着看更自然。行选中/添加到对话的能力沿用 FileViewer。
 */
export function PreviewPanel({
	items,
	activeId,
	onActivate,
	onCloseItem,
	onCloseAll,
}: {
	items: PanelItem[];
	activeId: string;
	onActivate: (id: string) => void;
	onCloseItem: (id: string) => void;
	onCloseAll: () => void;
}) {
	const [width, setWidth] = useState(readWidth);
	const [collapsed, setCollapsed] = useState(false);
	const [fullscreen, setFullscreen] = useState(false);
	const dragging = useRef(false);

	// 拖拽改宽：pointer 事件挂 document，鼠标移出面板也能继续
	const startResize = useCallback(
		(event: React.PointerEvent<HTMLDivElement>) => {
			event.preventDefault();
			dragging.current = true;
			const startX = event.clientX;
			const startWidth = width;
			const onMove = (moveEvent: PointerEvent) => {
				if (!dragging.current) return;
				// 面板在右侧：往左拖 = 变宽
				const next = Math.min(Math.max(startWidth - (moveEvent.clientX - startX), MIN_WIDTH), MAX_WIDTH);
				setWidth(Math.round(next));
			};
			const onUp = () => {
				dragging.current = false;
				document.removeEventListener("pointermove", onMove);
				document.removeEventListener("pointerup", onUp);
			};
			document.addEventListener("pointermove", onMove);
			document.addEventListener("pointerup", onUp);
		},
		[width],
	);

	useEffect(() => {
		localStorage.setItem(WIDTH_KEY, String(width));
	}, [width]);

	const active = items.find((item) => item.id === activeId) ?? items[0];

	if (collapsed) {
		return (
			<button
				type="button"
				className="preview-arrow preview-collapsed"
				onClick={() => setCollapsed(false)}
				title="展开预览"
			>
				›
			</button>
		);
	}

	return (
		<aside
			className={`preview-panel${fullscreen ? " preview-panel-full" : ""}`}
			style={fullscreen ? undefined : { width }}
		>
			{fullscreen ? null : <div className="preview-resizer" onPointerDown={startResize} title="拖动调整宽度" />}
			<div className="preview-tabs">
				{items.map((item) => {
					const label =
						item.kind === "terminal"
							? `⌨ 终端${item.cwd ? ` · ${item.cwd.split("/").filter(Boolean).pop()}` : ""}`
							: (item.path.split("/").filter(Boolean).pop() ?? item.path);
					const title = item.kind === "terminal" ? (item.cwd ?? "终端") : item.path;
					return (
						<span className={`preview-tab${item.id === active?.id ? " preview-tab-on" : ""}`} key={item.id}>
							<button type="button" className="preview-tab-name" onClick={() => onActivate(item.id)} title={title}>
								{label}
							</button>
							<button type="button" className="preview-tab-x" onClick={() => onCloseItem(item.id)} title="关闭">
								×
							</button>
						</span>
					);
				})}
				<span className="topbar-spacer" />
				<button
					type="button"
					className="btn btn-tiny"
					onClick={() => setFullscreen((value) => !value)}
					title={fullscreen ? "退出全屏" : "全屏"}
				>
					{fullscreen ? "⤡" : "⛶"}
				</button>
				<button type="button" className="preview-arrow" onClick={() => setCollapsed(true)} title="收起预览">
					‹
				</button>
				<button type="button" className="btn btn-tiny" onClick={onCloseAll} title="关闭全部">
					✕
				</button>
			</div>
			<div className="preview-body">
				{/* 全部渲染、只隐藏非激活的：切标签时组件不卸载，终端的 PTY 与滚动历史都保住
				    （之前只渲染激活项，一切换就触发 stop → "进程已退出"） */}
				{items.map((item) => (
					<div className={`preview-slot${item.id === active?.id ? "" : " preview-slot-hidden"}`} key={item.id}>
						{item.kind === "file" ? (
							<FileViewer path={item.path} root={item.root} />
						) : (
							<TerminalPanel
								termId={item.id}
								cwd={item.cwd}
								active={item.id === active?.id}
								onClose={() => onCloseItem(item.id)}
							/>
						)}
					</div>
				))}
			</div>
		</aside>
	);
}
