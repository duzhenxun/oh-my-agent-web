/**
 * 文件树的纯逻辑（不碰 React / DOM，单测能直接引）。
 *
 * 树是一维数组：子行紧跟父行、用 `depth` 表示层级。这样展开/收起只动一个数组，
 * 但也意味着**收起时必须把后面的子孙行一起删掉** —— 只把 `expanded` 改成 false 的话，
 * 箭头翻过来了、子行却还留在原地（真实踩过：点了收不起来）。
 */
export type TreeRow = { depth: number; expanded?: boolean };

/** 第 index 行的子孙区段：从它后面第一个更深的行开始，到第一个「不更深」的行为止 */
export function descendantRange(rows: TreeRow[], index: number): { from: number; to: number } {
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
