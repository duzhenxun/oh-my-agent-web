/**
 * 路径显示（前端）。**只用于展示，不用于请求或落盘。**
 *
 * 服务端返回的「相对路径标识符」已经统一成 `/` 分隔（见 server/util/paths.ts 的
 * toPosixPath），但**绝对路径**（cwd、项目根、agent 给的 `C:\a\b.png`）是原生的：
 * Windows 上是反斜杠。所以「取最后一段」必须同时认两种分隔符，否则 Windows 上
 * 侧栏项目名、终端标题、文件标题全都会显示成一整条路径。
 */

/** 最后一段（`/a/b.ts` 与 `C:\a\b.ts` 都给 `b.ts`） */
export function basename(path: string): string {
	const parts = segments(path);
	return parts.length === 0 ? path : (parts[parts.length - 1] ?? path);
}

/** 目录部分（`a/b/c.ts` → `a/b`；没有目录返回空串） */
export function dirname(path: string): string {
	const parts = segments(path);
	return parts.length <= 1 ? "" : parts.slice(0, -1).join("/");
}

/** 末尾 n 段；太长时前缀省略号（`…/a/b/c`） */
export function tailSegments(path: string, count: number): string {
	const parts = segments(path);
	if (parts.length <= count) return path;
	return `…/${parts.slice(-count).join("/")}`;
}

function segments(path: string): string[] {
	return path.split(/[\\/]+/).filter((part) => part !== "");
}

/**
 * 归一化「项目 / 工作区」路径，**只用于判断「这两个字符串是不是同一个目录」**。
 *
 * 为什么前端也要有一层：服务端在协议入口就把 workspace 归一化了（见
 * `server/util/paths.ts` 的 `normalizeWorkspacePath`），但**已经在内存里 / 已经写进
 * projectPrefs 的旧数据**不会自己变干净 —— 实测就有一条 workspace = `/a/b/`（macOS
 * 原生目录选择框回的带尾斜杠路径），而 pi 扫描出来的 cwd 是 `/a/b`。
 * 两个 key 一比，侧栏里同一个项目就变成两个组、同一条会话出现两次。
 *
 * 这里不碰文件系统（浏览器里也没有），只做字符串层面的收敛：
 * 折叠重复分隔符 + 去掉末尾分隔符（根目录除外）。
 * 「是不是绝对路径」判断不得：认不出来就原样返回 —— 不猜、不把脏数据改写成别的路径。
 */
export function normalizeCwd(cwd: string): string {
	const trimmed = cwd.trim();
	if (trimmed === "") return "";
	// 分隔符风格照输入来：Windows 上是反斜杠，在 POSIX 上反斜杠是合法文件名字符，不能乱换
	const windows = /^[A-Za-z]:/.test(trimmed) || (!trimmed.startsWith("/") && trimmed.includes("\\"));
	const sep = windows ? "\\" : "/";
	const body = trimmed.replace(windows ? /[\\/]+/g : /\/+/g, sep);
	const isRoot = body === sep || /^[A-Za-z]:[\\/]$/.test(body) || /^[\\/]{2}$/.test(body);
	if (isRoot) return body;
	return body.replace(windows ? /[\\/]+$/ : /\/+$/, "");
}

/**
 * 当前浏览器所在系统是不是 Windows。**只用于提示文案**，不要拿它做逻辑判断
 * （逻辑判断一律交给服务端的 `isAbsolute`）。没有 navigator 的环境按 POSIX 处理。
 */
export function isWindowsHost(): boolean {
	return typeof navigator !== "undefined" && /windows/i.test(navigator.userAgent);
}
