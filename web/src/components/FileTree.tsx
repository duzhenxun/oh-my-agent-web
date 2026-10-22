import { useEffect, useState } from "react";
import { referenceFor } from "../file-preview.ts";
import { collapseAt } from "../file-tree-model.ts";
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

async function fetchList(
	path: string,
	root: string | null,
	showHidden = false,
): Promise<{ entries?: FileEntry[]; error?: string }> {
	try {
		const response = await fetch(
			`/api/files/list?path=${encodeURIComponent(path)}${root ? `&root=${encodeURIComponent(root)}` : ""}${
				showHidden ? "&hidden=1" : ""
			}`,
		);
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
export function FileTree({
	root,
	showHidden = false,
	onOpenFile,
}: {
	root: string | null;
	/** 「眼睛」开关：是否列出点开头的隐藏文件 */
	showHidden?: boolean;
	onOpenFile: (path: string) => void;
}) {
	const [nodes, setNodes] = useState<Node[]>([]);
	const [error, setError] = useState<string | null>(null);

	useEffect(() => {
		setNodes([]);
		setError(null);
		if (!root) return;
		// 切项目 / 切「显示隐藏文件」时，上一次的响应可能后到：用标记把它丢掉
		let cancelled = false;
		void fetchList("", root, showHidden).then(({ entries, error: failure }) => {
			if (cancelled) return;
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
		return () => {
			cancelled = true;
		};
	}, [root, showHidden]);

	const toggleDir = async (path: string) => {
		const node = nodes.find((item) => item.entry.path === path);
		if (!node) return;
		if (node.expanded) {
			// 收起：箭头翻回去，并把子孙行一起移掉（否则行还留在原地，看起来「收不起来」）
			setNodes((current) => {
				const index = current.findIndex((item) => item.entry.path === path);
				return index < 0 ? current : collapseAt(current, index);
			});
			return;
		}
		setNodes((current) =>
			current.map((item) => (item.entry.path === path ? { ...item, expanded: true, loading: true } : item)),
		);
		const { entries, error: failure } = await fetchList(path, root, showHidden);
		setNodes((current) => {
			// 按**路径**回填（不再用渲染时捕获的 index）：await 期间树可能已经变了
			// （切项目、折叠了上面的目录），按 index 插会把子节点塞到别的目录下面。
			const index = current.findIndex((item) => item.entry.path === path && item.expanded);
			const target = index < 0 ? undefined : current[index];
			if (!target) return current; // 已经收起 / 整棵树被换掉：这次结果直接丢弃
			const head = current
				.slice(0, index + 1)
				.map((item, i) =>
					i === index ? { ...item, loading: false, children: entries ?? null, error: failure ?? null } : item,
				);
			if (failure || !entries) return [...head, ...current.slice(index + 1)];
			const children: Node[] = entries.map((child) => ({
				entry: child,
				depth: target.depth + 1,
				expanded: false,
				loading: false,
				children: null,
				error: null,
			}));
			return [...head, ...children, ...current.slice(index + 1)];
		});
	};

	if (!root) return <div className="filetree-empty">还没有打开会话，不知道是哪个项目。</div>;

	return (
		<div className="filetree">
			{error ? <div className="filetree-error">{error}</div> : null}
			{nodes.map((node, index) => (
				<div className="filetree-item" key={node.entry.path || index}>
					<button
						type="button"
						className={`filetree-row filetree-${node.entry.isDir ? "dir" : "file"}`}
						style={{ paddingLeft: 8 + node.depth * 14 }}
						onClick={() => (node.entry.isDir ? void toggleDir(node.entry.path) : onOpenFile(node.entry.path))}
						title={node.entry.path}
					>
						<span className="filetree-icon" aria-hidden="true">
							{node.entry.isDir ? (node.expanded ? "▾" : "▸") : "·"}
						</span>
						{/* 目录额外给一个文件夹图标：开着的用 📂，收起用 📁，一眼能分清「这是文件夹」 */}
						{node.entry.isDir ? (
							<span className="filetree-folder" aria-hidden="true">
								{node.expanded ? "📂" : "📁"}
							</span>
						) : null}
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
