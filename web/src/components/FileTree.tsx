import { useEffect, useState } from "react";
import { setDraft } from "../store.ts";

type FileEntry = { name: string; path: string; isDir: boolean };

type Node = {
	entry: FileEntry;
	depth: number;
	expanded: boolean;
	loading: boolean;
	children: FileEntry[] | null;
	error: string | null;
};

async function fetchList(path: string): Promise<{ entries?: FileEntry[]; error?: string }> {
	try {
		const response = await fetch(`/api/files/list?path=${encodeURIComponent(path)}`);
		const body = (await response.json()) as { entries?: FileEntry[]; error?: { message?: string } };
		if (!response.ok) return { error: body.error?.message ?? `HTTP ${response.status}` };
		return { entries: body.entries ?? [] };
	} catch (error) {
		return { error: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 文件列表（M4）：当前项目（= 当前会话的工作区）的目录树，**懒加载**（点开才列下一层）。
 * 点文件 → 打开预览（`FilePreview`）；点目录 → 展开/收起。
 */
export function FileTree({ root, onOpenFile }: { root: string | null; onOpenFile: (path: string) => void }) {
	const [nodes, setNodes] = useState<Node[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setNodes([]);
		setError(null);
		if (!root) return;
		void fetchList("").then(({ entries, error: failure }) => {
			if (failure) {
				setError(failure);
				return;
			}
			setNodes(
				(entries ?? []).map((entry) => ({
					entry,
					depth: 0,
					expanded: false,
					loading: false,
					children: null,
					error: null,
				})),
			);
		});
	}, [root]);

	const toggleDir = async (index: number) => {
		const node = nodes[index];
		if (!node) return;
		if (node.expanded) {
			setNodes((current) => current.map((item, i) => (i === index ? { ...item, expanded: false } : item)));
			return;
		}
		setNodes((current) => current.map((item, i) => (i === index ? { ...item, expanded: true, loading: true } : item)));
		const { entries, error: failure } = await fetchList(node.entry.path);
		setNodes((current) => {
			const next: Node[] = [];
			current.forEach((item, i) => {
				next.push(i === index ? { ...item, loading: false, children: entries ?? null, error: failure ?? null } : item);
				if (i === index && !failure && entries) {
					for (const child of entries) {
						next.push({
							entry: child,
							depth: item.depth + 1,
							expanded: false,
							loading: false,
							children: null,
							error: null,
						});
					}
				}
			});
			return next;
		});
	};

	if (!root) return <div className="filetree-empty">还没有打开会话，不知道是哪个项目。</div>;

	return (
		<div className="filetree">
			<div className="filetree-root" title={root}>
				根目录 · {root.split("/").filter(Boolean).pop()}
			</div>
			{error ? <div className="filetree-error">{error}</div> : null}
			{nodes.map((node, index) => (
				<div key={node.entry.path || index}>
					<button
						type="button"
						className={`filetree-row filetree-${node.entry.isDir ? "dir" : "file"}`}
						style={{ paddingLeft: 8 + node.depth * 14 }}
						onClick={() => (node.entry.isDir ? void toggleDir(index) : onOpenFile(node.entry.path))}
						title={node.entry.path}
					>
						<span className="filetree-icon" aria-hidden="true">
							{node.entry.isDir ? (node.expanded ? "▾" : "▸") : "·"}
						</span>
						<span className="filetree-name">{node.entry.name}</span>
						{node.loading ? <span className="filetree-hint">…</span> : null}
					</button>
					{node.error ? <div className="filetree-error">{node.error}</div> : null}
				</div>
			))}
		</div>
	);
}

/** 只读预览弹窗（M4）：行号 + 等宽正文 + 「插入到输入框」。 */
export function FilePreview({ path, onClose }: { path: string; onClose: () => void }) {
	const [state, setState] = useState<{
		text: string;
		bytes: number;
		truncated: boolean;
		binary: boolean;
		error?: string;
	} | null>(null);

	useEffect(() => {
		let cancelled = false;
		void (async () => {
			const response = await fetch(`/api/files/read?path=${encodeURIComponent(path)}`);
			const body = (await response.json()) as {
				text?: string;
				bytes?: number;
				truncated?: boolean;
				binary?: boolean;
				error?: { message?: string };
			};
			if (cancelled) return;
			if (!response.ok) {
				setState({
					text: "",
					bytes: 0,
					truncated: false,
					binary: false,
					error: body.error?.message ?? `HTTP ${response.status}`,
				});
				return;
			}
			setState({
				text: body.text ?? "",
				bytes: body.bytes ?? 0,
				truncated: body.truncated === true,
				binary: body.binary === true,
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [path]);

	const lines = state && !state.binary ? state.text.split("\n") : [];

	return (
		<div className="modal-backdrop" role="dialog" aria-modal="true" aria-label="文件预览">
			<div className="modal file-preview">
				<div className="file-preview-head">
					<span className="file-preview-path mono">{path}</span>
					<span className="file-preview-meta">
						{state ? `${state.bytes} 字节` : "读取中…"}
						{state?.truncated ? "（已截断）" : ""}
					</span>
					<span className="topbar-spacer" />
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => setDraft(`${path} `)}
						title="插到输入框（当作对话引用）"
					>
						插入到对话
					</button>
					<button type="button" className="btn btn-tiny" onClick={onClose}>
						关闭
					</button>
				</div>
				{state?.error ? <div className="file-preview-error">{state.error}</div> : null}
				{state?.binary ? <div className="file-preview-error">这是二进制文件，不能预览</div> : null}
				{state && !state.binary && !state.error ? (
					<pre className="file-preview-body mono">
						{lines.map((line, index) => (
							<div className="file-preview-line" key={index}>
								<span className="file-preview-no">{index + 1}</span>
								<span className="file-preview-text">{line}</span>
							</div>
						))}
					</pre>
				) : null}
			</div>
		</div>
	);
}
