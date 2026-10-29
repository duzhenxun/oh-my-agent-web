/**
 * 技能的三种安装方式 + 删除。
 *
 * 装 Git 仓库里的技能时一律**整目录复制**，不只写一份 `SKILL.md`：
 * 那样 `scripts/`、`references/` 全丢 —— 而现在的技能大量靠这两样干活。
 *
 * 三条纪律：
 *   - **只往 `~/.agents/skills` 写**（目录由调用方给，默认就是它）：这是 pi 真正扫的那份，
 *     也是界面上「默认列出来」的那份，安装完不用第二处同步；
 *   - **不覆盖同名**：目标目录已存在就报错（`skill.exists`），让用户自己去删 ——
 *     静默覆盖会把人家手改过的技能冲掉，这比多一步麻烦糟得多；
 *   - **临时目录一定会清**（`finally`），下载/克隆失败不留下几百 MB 垃圾。
 */
import { execFile } from "node:child_process";
import { cp, mkdir, mkdtemp, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { isAbsolute, join } from "node:path";
import { promisify } from "node:util";
import { hasSkillFile, safeSkillDirName, type SkillHub } from "./skillhub.js";

const run = promisify(execFile);
/** git clone 的上限：技能仓库一般很小，卡住不收就是事故 */
const GIT_TIMEOUT_MS = 120_000;

type InstallResult = { ok: true; id: string; path: string; note?: string } | { ok: false; error: string };

async function exists(path: string): Promise<boolean> {
	return stat(path)
		.then(() => true)
		.catch(() => false);
}

/** 目标目录已有技能时的统一报错（README 里也这么写，用户知道下一步干什么） */
function existsError(id: string): InstallResult {
	return { ok: false, error: `这个技能目录已经存在：${id}（要重装先删掉它，我不想覆盖你手改过的东西）` };
}

/** 把一个技能目录整份复制到 `skillsRoot/<id>` */
async function copyInto(skillsRoot: string, sourceDir: string, id: string): Promise<InstallResult> {
	const target = join(skillsRoot, id);
	if (await exists(target)) return existsError(id);
	await mkdir(skillsRoot, { recursive: true });
	// `cp` 的 recursive 会连 `scripts/`、`references/`、`assets/` 一起带过去
	await cp(sourceDir, target, { recursive: true, errorOnExist: true, force: false });
	return { ok: true, id, path: target };
}

export type SkillInstaller = {
	/** SkillHub：下载 zip → 解包 → 整目录复制 */
	fromHub: (input: { slug: string; name?: string }) => Promise<InstallResult>;
	/** Git 仓库：克隆 → 列出仓库里的技能（两段式：先看有什么，再装哪一个） */
	listRepo: (repoUrl: string) => Promise<{ ok: true; skills: string[] } | { ok: false; error: string }>;
	fromRepo: (input: { repoUrl: string; skill: string; name?: string }) => Promise<InstallResult>;
	/** 手动创建一个技能（只写 SKILL.md） */
	manual: (input: { name: string; raw?: string }) => Promise<InstallResult>;
	/** 删除一个已安装的技能（整目录删） */
	remove: (id: string) => Promise<{ ok: boolean; error?: string }>;
};

function gitUrlLooksSafe(url: string): boolean {
	const value = url.trim();
	if (value === "") return false;
	// 允许 https / ssh / git@host:path / 本地绝对路径（自己机器上的仓库也该能装）
	if (/^https?:\/\//i.test(value)) return true;
	if (/^git@[^:\s]+:.+$/i.test(value)) return true;
	if (/^ssh:\/\//i.test(value)) return true;
	return isAbsolute(value) && !value.includes("..");
}

/** 克隆到一个临时目录；返回目录与清理函数 */
async function cloneRepo(repoUrl: string): Promise<{ dir: string; cleanup: () => Promise<void> }> {
	const workDir = await mkdtemp(join(tmpdir(), "oh-my-agent-web-repo-"));
	const dir = join(workDir, "repo");
	await run("git", ["clone", "--depth", "1", repoUrl, dir], {
		timeout: GIT_TIMEOUT_MS,
		maxBuffer: 8 * 1024 * 1024,
		env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
	});
	return { dir, cleanup: () => rm(workDir, { recursive: true, force: true }).catch(() => undefined) };
}

/** 仓库里的技能可能在根目录，也可能在 `skills/` 下（两种都认） */
async function findSkillInRepo(repoDir: string, skill: string): Promise<string | null> {
	const candidates = [join(repoDir, "skills", skill), join(repoDir, skill)];
	for (const candidate of candidates) {
		if (await hasSkillFile(candidate)) return candidate;
	}
	return null;
}

export function createSkillInstaller(options: { skillsRoot: string; hub: SkillHub }): SkillInstaller {
	const { skillsRoot, hub } = options;

	return {
		async fromHub(input) {
			const id = safeSkillDirName(input.name ?? input.slug);
			if (await exists(join(skillsRoot, id))) return existsError(id);
			try {
				const pkg = await hub.fetchPackage(input.slug);
				try {
					return await copyInto(skillsRoot, pkg.dir, id);
				} finally {
					await pkg.cleanup();
				}
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},

		async listRepo(repoUrl) {
			if (!gitUrlLooksSafe(repoUrl))
				return { ok: false, error: "仓库地址看起来不对（支持 https / ssh / git@host:path / 本地绝对路径）" };
			let cloned: { dir: string; cleanup: () => Promise<void> } | undefined;
			try {
				cloned = await cloneRepo(repoUrl.trim());
				const found = new Set<string>();
				for (const base of [join(cloned.dir, "skills"), cloned.dir]) {
					const entries = await readdir(base, { withFileTypes: true }).catch(() => []);
					for (const entry of entries) {
						if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
						if (await hasSkillFile(join(base, entry.name))) found.add(entry.name);
					}
				}
				if (found.size === 0) return { ok: false, error: "这个仓库里没找到技能（根目录或 skills/ 下要有 SKILL.md）" };
				return { ok: true, skills: [...found].sort() };
			} catch (error) {
				return { ok: false, error: describeGit(error) };
			} finally {
				await cloned?.cleanup();
			}
		},

		async fromRepo(input) {
			if (!gitUrlLooksSafe(input.repoUrl))
				return { ok: false, error: "仓库地址看起来不对（支持 https / ssh / git@host:path / 本地绝对路径）" };
			const id = safeSkillDirName(input.name ?? input.skill);
			if (await exists(join(skillsRoot, id))) return existsError(id);
			let cloned: { dir: string; cleanup: () => Promise<void> } | undefined;
			try {
				cloned = await cloneRepo(input.repoUrl.trim());
				const dir = await findSkillInRepo(cloned.dir, input.skill);
				if (dir === null) return { ok: false, error: `仓库里没找到技能 "${input.skill}"` };
				return await copyInto(skillsRoot, dir, id);
			} catch (error) {
				return { ok: false, error: describeGit(error) };
			} finally {
				await cloned?.cleanup();
			}
		},

		async manual(input) {
			const id = safeSkillDirName(input.name);
			const target = join(skillsRoot, id);
			if (await exists(target)) return existsError(id);
			await mkdir(target, { recursive: true });
			const name = input.name.trim() === "" ? id : input.name.trim();
			const body =
				input.raw !== undefined && input.raw.trim() !== ""
					? input.raw
					: `---\nname: ${name}\ndescription: （一句话说明这个技能什么时候用）\n---\n\n# ${name}\n\n写清楚：什么时候用它、怎么做、做完怎么确认。\n`;
			await writeFile(join(target, "SKILL.md"), body, "utf8");
			return { ok: true, id, path: target };
		},

		async remove(id) {
			const safe = safeSkillDirName(id);
			if (safe !== id) return { ok: false, error: `非法技能 id：${id}` };
			const target = join(skillsRoot, id);
			if (!(await hasSkillFile(target))) return { ok: false, error: `"${id}" 不是一个技能目录` };
			try {
				// 整目录删：SKILL.md（或禁用态的 .SKILL.md.disabled）与 scripts/references 一起走
				await rm(target, { recursive: true, force: true });
				return { ok: true };
			} catch (error) {
				return { ok: false, error: error instanceof Error ? error.message : String(error) };
			}
		},
	};
}

/** git 的报错尾巴通常很有用（`Repository not found` / `could not resolve host`），别吞掉 */
function describeGit(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	const stderr = (error as { stderr?: string }).stderr;
	const text = (stderr !== undefined && stderr.trim() !== "" ? stderr : message).trim();
	const lines = text
		.split("\n")
		.map((line) => line.trim())
		.filter((line) => line !== "");
	return `克隆失败：${lines.slice(-2).join(" / ").slice(0, 400)}`;
}
