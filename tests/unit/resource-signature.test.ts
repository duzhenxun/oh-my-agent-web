/**
 * 「资源指纹」（技能 / MCP / AGENTS.md 变了没有）。
 *
 * 锁的是这套判断的**边界**：关了技能、加了 MCP、改了 AGENTS.md 必须算「变了」，
 * 什么都没动必须算「没变」（没变才不会每轮都去重连 MCP）。
 */
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { resourceSignature } from "../../server/engine/resource-signature.ts";

const root = mkdtempSync(join(tmpdir(), "aw-signature-"));
after(() => rmSync(root, { recursive: true, force: true }));

/** 造一套「技能目录 + 配置」的现场 */
function scaffold(name: string) {
	const dir = join(root, name);
	const skills = join(dir, "skills");
	mkdirSync(join(skills, "wiki-skill"), { recursive: true });
	writeFileSync(join(skills, "wiki-skill", "SKILL.md"), "---\nname: wiki\n---\nbody\n");
	writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{}}\n');
	writeFileSync(join(dir, "AGENTS.md"), "# 规则\n");
	return {
		dir,
		watch: [{ path: join(dir, "AGENTS.md") }, { path: join(dir, "mcp.json") }, { path: skills, depth: 2 }],
	};
}

describe("resourceSignature", () => {
	it("什么都没动就是同一个指纹（不会每轮都去重载）", () => {
		const { watch } = scaffold("same");
		assert.equal(resourceSignature(watch), resourceSignature(watch));
	});

	it("关掉技能（SKILL.md 改名成 .disabled）= 变了", () => {
		const { watch } = scaffold("skill-toggle");
		const skillDir = join(root, "skill-toggle", "skills", "wiki-skill");
		const before = resourceSignature(watch);
		renameSync(join(skillDir, "SKILL.md"), join(skillDir, ".SKILL.md.disabled"));
		assert.notEqual(resourceSignature(watch), before);
	});

	it("加 / 删 MCP 服务器（mcp.json 改一行）= 变了", () => {
		const { dir, watch } = scaffold("mcp");
		const before = resourceSignature(watch);
		writeFileSync(join(dir, "mcp.json"), '{"mcpServers":{"docs":{"command":"node"}}}\n');
		assert.notEqual(resourceSignature(watch), before);
	});

	it("AGENTS.md 改一行 = 变了", () => {
		const { dir, watch } = scaffold("agents");
		const before = resourceSignature(watch);
		writeFileSync(join(dir, "AGENTS.md"), "# 规则\n- 新加的一条\n");
		assert.notEqual(resourceSignature(watch), before);
	});

	it("路径还不存在也稳定；出现之后算变了（会话先建、MCP 后配）", () => {
		const dir = join(root, "later");
		mkdirSync(dir, { recursive: true });
		const watch = [{ path: join(dir, "mcp.json") }];
		const missing = resourceSignature(watch);
		assert.equal(resourceSignature(watch), missing);
		writeFileSync(join(dir, "mcp.json"), "{}\n");
		assert.notEqual(resourceSignature(watch), missing);
	});

	it("路径之外的输入（「想想」条数这类）也算在指纹里", () => {
		const { watch } = scaffold("extra");
		assert.notEqual(resourceSignature(watch, ["think:3"]), resourceSignature(watch, ["think:5"]));
	});
});
