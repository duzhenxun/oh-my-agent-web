import { useEffect, useMemo, useRef, useState } from "react";
import { referenceFor } from "../file-preview.ts";
import { FolderIcon } from "./FolderIcon.tsx";
import { fileTypeOf } from "../file-type.ts";
import { collapseAt, ancestorDirs, hiddenAncestor } from "../file-tree-model.ts";
import { setDraft } from "../store.ts";
import { STATUS_LETTER, foldStatusToDirs, useGitStatus } from "../use-git-status.ts";
import { useT } from "../use-language.ts";

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
	statusRevision = "",
	running = false,
	activePath = null,
	revealSeq = 0,
	revealPath = null,
	onNeedHidden,
	onOpenFile,
}: {
	root: string | null;
	/** 「眼睛」开关：是否列出点开头的隐藏文件 */
	showHidden?: boolean;
	/** 变化一次 = 重新拉 git 状态（切分支 / 点刷新） */
	statusRevision?: string;
	/** 当前会话在跑：跑完会自动再拉一次状态（智能体刚改的文件要变色） */
	running?: boolean;
	/** 右侧面板里正在看的那个文件：那一行加个底色，一眼知道「这个已经开着了" */
	activePath?: string | null;
	/**
	 * 变化一次 = **把定位目标（`revealPath`，默认 `activePath`）定位出来**：逐层展开它的
	 * 祖先目录，再把那一行滚进视野。
	 * 0 = 从不主动定位（左树默认就是这样，不然切个标签就把人手动翻的位置给抽走了）。
	 * 文件可能在很深的目录里（懒加载，默认只列第一层），所以定位是异步的：
	 * 要一层一层请求，最后才滚。
	 */
	revealSeq?: number;
	/**
	 * 定位的**目标**（不传就用 `activePath`）。
	 * 为什么单开一路：文件名搜索结果里点一条**目录**时，左树要展开到那个目录去，
	 * 但右侧面板并没有「文件」被打开（`activePath` 还是上一个文件）——
	 * 定位得跟着这一次点击走，而不是跟着「面板里正开着谁」。
	 */
	revealPath?: string | null;
	/** 定位时发现祖先是个隐藏目录（树没列）：请外面把「显示隐藏文件」打开，然后重定位一次 */
	onNeedHidden?: () => void;
	onOpenFile: (path: string) => void;
}) {
	const t = useT();
	/** git 改动状态：文件行染色 + 右侧 M/A/U，目录行按「底下有没有改动」聚合 */
	const gitStatus = useGitStatus(root, statusRevision, running);
	const dirtyDirs = useMemo(() => foldStatusToDirs(gitStatus.entries), [gitStatus.entries]);
	const [nodes, setNodes] = useState<Node[]>([]);
	const [error, setError] = useState<string | null>(null);
	/**
	 * 树的镜子 + 写入入口。
	 * 定位要「展开一层 → 看最新结果 → 再展开下一层」，都是 async 里的连续动作；
	 * 光靠 `setNodes(updater)` 读不到刚写进去的东西，所以维护一份同步的 `nodesRef`，
	 * 所有写入都走 `setTree`（两边永远一致）。
	 */
	const nodesRef = useRef<Node[]>([]);
	const setTree = (updater: (current: Node[]) => Node[]) => {
		const next = updater(nodesRef.current);
		nodesRef.current = next;
		setNodes(next);
	};
	const treeRef = useRef<HTMLDivElement | null>(null);

	useEffect(() => {
		setTree(() => []);
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
			setTree(() =>
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

	/** 展开一个目录（已展开就什么也不做）：列表拉回来后按**路径**插它自己的孩子 */
	const expandDir = async (path: string) => {
		const target = nodesRef.current.find((item) => item.entry.path === path);
		if (!target || (target.expanded && target.children !== null)) return;
		setTree((current) =>
			current.map((item) => (item.entry.path === path ? { ...item, expanded: true, loading: true } : item)),
		);
		const { entries, error: failure } = await fetchList(path, root, showHidden);
		setTree((current) => {
			// 按**路径**回填（不再用渲染时捕获的 index）：await 期间树可能已经变了
			// （切项目、折叠了上面的目录），按 index 插会把子节点塞到别的目录下面。
			const index = current.findIndex((item) => item.entry.path === path && item.expanded);
			const parent = index < 0 ? undefined : current[index];
			if (!parent) return current; // 已经收起 / 整棵树被换掉：这次结果直接丢弃
			const head = current
				.slice(0, index + 1)
				.map((item, i) =>
					i === index ? { ...item, loading: false, children: entries ?? null, error: failure ?? null } : item,
				);
			if (failure || !entries) return [...head, ...current.slice(index + 1)];
			const children: Node[] = entries.map((child) => ({
				entry: child,
				depth: parent.depth + 1,
				expanded: false,
				loading: false,
				children: null,
				error: null,
			}));
			return [...head, ...children, ...current.slice(index + 1)];
		});
	};

	const toggleDir = async (path: string) => {
		const node = nodesRef.current.find((item) => item.entry.path === path);
		if (!node) return;
		if (node.expanded) {
			// 收起：箭头翻回去，并把子孙行一起移掉（否则行还留在原地，看起来「收不起来」）
			setTree((current) => {
				const index = current.findIndex((item) => item.entry.path === path);
				return index < 0 ? current : collapseAt(current, index);
			});
			return;
		}
		await expandDir(path);
	};

	/**
	 * 定位（`revealSeq` 变一次做一次）：把 `activePath` 的祖先目录逐层展开，
	 * 等它们都开好了，再把那一行滚进可见区。
	 *
	 * 为什么不在 `activePath` 一变就做：切标签 / 在里面点个文件也会改 activePath，
	 * 那样会把用户手动翻到的地方一次次抽走。只有外面说「定位一下」才动。
	 */
	const [pendingReveal, setPendingReveal] = useState<string | null>(null);
	const lastReveal = useRef(-1);
	useEffect(() => {
		if (lastReveal.current === revealSeq) return;
		lastReveal.current = revealSeq;
		const target = revealPath ?? activePath;
		if (revealSeq === 0 || !target) return;
		setPendingReveal(target);
	}, [revealSeq, revealPath, activePath]);

	// 第一层列出来之前不能定位（祖先目录根本不在 nodes 里）
	const loaded = nodes.length > 0;
	useEffect(() => {
		if (pendingReveal === null || !loaded) return;
		let cancelled = false;
		void (async () => {
			for (const dir of ancestorDirs(pendingReveal)) {
				const node = nodesRef.current.find((item) => item.entry.path === dir);
				if (!node) {
					// 这一层不在树里：要么路径对不上，要么它是个**隐藏目录**（树默认不列 "." 开头的）。
					// 后一种情况请上面把「眼睛」打开 —— 树会重新拉一遍，本效应会被重新触发，接着往下展开。
					if (!showHidden && hiddenAncestor(pendingReveal) !== null) onNeedHidden?.();
					return; // 留着 pendingReveal，等重新加载后再来
				}
				if (!node.expanded) await expandDir(dir);
				if (cancelled) return;
			}
			// 终点自己就是个目录（文件名搜索里点了一条目录）：把它也摊开，
			// 否则「定位」只是滚到一个**闭合的**目录行上，看不出里面有什么东西
			const leaf = nodesRef.current.find((item) => item.entry.path === pendingReveal);
			if (leaf?.entry.isDir && !leaf.expanded) await expandDir(pendingReveal);
			if (cancelled) return;
			setPendingReveal(null);
			// 等这一帧真的渲染出来再滚（刚展开的子行在下一个提交里才有节点）
			requestAnimationFrame(() => {
				const row = treeRef.current?.querySelector<HTMLElement>(`[data-path="${CSS.escape(pendingReveal)}"]`);
				// block: nearest —— 已经在屏幕上就不动，只在看不见时滚到边上
				row?.scrollIntoView({ block: "nearest" });
			});
		})();
		return () => {
			cancelled = true;
		};
	}, [pendingReveal, loaded]);

	if (!root) return <div className="filetree-empty">{t("还没有打开会话，不知道是哪个项目。")}</div>;

	return (
		<div className="filetree" ref={treeRef}>
			{error ? <div className="filetree-error">{error}</div> : null}
			{nodes.map((node, index) => {
				// 文件取自己的状态；目录取「底下有没有改动」的聚合结果
				const fileStatus = gitStatus.entries[node.entry.path];
				const dirStatus = dirtyDirs.get(node.entry.path);
				const rowStatus = node.entry.isDir ? dirStatus : fileStatus?.status;
				const fileType = node.entry.isDir ? null : fileTypeOf(node.entry.name);
				const rowTitle = node.entry.isDir
					? node.entry.path
					: fileStatus
						? `${node.entry.path}\n${STATUS_LETTER[fileStatus.status]}${
								fileStatus.added || fileStatus.removed ? ` · +${fileStatus.added} −${fileStatus.removed}` : ""
							}`
						: node.entry.path;
				return (
					<div className="filetree-item" key={node.entry.path || index}>
						<button
							type="button"
							data-path={node.entry.path}
							className={`filetree-row filetree-${node.entry.isDir ? "dir" : "file"}${
								rowStatus ? ` filetree-${rowStatus}` : ""
							}${!node.entry.isDir && node.entry.path === activePath ? " filetree-row-on" : ""}`}
							style={{ paddingLeft: 8 + node.depth * 14 }}
							onClick={() => (node.entry.isDir ? void toggleDir(node.entry.path) : onOpenFile(node.entry.path))}
							title={rowTitle}
						>
							<span className="filetree-icon" aria-hidden="true">
								{node.entry.isDir ? (node.expanded ? "▾" : "▸") : null}
							</span>
							{node.entry.isDir ? (
								/* 目录：**开着 / 合着两种文件夹图标**（已换成线条 SVG，不再用 emoji），
								 * 配合左边的三角，一眼看出是不是展开着的 */
								<FolderIcon
									open={node.expanded}
									className={`filetree-folder${node.expanded ? " filetree-folder-open" : ""}`}
								/>
							) : (
								/* 文件：类型小标（GO / {} / PY …），认不出的给一个通用文档图标 */
								<span className={`filetree-type${fileType ? ` filetype-${fileType.tone}` : ""}`} aria-hidden="true">
									{fileType ? fileType.label : "▤"}
								</span>
							)}
							<span className="filetree-name">{node.entry.name}</span>
							{node.loading ? <span className="filetree-hint">…</span> : null}
							{/* 右侧：git 改动标记（M / A / U …）—— 目录只在有改动时打一个点 */}
							{node.entry.isDir ? (
								rowStatus ? (
									<span
										className={`filetree-status filetree-status-${rowStatus} filetree-status-dot`}
										aria-hidden="true"
									/>
								) : null
							) : rowStatus ? (
								<span className={`filetree-status filetree-status-${rowStatus}`} aria-hidden="true">
									{STATUS_LETTER[rowStatus]}
								</span>
							) : null}
						</button>
						{/* 悬浮出现「@ 提及」：把 @path 引用直接塞进输入框（不打开预览，一步到位） */}
						{node.entry.isDir ? null : (
							<button
								type="button"
								className="filetree-mention"
								title={`把 @${node.entry.path} 加到对话`}
								onClick={() => setDraft(`${referenceFor(node.entry.path, null)} `)}
							>
								@ {t("提及", "mention")}
							</button>
						)}
						{node.error ? <div className="filetree-error">{node.error}</div> : null}
					</div>
				);
			})}
		</div>
	);
}
