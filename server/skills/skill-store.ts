/**
 * 技能列表与启停（P8）。
 *
 * 技能目录：`~/.agents/skills/<目录名>/SKILL.md`（frontmatter 里有 name / description），
 * 目录里还可能有 `scripts/`、`references/` 等。
 *
 * **启停的实现方式（刻意选择）**：把 `SKILL.md` 改名成 `.SKILL.md.disabled`。
 *   - pi 扫描技能只认 `SKILL.md`，改名即"看不见"，这是真正生效的禁用；
 *   - 不动其它文件、不动目录结构，一条 mv 就能复原，**不产生第二份状态文件**
 *     （两处状态必然不一致，这是 ADR-0021 的教训）。
 */
import { readdir, readFile, rename, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { readPreview } from "../files/file-service.js";

const SKILL_ENTRY = "SKILL.md";
const SKILL_ENTRY_DISABLED = ".SKILL.md.disabled";

type SkillSummary = {
	/** 目录名，作为唯一 id（不是 frontmatter 里的 name，那个可能重名） */
	id: string;
	name: string;
	description: string;
	enabled: boolean;
	/** 目录内相对路径（最多列 200 条，供界面展示与点开预览） */
	files: string[];
};

export function defaultSkillsDir(): string {
	return join(homedir(), ".agents", "skills");
}

/**
 * 纯函数：从 SKILL.md 的 frontmatter 里抠 name / description（不引 yaml 依赖）。
 *
 * 两种写法都要认 —— 真实技能里用折叠标量的很多（`anthropics/skills` 的 academy-guide 就是）：
 *
 *     description: 一句话
 *     description: >
 *       折成一行的一段
 *       可以有缩进的续行
 *
 * 只认折叠（`>`）与字面（`|`）两种块标量：这两种占真实用法的全部，
 * 为它们引一个 YAML 库不划算（ADR-0008）。
 */
export function parseFrontmatter(text: string): { name: string; description: string } {
	const match = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text);
	if (!match) return { name: "", description: "" };
	const body = match[1] ?? "";
	const lines = body.split(/\r?\n/);

	const read = (key: string): string => {
		const start = lines.findIndex((line) => new RegExp(`^${key}:`).test(line));
		if (start === -1) return "";
		const rawValue = (lines[start] ?? "").replace(new RegExp(`^${key}:\\s*`), "").trim();

		// 块标量：`>` 折叠成空格，`|` 保留换行；续行是后面那些「缩进或空行」的行
		const scalar = /^([>|])([+-]?)$/.exec(rawValue);
		if (scalar) {
			const collected: string[] = [];
			for (let index = start + 1; index < lines.length; index += 1) {
				const line = lines[index] ?? "";
				if (line.trim() !== "" && !/^\s/.test(line)) break; // 顶格 = 下一个键
				collected.push(line.trim());
			}
			const text = collected.join(scalar[1] === "|" ? "\n" : " ").trim();
			return text.replace(/\s+/g, " ");
		}

		// 单行：去掉包裹的引号
		return rawValue.replace(/^["']/, "").replace(/["']$/, "");
	};

	return { name: read("name"), description: read("description") };
}

/** 递归列目录里的文件（相对路径），有上限，避免某个技能塞几千个文件把界面拖死 */
async function listFiles(root: string, prefix = "", out: string[] = []): Promise<string[]> {
	if (out.length >= 200) return out;
	let entries;
	try {
		entries = await readdir(join(root, prefix), { withFileTypes: true });
	} catch {
		return out;
	}
	for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
		if (out.length >= 200) break;
		if (entry.name === "cache" || entry.name.startsWith(".")) continue;
		const rel = join(prefix, entry.name);
		if (entry.isDirectory()) await listFiles(root, rel, out);
		else out.push(rel);
	}
	return out;
}

export type SkillStore = {
	/** 这份 store 读的目录（安装也写这里：装到哪 = 看到哪） */
	dir: string;
	list: () => Promise<SkillSummary[]>;
	/** 批量启停；返回真正改变的 id 列表（已经是目标状态的跳过） */
	setEnabled: (ids: string[], enabled: boolean) => Promise<{ changed: string[]; errors: string[] }>;
	/** 读技能里的某个文件（只读预览，路径限制在该技能目录内） */
	readFile: (
		id: string,
		relPath: string,
	) => Promise<{ ok: true; text: string; binary: boolean; bytes: number } | { ok: false; error: string }>;
};

function safeId(id: string): boolean {
	// 目录名白名单：不允许穿越、不允许以点开头（那是内部文件）
	return /^[A-Za-z0-9._-]{1,80}$/.test(id) && !id.startsWith(".");
}

export function createSkillStore(options: { dir?: string } = {}): SkillStore {
	const root = options.dir ?? defaultSkillsDir();

	const resolve = (id: string): string | null => (safeId(id) ? join(root, id) : null);

	return {
		dir: root,

		async list() {
			let names: string[] = [];
			try {
				names = (await readdir(root, { withFileTypes: true }))
					.filter((entry) => entry.isDirectory())
					.map((entry) => entry.name);
			} catch {
				return [];
			}
			const skills: SkillSummary[] = [];
			for (const id of names.sort()) {
				const dir = join(root, id);
				const enabled = await stat(join(dir, SKILL_ENTRY))
					.then(() => true)
					.catch(() => false);
				const entryPath = join(dir, enabled ? SKILL_ENTRY : SKILL_ENTRY_DISABLED);
				const text = await readFile(entryPath, "utf8").catch(() => "");
				if (text === "") continue; // 既没有 SKILL.md 也没有 .disabled 的目录不是技能
				const meta = parseFrontmatter(text);
				skills.push({
					id,
					name: meta.name !== "" ? meta.name : id,
					description: meta.description,
					enabled,
					files: await listFiles(dir),
				});
			}
			return skills;
		},

		async setEnabled(ids, enabled) {
			const changed: string[] = [];
			const errors: string[] = [];
			for (const id of ids) {
				const dir = resolve(id);
				if (!dir) {
					errors.push(`非法技能 id：${id}`);
					continue;
				}
				const from = join(dir, enabled ? SKILL_ENTRY_DISABLED : SKILL_ENTRY);
				const to = join(dir, enabled ? SKILL_ENTRY : SKILL_ENTRY_DISABLED);
				const exists = await stat(from)
					.then(() => true)
					.catch(() => false);
				if (!exists) continue; // 已经是目标状态
				try {
					await rename(from, to);
					changed.push(id);
				} catch (error) {
					errors.push(`${id}：${error instanceof Error ? error.message : String(error)}`);
				}
			}
			return { changed, errors };
		},

		async readFile(id, relPath) {
			const dir = resolve(id);
			if (!dir) return { ok: false, error: "非法技能 id" };
			const result = await readPreview(dir, relPath);
			if (!result.ok) return { ok: false, error: result.error };
			return { ok: true, text: result.text, binary: result.binary, bytes: result.bytes };
		},
	};
}
