/**
 * 技能目录（P8）：列目录 + 批量启停 + 读文件。
 * 启停的语义是「把 SKILL.md 改名」——这里要盯住它**可逆**且**不动其它文件**。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createSkillStore,
	parseFrontmatter,
	SKILL_ENTRY,
	SKILL_ENTRY_DISABLED,
} from "../../server/skills/skill-store.js";

let dir = "";

function writeSkill(id: string, name: string, description: string, extra: Record<string, string> = {}) {
	const skillDir = join(dir, id);
	mkdirSync(join(skillDir, "scripts"), { recursive: true });
	writeFileSync(join(skillDir, SKILL_ENTRY), `---\nname: ${name}\ndescription: ${description}\n---\n\n# ${name}\n`);
	writeFileSync(join(skillDir, "scripts", "run.sh"), "echo hi\n");
	for (const [path, content] of Object.entries(extra)) writeFileSync(join(skillDir, path), content);
}

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-skills-"));
	writeSkill("weather", "weather-forecast", "查天气");
	writeSkill("wiki", "depp-wiki", "[IKACT] 知识库");
});
afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("parseFrontmatter", () => {
	it("取 name / description，去掉引号", () => {
		expect(parseFrontmatter('---\nname: a\ndescription: "带引号"\n---\n')).toEqual({
			name: "a",
			description: "带引号",
		});
	});

	it("没有 frontmatter 时返回空串（不抛）", () => {
		expect(parseFrontmatter("# 标题")).toEqual({ name: "", description: "" });
	});
});

describe("list", () => {
	it("列出技能、文件清单与启停状态", async () => {
		const skills = await createSkillStore({ dir }).list();
		expect(skills.map((skill) => skill.id)).toEqual(["weather", "wiki"]);
		expect(skills[0]).toMatchObject({ name: "weather-forecast", description: "查天气", enabled: true });
		expect(skills[0]?.files).toContain("scripts/run.sh");
	});

	it("不是技能的目录被跳过", async () => {
		mkdirSync(join(dir, "empty-dir"));
		const skills = await createSkillStore({ dir }).list();
		expect(skills.map((skill) => skill.id)).toEqual(["weather", "wiki"]);
	});
});

describe("setEnabled（改名而非删除）", () => {
	it("禁用只把 SKILL.md 改名，其它文件原样保留", async () => {
		const store = createSkillStore({ dir });
		const result = await store.setEnabled(["weather"], false);
		expect(result.changed).toEqual(["weather"]);
		expect(existsSync(join(dir, "weather", SKILL_ENTRY))).toBe(false);
		expect(readFileSync(join(dir, "weather", SKILL_ENTRY_DISABLED), "utf8")).toContain("weather-forecast");
		expect(readFileSync(join(dir, "weather", "scripts", "run.sh"), "utf8")).toBe("echo hi\n");
		expect((await store.list()).find((skill) => skill.id === "weather")?.enabled).toBe(false);
	});

	it("再启用一次就复原（可逆）", async () => {
		const store = createSkillStore({ dir });
		await store.setEnabled(["weather"], false);
		const back = await store.setEnabled(["weather"], true);
		expect(back.changed).toEqual(["weather"]);
		expect((await store.list()).find((skill) => skill.id === "weather")?.enabled).toBe(true);
	});

	it("批量：已经是目标状态的跳过，不报错", async () => {
		const store = createSkillStore({ dir });
		const result = await store.setEnabled(["weather", "wiki"], false);
		expect(result.changed.sort()).toEqual(["weather", "wiki"]);
		const again = await store.setEnabled(["weather"], false);
		expect(again.changed).toEqual([]);
	});

	it("非法 id（穿越 / 点开头）被拒", async () => {
		const store = createSkillStore({ dir });
		const result = await store.setEnabled(["../etc", ".hidden"], false);
		expect(result.changed).toEqual([]);
		expect(result.errors.length).toBe(2);
	});
});

describe("readFile", () => {
	it("能读技能里的脚本", async () => {
		const result = await createSkillStore({ dir }).readFile("weather", "scripts/run.sh");
		expect(result.ok).toBe(true);
		if (!result.ok) return;
		expect(result.text).toBe("echo hi\n");
	});

	it("越界路径被拒", async () => {
		expect((await createSkillStore({ dir }).readFile("weather", "../../etc/passwd")).ok).toBe(false);
	});
});
