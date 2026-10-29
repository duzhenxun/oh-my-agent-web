/**
 * 当前项目的 git 分支（文件管理下拉框右边那枚「⎇ main」小标签）。
 *
 * 两件事分开做：
 *   - **读当前分支**：直接读 `.git/HEAD`，不 spawn 进程 —— 只读几十字节，
 *     也不需要 git 装在某处、不会因为仓库损坏而卡住；
 *   - **列分支 / 切分支**（下拉菜单）：必须 spawn `git`（refs 可能塞在 packed-refs、
 *     切分支还要更新工作区），带超时、不带 shell、参数逐个传（注入不了）。
 * 兼容 `.git` 是**文件**的情况（worktree / submodule 里 `.git` 指向别处）。
 */
import { spawn } from "node:child_process";
import { mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, isAbsolute, relative, resolve } from "node:path";
import { resolveInsideRoot, isEscapePath } from "../util/paths.js";

/** 纯函数：把 HEAD 内容解析成分支名（detached 时返回短 hash） */
function parseHead(content: string): string | null {
	const text = content.trim();
	if (text === "") return null;
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref?.[1]) return ref[1];
	// detached HEAD：直接是 40 位 sha，取前 7 位够认
	return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7) : null;
}

type GitInfo = { branch: string | null; isRepo: boolean };

/** 工作区可能在仓库的子目录里：从 root 往上找 6 层 `.git`，返回**仓库（工作树）根** */
async function findRepoRoot(root: string): Promise<string | null> {
	let dir = resolve(root);
	for (let depth = 0; depth < 6; depth += 1) {
		try {
			await stat(join(dir, ".git"));
			return dir;
		} catch {
			const parent = resolve(dir, "..");
			if (parent === dir) break;
			dir = parent;
		}
	}
	return null;
}

async function readGitInfo(root: string): Promise<GitInfo> {
	const repo = await findRepoRoot(root);
	if (!repo) return { branch: null, isRepo: false };
	const gitPath = join(repo, ".git");
	try {
		const info = await stat(gitPath);
		const headPath = info.isDirectory() ? join(gitPath, "HEAD") : await worktreeHead(gitPath);
		if (!headPath) return { branch: null, isRepo: false };
		return { branch: parseHead(await readFile(headPath, "utf8")), isRepo: true };
	} catch {
		return { branch: null, isRepo: false };
	}
}

/** `.git` 是文件时内容形如 `gitdir: /path/to/repo/.git/worktrees/x` */
async function worktreeHead(gitFile: string): Promise<string | null> {
	try {
		const content = (await readFile(gitFile, "utf8")).trim();
		const match = /^gitdir:\s*(.+)$/.exec(content);
		if (!match?.[1]) return null;
		const target = isAbsolute(match[1]) ? match[1] : resolve(join(gitFile, ".."), match[1]);
		return join(target, "HEAD");
	} catch {
		return null;
	}
}

type GitRun = { ok: boolean; stdout: string; stderr: string };

/**
 * 跑一条 git 命令：`git -C <repo> …`，5 秒超时，`LC_ALL=C`（错误信息稳定成英文）。
 * 不经过 shell —— 分支名即使带 `;` `$()` 也只是普通参数。
 */
function runGit(repo: string, args: string[], timeoutMs = 5000): Promise<GitRun> {
	return new Promise((done) => {
		let stdout = "";
		let stderr = "";
		let settled = false;
		const finish = (result: GitRun) => {
			if (settled) return;
			settled = true;
			clearTimeout(timer);
			done(result);
		};
		const child = spawn("git", ["-C", repo, ...args], {
			stdio: ["ignore", "pipe", "pipe"],
			env: { ...process.env, GIT_TERMINAL_PROMPT: "0", LC_ALL: "C" },
		});
		const timer = setTimeout(() => {
			child.kill("SIGKILL");
			finish({ ok: false, stdout, stderr: stderr || "git 命令超时（5s）" });
		}, timeoutMs);
		child.stdout.setEncoding("utf8").on("data", (chunk: string) => {
			stdout += chunk;
		});
		child.stderr.setEncoding("utf8").on("data", (chunk: string) => {
			stderr += chunk;
		});
		child.on("error", (error) => finish({ ok: false, stdout, stderr: error.message }));
		child.on("close", (code) => finish({ ok: code === 0, stdout, stderr }));
	});
}

/**
 * 仓库里所有文件（**相对仓库根**，含未跟踪但未被 ignore 的）。
 *
 * 给「点了只写了文件名的链接」找候选用（见 `path-resolve.ts`）：
 * `ls-files` 一次就把清单吐完，比递归扫盘快得多，也自动跳过 `.gitignore` 里的东西。
 * 不是仓库 / git 不可用 / 目录太大时返回 `null` —— 调用方自己去扫盘。
 */
export async function listRepoFiles(root: string, max = 20000): Promise<{ repo: string; files: string[] } | null> {
	const repo = await findRepoRoot(root);
	if (!repo) return null;
	// `-z`：路径用 NUL 分隔，文件名里的空格 / 中文 / 换行都不用再解析一遍
	const result = await runGit(
		repo,
		["-c", "core.quotepath=false", "ls-files", "-z", "--cached", "--others", "--exclude-standard"],
		20000,
	);
	if (!result.ok && result.stdout === "") return null;
	const files: string[] = [];
	for (const entry of result.stdout.split("\0")) {
		if (entry === "") continue;
		files.push(entry);
		if (files.length >= max) break;
	}
	return { repo, files };
}

type GitBranches = {
	isRepo: boolean;
	/** 当前分支（detached 时是短 hash） */
	branch: string | null;
	/** 本地分支名，最近提交的排前面 */
	branches: string[];
	/** 列表拿不到时的原因（比如机器上没装 git）：界面照常显示当前分支，只禁用下拉 */
	error?: string;
};

/** 当前分支 + 本地分支清单（下拉菜单用；每次打开菜单可以刷新一次） */
export async function readGitBranches(root: string): Promise<GitBranches> {
	const info = await readGitInfo(root);
	if (!info.isRepo) return { ...info, branches: [] };
	const repo = await findRepoRoot(root);
	if (!repo) return { ...info, branches: [] };
	const result = await runGit(repo, ["branch", "--no-color", "--format=%(refname:short)", "--sort=-committerdate"]);
	if (!result.ok) return { ...info, branches: [], error: firstLine(result.stderr) || "列不出分支" };
	const branches = result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return { ...info, branches };
}

type CheckoutResult =
	| { ok: true; branch: string | null }
	/** `dirty` 有值 = 没真的去切：工作区有未提交改动，等界面确认（force）再切 */
	| { ok: false; message: string; dirty?: WorktreeStatus };

/** 工作区未提交改动（`git status --porcelain`）：界面弹确认时列前几个文件名 */
type WorktreeStatus = { files: string[]; total: number };

async function readWorktreeStatus(repo: string): Promise<WorktreeStatus> {
	const result = await runGit(repo, ["status", "--porcelain"], 8000);
	if (!result.ok) return { files: [], total: 0 };
	const lines = result.stdout
		.split("\n")
		.map((line) => line.trimEnd())
		.filter((line) => line !== "");
	// 每行前 3 个字符是状态码（` M ` / `?? ` / `R  `），后面才是路径
	const files = lines.slice(0, 20).map((line) => line.slice(3).trim() || line.trim());
	return { files, total: lines.length };
}

/**
 * 切分支（`git checkout <branch>`，不用 shell）。
 *
 * 只允许切到**本地已有分支**：名字先在清单里对一遍，既挡掉 `-b` 这类会被 git 当成
 * 参数的名字，也避免"点了一下结果多建出一个分支"。工作区有冲突改动时 git 自己会拒绝，
 * 它的报错原样回给界面（比我们自己猜准）。
 *
 * 工作区脏的时候默认**不切**，先把改动清单交给界面去问一句（`force: true` 才真切）——
 * 切过去那些改动会跟着走，用户至少得知道一声。
 */
export async function checkoutBranch(
	root: string,
	branch: string,
	options: { force?: boolean } = {},
): Promise<CheckoutResult> {
	const name = branch.trim();
	if (!/^[^\s~^:?*[\\]+$/.test(name) || name.startsWith("-")) {
		return { ok: false, message: "分支名不合法" };
	}
	const repo = await findRepoRoot(root);
	if (!repo) return { ok: false, message: "这里不是 git 仓库" };
	const listed = await readGitBranches(repo);
	if (!listed.isRepo) return { ok: false, message: "这里不是 git 仓库" };
	if (!listed.branches.includes(name)) return { ok: false, message: `没有本地分支 ${name}` };
	if (listed.branch === name) return { ok: true, branch: name };
	if (options.force !== true) {
		const dirty = await readWorktreeStatus(repo);
		if (dirty.total > 0) {
			return { ok: false, dirty, message: `工作区有 ${dirty.total} 个未提交改动，没切换` };
		}
	}
	const result = await runGit(repo, ["checkout", "--quiet", name], 15000);
	if (!result.ok) {
		return { ok: false, message: firstLine(result.stderr) || `切换到 ${name} 失败` };
	}
	const after = await readGitInfo(repo);
	return { ok: true, branch: after.branch };
}

/**
 * git 的报错常常是多行（还会列一串文件）：挑最有用的一两行喂给界面。
 * `error:` / `fatal:` 那行是结论，后面通常跟着「哪些文件挡路了」。
 */
function firstLine(text: string): string {
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	const pick = lines.find((line) => /^(error|fatal):/i.test(line)) ?? lines[0] ?? "";
	const detail = lines.find((line) => line !== pick && !/^hint:/i.test(line)) ?? "";
	const summary = detail ? `${pick} ${detail}` : pick;
	return summary.length > 240 ? `${summary.slice(0, 240)}…` : summary;
}

/* ---------------- 单个文件的「改了什么」（git diff） ---------------- */

/** diff 上限：改了几万行的文件也不必一次全塞给浏览器（界面会提示被截断） */
const DIFF_MAX_CHARS = 200_000;

export type FileDiff = {
	/** 这个工作区在 git 仓库里吗（不是 → 界面不显示「改动」页签） */
	isRepo: boolean;
	/** 相对仓库根的路径；null = 文件不在仓库里 */
	path: string | null;
	/** 文件还没有基线（未跟踪 / 刚加的）：整份内容都算新增 */
	untracked: boolean;
	/** unified diff 原文（空串 = 没有未提交改动） */
	diff: string;
	added: number;
	removed: number;
	/** 太长被截断 */
	truncated: boolean;
	error?: string;
};

/** 数一下 +/− 行（对比的是工作区与 HEAD，所以就是「这次改了什么」） */
function countChanges(text: string): { added: number; removed: number } {
	let added = 0;
	let removed = 0;
	for (const line of text.split("\n")) {
		// `+++ b/x` / `--- a/x` 是文件头，不算增删
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) added += 1;
		else if (line.startsWith("-")) removed += 1;
	}
	return { added, removed };
}

/**
 * 一个文件「改了什么」：`git diff` 的 unified 输出（工作区 vs HEAD，含已暂存的）。
 *
 * 为什么不自己存「改动前/改动后」：编辑可能来自任何工具（write / edit / bash 里的 sed…），
 * 逐次记账既存不全也不准；而工作区本来就在 git 里，`git diff HEAD` 就是用户心里的那份对比。
 * 代价是它只说明「相对上次提交」，跟「这一轮改的」不是一回事（界面文案也照这个说）。
 */
/**
 * `git diff --no-index` 需要一个「空基线」。原来写死 `/dev/null`：Git for Windows 下
 * 这个路径不保证存在（取决于 MSYS 映射），新文件的 diff 会整个空掉。
 * 这里用一个真存在的空文件代替，并在输出里再换成 `/dev/null` —— 界面与以前一致，
 * 也不把本机临时目录路径漏给前端。进程只建一次，退出时收掉。
 */
let emptyBaseline: string | null = null;
function emptyBaselineFile(): string {
	if (emptyBaseline !== null) return emptyBaseline;
	const dir = mkdtempSync(join(tmpdir(), "oh-my-agent-web-diff-"));
	const file = join(dir, "empty");
	writeFileSync(file, "");
	emptyBaseline = file;
	process.once("exit", () => {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			// 退出阶段的清理失败不该影响任何东西
		}
	});
	return file;
}

export async function readFileDiff(root: string, relPath: string): Promise<FileDiff> {
	const none: FileDiff = {
		isRepo: false,
		path: null,
		untracked: false,
		diff: "",
		added: 0,
		removed: 0,
		truncated: false,
	};
	const workspaceRepo = await findRepoRoot(root);

	// 相对路径先夹在工作区里（`../../etc/passwd` 要挡掉）；
	// 绝对路径（模型读过的 skill 文档之类，可能在别处）直接按它比
	let filePath: string;
	if (isAbsolute(relPath)) {
		try {
			filePath = realpathSync(relPath);
		} catch {
			return none; // 刚被删的文件：没东西可比
		}
	} else {
		const safe = resolveInsideRoot(root, join(root, relPath), realpathSync);
		if (!safe.ok) return { ...none, isRepo: workspaceRepo !== null, error: safe.reason };
		filePath = safe.path;
	}
	// 仓库根从**文件自己**往上找：工作区外的绝对路径也要能看出它改了什么
	const repo = (await findRepoRoot(filePath)) ?? workspaceRepo;
	if (!repo) return none;
	const repoPath = relative(repo, filePath);
	if (repoPath === "" || isEscapePath(repoPath)) return { ...none, isRepo: true };

	// 关掉 quotepath：中文/空格路径会变成 `"\346\226\207"` 那种转义，界面上没法看
	const run = (args: string[]) => runGit(repo, ["-c", "core.quotepath=false", ...args], 8000);

	const tracked = (await run(["ls-files", "--error-unmatch", "--", repoPath])).ok;
	let text: string;
	let error: string | undefined;
	if (tracked) {
		const result = await run(["diff", "--no-color", "--no-ext-diff", "HEAD", "--", repoPath]);
		text = result.stdout;
		// 还没有任何提交时 `HEAD` 不存在：退回「暂存区 vs 工作区」，至少能看出没提交的那些改动
		if (!result.ok && text === "") {
			const fallback = await run(["diff", "--no-color", "--no-ext-diff", "--", repoPath]);
			text = fallback.stdout;
			error = fallback.ok || text !== "" ? undefined : firstLine(fallback.stderr);
		}
	} else {
		// 新文件：git diff 对它没有基线，拿一个空文件比一次（退出码 1 = 有差异，正常）
		const baseline = emptyBaselineFile();
		const result = await run(["diff", "--no-color", "--no-ext-diff", "--no-index", "--", baseline, repoPath]);
		// 把临时目录路径换回 `/dev/null`：界面上跟以前一模一样，也不泄露本机临时目录
		text = result.stdout.split(baseline).join("/dev/null");
		if (text === "" && !result.ok) error = firstLine(result.stderr);
	}

	// 截断时落在行边界上：半个 hunk 头比没有更让人困惑
	let truncated = false;
	if (text.length > DIFF_MAX_CHARS) {
		const cut = text.lastIndexOf("\n", DIFF_MAX_CHARS);
		text = text.slice(0, cut > 0 ? cut : DIFF_MAX_CHARS);
		truncated = true;
	}
	const { added, removed } = countChanges(text);
	return {
		isRepo: true,
		path: repoPath,
		untracked: !tracked,
		diff: text,
		added,
		removed,
		truncated,
		...(error ? { error } : {}),
	};
}

/* ---------------- 工作区的逐文件状态（文件树上的 M / A / U 标记） ---------------- */

export type FileStatusKind = "modified" | "added" | "deleted" | "untracked" | "renamed" | "conflicted";

export type FileStatusEntry = {
	status: FileStatusKind;
	/** 相对 HEAD 的新增/删除行数（拿不到就是 0，界面只在有值时显示） */
	added: number;
	removed: number;
};

type FileStatusMap = {
	isRepo: boolean;
	/** 相对**工作区根**的路径 → 状态（工作区是仓库子目录时已经换算过） */
	entries: Record<string, FileStatusEntry>;
};

/** 文件树一次最多标多少个：几千个改动的仓库不必把整张表塞进快照 */
const MAX_STATUS_ENTRIES = 4000;

/** 把 porcelain 的两位状态码归类 */
function classify(code: string): FileStatusKind | null {
	if (code === "??") return "untracked";
	if (code.includes("U") || code === "AA" || code === "DD") return "conflicted";
	if (code.includes("R")) return "renamed";
	if (code.includes("D")) return "deleted";
	if (code.includes("A")) return "added";
	if (code.includes("M") || code.includes("T")) return "modified";
	return null;
}

/**
 * 工作区里每个文件的改动状态（`git status` + `git diff --numstat`）。
 *
 * 为什么要两个命令：status 给「有没有改」，numstat 给「改了多少行」；
 * 文件树上前者显示 M/A/U，后者做 tooltip（`+12 −3`）。
 * 只用 porcelain 的 `-z` 形式：路径里有空格/中文时普通输出会被加引号转义。
 */
export async function readFileStatuses(root: string): Promise<FileStatusMap> {
	const none: FileStatusMap = { isRepo: false, entries: {} };
	const repo = await findRepoRoot(root);
	if (!repo) return none;
	const run = (args: string[]) => runGit(repo, ["-c", "core.quotepath=false", ...args], 10000);

	const status = await run(["status", "--porcelain", "-z", "--untracked-files=normal"]);
	if (!status.ok && status.stdout === "") return { isRepo: true, entries: {} };

	/** 仓库路径 → 工作区路径；在工作区外面（仓库其它目录）就丢掉 */
	const toWorkspacePath = (repoPath: string): string | null => {
		const rel = relative(root, join(repo, repoPath));
		if (rel === "" || isEscapePath(rel)) return null;
		return rel;
	};

	const entries: Record<string, FileStatusEntry> = {};
	// -z：条目之间用 NUL 分隔；重命名条目是「状态\0新路径\0旧路径」
	const fields = status.stdout.split("\0");
	for (let index = 0; index < fields.length; index += 1) {
		const field = fields[index];
		if (!field || field.length < 4) continue;
		const code = field.slice(0, 2);
		const kind = classify(code);
		const repoPath = field.slice(3);
		// 重命名：这一条后面还跟着一条「原路径」，跳过它
		if (code.includes("R") || code.includes("C")) index += 1;
		if (!kind) continue;
		const workspacePath = toWorkspacePath(repoPath);
		if (workspacePath === null) continue;
		entries[workspacePath] = { status: kind, added: 0, removed: 0 };
		if (Object.keys(entries).length >= MAX_STATUS_ENTRIES) break;
	}

	// 行数（只有已跟踪文件有；未跟踪文件在 HEAD 里不存在，不算）
	const numstat = await run(["diff", "--numstat", "-z", "HEAD", "--"]);
	if (numstat.ok || numstat.stdout !== "") {
		const parts = numstat.stdout.split("\0");
		for (const part of parts) {
			if (part === "") continue;
			// 形如 "12\t3\tpath"（重命名是 "12\t3\t\0old\0new"，这里按最后一段当路径）
			const match = /^(\d+|-)\t(\d+|-)\t(.*)$/.exec(part);
			if (!match) continue;
			const repoPath = match[3] ?? "";
			const workspacePath = toWorkspacePath(repoPath);
			if (workspacePath === null) continue;
			const entry = entries[workspacePath];
			if (!entry) continue;
			entry.added = match[1] === "-" ? 0 : Number(match[1]);
			entry.removed = match[2] === "-" ? 0 : Number(match[2]);
		}
	}

	return { isRepo: true, entries };
}
