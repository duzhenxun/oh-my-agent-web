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
import { readFile, stat } from "node:fs/promises";
import { join, isAbsolute, resolve } from "node:path";

/** 纯函数：把 HEAD 内容解析成分支名（detached 时返回短 hash） */
export function parseHead(content: string): string | null {
	const text = content.trim();
	if (text === "") return null;
	const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(text);
	if (ref?.[1]) return ref[1];
	// detached HEAD：直接是 40 位 sha，取前 7 位够认
	return /^[0-9a-f]{7,40}$/i.test(text) ? text.slice(0, 7) : null;
}

export type GitInfo = { branch: string | null; isRepo: boolean };

/** 工作区可能在仓库的子目录里：从 root 往上找 6 层 `.git`，返回**仓库（工作树）根** */
export async function findRepoRoot(root: string): Promise<string | null> {
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

export async function readGitInfo(root: string): Promise<GitInfo> {
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

export type GitBranches = {
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

export type CheckoutResult =
	| { ok: true; branch: string | null }
	/** `dirty` 有值 = 没真的去切：工作区有未提交改动，等界面确认（force）再切 */
	| { ok: false; message: string; dirty?: WorktreeStatus };

/** 工作区未提交改动（`git status --porcelain`）：界面弹确认时列前几个文件名 */
export type WorktreeStatus = { files: string[]; total: number };

export async function readWorktreeStatus(repo: string): Promise<WorktreeStatus> {
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
