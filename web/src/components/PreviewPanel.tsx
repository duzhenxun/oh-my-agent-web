import { useCallback, useEffect, useRef, useState } from "react";
import { FileViewer } from "./FilePreview.tsx";

export type OpenFile = { path: string; root: string };

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
	files,
	activePath,
	onActivate,
	onCloseFile,
	onCloseAll,
}: {
	files: OpenFile[];
	activePath: string;
	onActivate: (path: string) => void;
	onCloseFile: (path: string) => void;
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

	const active = files.find((file) => file.path === activePath) ?? files[0];

	if (collapsed) {
		return (
			<button type="button" className="preview-collapsed" onClick={() => setCollapsed(false)} title="展开预览">
				‹
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
				{files.map((file) => {
					const label = file.path.split("/").filter(Boolean).pop() ?? file.path;
					return (
						<span
							className={`preview-tab${file.path === active?.path ? " preview-tab-on" : ""}`}
							key={`${file.root}:${file.path}`}
						>
							<button
								type="button"
								className="preview-tab-name"
								onClick={() => onActivate(file.path)}
								title={file.path}
							>
								{label}
							</button>
							<button type="button" className="preview-tab-x" onClick={() => onCloseFile(file.path)} title="关闭">
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
				<button type="button" className="btn btn-tiny" onClick={() => setCollapsed(true)} title="收起预览">
					›
				</button>
				<button type="button" className="btn btn-tiny" onClick={onCloseAll} title="关闭全部">
					✕
				</button>
			</div>
			<div className="preview-body">
				{active ? <FileViewer key={`${active.root}:${active.path}`} path={active.path} root={active.root} /> : null}
			</div>
		</aside>
	);
}
