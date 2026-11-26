/**
 * PATH 相关的纯函数：拼接、去重、平台分隔符。
 *
 * 为什么单独一个模块：引擎安装（`engine-install.ts`）要往 PATH 里挂「用户装过的那颗引擎」，
 * 而 PATH 的拼法在 POSIX / Windows 上不一样（`:` vs `;`、`Path` vs `PATH`、`/` vs `\`），
 * 散在各处迟早漏一个平台。这里全部做成纯函数（平台 / 环境全当参数），单测不碰真实环境。
 */
/** PATH 的分隔符跟着**目标平台**走，不是跟着宿主走（Win 上是 `;`） */
export function pathSeparator(platform: NodeJS.Platform = process.platform): string {
	return platform === "win32" ? ";" : ":";
}

/**
 * 目录比较用：去掉尾部分隔符；Windows 上不区分大小写，且 `/` 与 `\` 视为同一个分隔符。
 *
 * 为什么要管分隔符：Windows 的 PATH 里混着两种写法很常见（Git Bash、手改的环境变量、
 * 各种安装器），不归一化的话同一个目录会被当成两个，PATH 里就会出现在两处。
 */
function sameDir(a: string, b: string, platform: NodeJS.Platform): boolean {
	const strip = (value: string) => {
		let text = value.trim();
		while (text.length > 1 && (text.endsWith("/") || text.endsWith("\\"))) text = text.slice(0, -1);
		return platform === "win32" ? text.replace(/\//g, "\\").toLowerCase() : text;
	};
	return strip(a) === strip(b);
}

/**
 * 把 `dirs` 前置进 PATH 字符串（纯函数，不碰 env）。
 *
 * 去重是必须的：启动路径上可能被调多次（cli → index 两段启动），
 * 不去重的话 PATH 会长出一串同样的目录，子进程排查时看着像配错了。
 */
export function prependToPath(
	pathValue: string | undefined,
	dirs: string[],
	platform: NodeJS.Platform = process.platform,
): string {
	const separator = pathSeparator(platform);
	const result: string[] = [];
	const push = (dir: string) => {
		const trimmed = dir.trim();
		if (trimmed === "") return;
		if (result.some((existing) => sameDir(existing, trimmed, platform))) return;
		result.push(trimmed);
	};
	for (const dir of dirs) push(dir);
	for (const dir of (pathValue ?? "").split(separator)) push(dir);
	return result.join(separator);
}

/**
 * 把 dirs **追加**到 PATH 末尾（与 `prependToPath` 相反）。
 *
 * 为什么引擎装好的目录要追加：用户自己也可能装过同名命令（codex / pi…），
 * 他那份必须优先 —— 从他终端跑的和界面上跑的应该是同一个二进制，否则同一句话两种行为。
 */
export function appendToPath(
	pathValue: string | undefined,
	dirs: string[],
	platform: NodeJS.Platform = process.platform,
): string {
	const separator = pathSeparator(platform);
	const result: string[] = [];
	const push = (dir: string) => {
		const trimmed = dir.trim();
		if (trimmed === "") return;
		if (result.some((existing) => sameDir(existing, trimmed, platform))) return;
		result.push(trimmed);
	};
	for (const dir of (pathValue ?? "").split(separator)) push(dir);
	for (const dir of dirs) push(dir);
	return result.join(separator);
}
