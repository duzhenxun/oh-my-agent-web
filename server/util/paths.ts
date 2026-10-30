/**
 * 路径解析与约束（纯函数）。
 *
 * 两个场景用它：
 *   1. `web/dist` 在哪 —— 源码运行与编译运行的层数不同（M1 踩过）；
 *   2. 路径是否落在工作区内 —— ADR-0006：`realpath` 之后必须在根内（防 `..` 与 symlink 逃逸）。
 *
 * 刻意把 `realpath` 作为参数注入：不依赖真实文件系统，调用方传 `fs.realpathSync`。
 */
import { join, relative, resolve, sep } from "node:path";

/**
 * 把路径统一成 `/` 分隔，**只用于「标识符」（相对路径 key / URL 参数 / 前端展示）**，
 * 不要拿它去读写文件 —— 真实文件操作一律走 `join`/`resolve`。
 *
 * 为什么必须有这一层：git 输出的 pathspec、前端拼的相对路径、历史会话里存的全是 `/`；
 * 而 Windows 上的 `join()` 产出的是 `\`。不统一的话同一份文件在文件树、git 状态、
 * 搜索结果里会变成三个不同的 key（界面上就是「M/A 标记集体消失」）。
 */
export function toPosixPath(path: string): string {
	return path.split(sep).join("/");
}

/**
 * Windows 保留设备名：`NUL`、`CON`、`COM1`…
 * 它们会被当成设备而不是文件（甚至带扩展名也一样，`nul.txt` 同样是设备）。
 */
const WINDOWS_RESERVED = new Set([
	"con",
	"prn",
	"aux",
	"nul",
	...Array.from({ length: 9 }, (_, index) => `com${index + 1}`),
	...Array.from({ length: 9 }, (_, index) => `lpt${index + 1}`),
]);

/** 控制字符（0x00-0x1f）在 Windows 文件名里一律非法；用码点判断避开控制字符正则 */
function hasControlChars(value: string): boolean {
	for (let index = 0; index < value.length; index += 1) if (value.charCodeAt(index) < 32) return true;
	return false;
}

/**
 * 纯函数：路径在 Windows 上是否「注定打不开」（POSIX 上永远返回 null）。
 *
 * 为什么要在入口就拒：Windows 上这些情况不是「报个错」而是「静默干奇怪的事」——
 * `join(root, "NUL")` 会命中设备名（读到空内容、看上去成功）；`foo.txt:bar` 会打开
 * NTFS 备用数据流；超长路径在 Node 没加 `\\?\` 前缀时直接 `ENOENT`，
 * 而递归搜索里的 `catch` 会把整棵子树静默丢掉。
 */
export function checkWindowsPath(
	value: string,
	platform: NodeJS.Platform = process.platform,
	maxLength = 250,
): string | null {
	if (platform !== "win32" || value === "") return null;
	if (value.length > maxLength) return `路径太长（Windows 上限约 260 字符）：${value.slice(0, 48)}…`;
	// 盘符里的冒号是合法的：先剥掉再逐段检查
	const withoutDrive = value.replace(/^[A-Za-z]:/, "");
	for (const segment of withoutDrive.split(/[\\/]+/)) {
		if (segment === "") continue;
		if (/[<>:"|?*]/.test(segment) || hasControlChars(segment)) return `路径里有 Windows 不允许的字符：${segment}`;
		if (/[. ]$/.test(segment)) return `Windows 不允许文件名以空格或点结尾：${segment}`;
		const stem = (segment.split(".")[0] ?? "").trim().toLowerCase();
		if (WINDOWS_RESERVED.has(stem)) return `「${segment}」是 Windows 的保留设备名，不能当文件路径`;
	}
	return null;
}

/**
 * 归一化「项目 / 工作区」路径（用户报的 bug：新建项目后侧栏里同一个项目出现两次）。
 *
 * 事故链：macOS 的原生目录选择框（`POSIX path of chosen`）回的是 `/a/b/`（**带尾斜杠**），
 * 这个字符串被当成会话的 workspace 存起来；而 pi 的 `SessionManager` 建会话时会先
 * `resolvePath(cwd)`（= `path.resolve`），写进会话 header 的是 `/a/b`。
 * 于是同一个项目在侧栏里有了两个 key（`/a/b/` 与 `/a/b`）：扫盘那份一个组、
 * 内存里这条会话又一个组，**两条都叫 piv、里面是同一条会话**（还都显示「运行中」）。
 *
 * 所以 workspace 一律在这里归一化成 pi 会写进 header 的那个形状 —— `resolve()` 正好做三件事：
 * 去掉尾斜杠 / 折叠重复分隔符 / 消掉 `.` 与 `..`。跟 pi 保持同一个算法，两边才对得上。
 * 认不出（空串、非绝对路径）就原样返回：不猜、也不把脏数据改写成别的路径。
 */
export function normalizeWorkspacePath(value: string): string {
	const trimmed = value.trim();
	if (trimmed === "") return "";
	// 只归一化绝对路径：相对路径 / 提示词当 cwd 的脏数据没有「正确形状」可言
	if (!trimmed.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(trimmed) && !trimmed.startsWith("\\\\")) return trimmed;
	return resolve(trimmed);
}

export function pickExisting(candidates: string[], exists: (path: string) => boolean): string | null {
	for (const candidate of candidates) if (exists(candidate)) return candidate;
	return null;
}

/** web/dist 的候选路径：先是「源码运行」，再是「编译后运行」 */
export function webDistCandidates(serverDir: string): string[] {
	return [join(serverDir, "..", "web", "dist"), join(serverDir, "..", "..", "web", "dist")];
}

/**
 * `candidate` 是否在 `root` 之内。
 *
 * 用「相对路径不以 `..` 开头」判断，而不是字符串 `startsWith`：
 * `/root2` 不是 `/root` 的子路径，但 `startsWith("/root")` 会误判为真。
 * 传入的路径应当是**已经 realpath 过**的（调用方负责），否则 symlink 能逃出去。
 */
export function isPathInside(root: string, candidate: string): boolean {
	const relativePath = relative(resolve(root), resolve(candidate));
	if (relativePath === "") return true; // 就是根本身
	return !isEscapePath(relativePath);
}

/**
 * `relative()` 的结果是不是「向上逃逸」。
 *
 * 为什么要单独一个函数：`startsWith("..")` 会把名字以两个点开头的**合法**条目
 * （`..foo`、`...cache`）也当成逃逸 —— 那种文件在文件树里看得见、点开却报越界。
 * 逃逸只有两种写法：正好是 `..`，或者 `..` 后面跟一个分隔符。
 */
export function isEscapePath(relativePath: string): boolean {
	if (relativePath === "..") return true;
	if (relativePath.startsWith(`..${sep}`)) return true;
	// 不同盘符 / UNC 下 relative() 会直接返回绝对路径
	return isAbsoluteLike(relativePath);
}

function isAbsoluteLike(path: string): boolean {
	return path.startsWith(sep) || /^[A-Za-z]:[\\/]/.test(path);
}

/**
 * 解析到真实路径并确认在工作区内（ADR-0006）。
 * `realpath` 失败（路径不存在）时按「不在根内」处理 —— 宁可拒绝，不要放行。
 */
export function resolveInsideRoot(
	root: string,
	candidate: string,
	realpath: (path: string) => string,
): { ok: true; path: string } | { ok: false; reason: string } {
	// Windows 的非法字符 / 保留名 / 超长路径在这里统一挡掉（POSIX 上是空操作）。
	// 放在这一层是因为它是文件、终端、上传的公共入口 —— 一处把关比每个调用方各写一遂靠谱。
	const windowsProblem = checkWindowsPath(candidate);
	if (windowsProblem !== null) return { ok: false, reason: windowsProblem };
	let realRoot: string;
	try {
		realRoot = realpath(root);
	} catch {
		return { ok: false, reason: `工作区根无法解析：${root}` };
	}
	let realCandidate: string;
	try {
		realCandidate = realpath(candidate);
	} catch {
		return { ok: false, reason: `路径不存在或无法解析：${candidate}` };
	}
	if (!isPathInside(realRoot, realCandidate)) {
		return { ok: false, reason: `路径越界（不在工作区内）：${candidate}` };
	}
	return { ok: true, path: realCandidate };
}
