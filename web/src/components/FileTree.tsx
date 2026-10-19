import { useEffect, useState } from "react";
import { referenceFor } from "../file-preview.ts";
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
				<div className="filetree-item" key={node.entry.path || index}>
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
					{/* 悬浮出现「@ 提及」：把 @path 引用直接塞进输入框（不打开预览，一步到位） */}
					{node.entry.isDir ? null : (
						<button
							type="button"
							className="filetree-mention"
							title={`把 @${node.entry.path} 加到对话`}
							onClick={() => setDraft(`${referenceFor(node.entry.path, null)} `)}
						>
							@ 提及
						</button>
					)}
					{node.error ? <div className="filetree-error">{node.error}</div> : null}
				</div>
			))}
		</div>
	);
}
