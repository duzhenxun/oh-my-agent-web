/**
 * unified diff 的解析（`git diff` 原样）——纯函数，不碰 DOM。
 *
 * 为什么不直接 `<pre>` 一整坨：用户要的是「哪几行删了、哪几行加了」，
 * 那就得把 +/- 拆成行、配上新旧行号、按 git 的配色摆出来（见 components/FileDiff.tsx）。
 */

/** 服务端 `/api/files/diff` 的回包（对照 server/files/git-info.ts 的 FileDiff） */
export type FileDiffPayload = {
	isRepo: boolean;
	path: string | null;
	/** 文件还没有基线（未跟踪 / 刚加的）：整份都算新增 */
	untracked: boolean;
	diff: string;
	added: number;
	removed: number;
	truncated: boolean;
	error?: string;
};

type DiffRow =
	/** 文件头：`diff --git` / `index` / `---` / `+++` / `new file mode` */
	| { kind: "meta"; text: string }
	/** 一个改动块的头：`@@ -12,7 +12,9 @@` */
	| { kind: "hunk"; text: string }
	| { kind: "ctx"; text: string; oldNo: number; newNo: number }
	| { kind: "add"; text: string; newNo: number }
	| { kind: "del"; text: string; oldNo: number }
	/** `\ No newline at end of file` 这类提示 */
	| { kind: "note"; text: string };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/**
 * 逐行解析。行号只在 hunk 里累加：hunk 之外的行（文件头）没有行号可给。
 *
 * 注意 `+++` / `---` 要分辨清楚：它们只出现在**第一个 hunk 之前**，
 * 所以先看「是否已经进过 hunk」，进过之后 `+++x` 就是一行「加了个 +x」的正文。
 */
export function parseDiff(text: string): DiffRow[] {
	const rows: DiffRow[] = [];
	let oldNo = 0;
	let newNo = 0;
	let inHunk = false;
	// `/\r?\n/`：Windows 上编辑过的 diff 每行尾带 `\r`，不剥掉会让 hunk 头匹配失败
	for (const line of text.split(/\r?\n/)) {
		if (line === "") continue;
		const hunk = HUNK.exec(line);
		if (hunk) {
			oldNo = Number(hunk[1]);
			newNo = Number(hunk[2]);
			inHunk = true;
			rows.push({ kind: "hunk", text: line });
			continue;
		}
		if (line.startsWith("\\")) {
			rows.push({ kind: "note", text: line });
			continue;
		}
		if (!inHunk) {
			rows.push({ kind: "meta", text: line });
			continue;
		}
		if (line.startsWith("+")) {
			rows.push({ kind: "add", text: line.slice(1), newNo });
			newNo += 1;
			continue;
		}
		if (line.startsWith("-")) {
			rows.push({ kind: "del", text: line.slice(1), oldNo });
			oldNo += 1;
			continue;
		}
		// 上下文行以空格开头（有些工具会省略那个空格，也当作上下文处理）
		const body = line.startsWith(" ") ? line.slice(1) : line;
		rows.push({ kind: "ctx", text: body, oldNo, newNo });
		oldNo += 1;
		newNo += 1;
	}
	return rows;
}
