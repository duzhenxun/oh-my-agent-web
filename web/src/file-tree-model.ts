/**
 * 文件树的纯逻辑（不碰 React / DOM）。
 *
 * 树是一维数组：子行紧跟父行、用 `depth` 表示层级。这样展开/收起只动一个数组，
 * 但也意味着**收起时必须把后面的子孙行一起删掉** —— 只把 `expanded` 改成 false 的话，
 * 箭头翻过来了、子行却还留在原地（真实踩过：点了收不起来）。
 */
type TreeRow = { depth: number; expanded?: boolean };

/** 第 index 行的子孙区段：从它后面第一个更深的行开始，到第一个「不更深」的行为止 */
function descendantRange(rows: TreeRow[], index: number): { from: number; to: number } {
	const row = rows[index];
	if (!row) return { from: index + 1, to: index + 1 };
	let to = index + 1;
	while (to < rows.length && (rows[to]?.depth ?? 0) > row.depth) to += 1;
	return { from: index + 1, to };
}

/** 收起第 index 行：改 `expanded`，并删掉它的子孙行（返回新数组，不改入参） */
export function collapseAt<T extends TreeRow>(rows: T[], index: number): T[] {
	const row = rows[index];
	if (!row) return rows;
	const { to } = descendantRange(rows, index);
	const head = rows.slice(0, index + 1).map((item, i) => (i === index ? { ...item, expanded: false } : item));
	return [...head, ...rows.slice(to)];
}

/**
 * 定位一个文件要依次打开的祖先目录（外层在前）：`a/b/c.ts` → `["a", "a/b"]`。
 *
 * 树是懒加载的（点开才列下一层），所以「定位到某个文件」= 把这几个目录按顺序展开，
 * 最后再把那一行选上。深度不限 —— 多深就展开多深。
 */
export function ancestorDirs(path: string): string[] {
	const parts = path.split("/").filter((part) => part !== "");
	const dirs: string[] = [];
	for (let i = 1; i < parts.length; i += 1) dirs.push(parts.slice(0, i).join("/"));
	return dirs;
}

/**
 * 打开一个文件时，「文件 ▾」那个根要不要跟着切。
 *
 * 要切：文件不在左树当前根下面 —— 不切的话它根本不在那棵树里，展开再多层也定位不到
 * （从全文搜索/文件搜索点开别的项目的文件就是这种情况）。
 * 不要切：文件就在当前根下面 —— 保持 `null`（= 「跟随当前会话」），
 * 不然下拉框会被人没碰过的一次点击默默改成某个固定项目。
 */
export function nextTreeRoot(current: string | null, workspaceRoot: string | null, fileRoot: string): string | null {
	const effective = current ?? workspaceRoot ?? "";
	if (effective === fileRoot) return current;
	return fileRoot === "" ? null : fileRoot;
}

/**
 * 定位时会经过的**隐藏目录**（`.` 开头的段，如 `.agents/x/y.md` → `.agents`）。没有就 null。
 *
 * 为什么需要：树默认不列点开头的文件（跟系统文件管理器一致），从结果里点开一个
 * `.playwright-cli/…` 里的文件时，祖先目录**根本不在树里**，不管展开多少层都定位不过去。
 * 碰到这种情况就把「眼睛」（显示隐藏文件）打开，再继续展开。
 */
export function hiddenAncestor(path: string): string | null {
	for (const dir of ancestorDirs(path)) {
		if (dir.split("/").some((part) => part.startsWith("."))) return dir;
	}
	return null;
}
