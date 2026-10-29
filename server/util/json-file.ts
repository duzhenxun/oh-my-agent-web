/**
 * 「读-改-写一份 JSON 配置文件」的最小工具（MCP / 插件面板共用）。
 *
 * 为什么单独抽出来：这几处改的都是**用户自己的**配置（`~/.claude.json`、`opencode.json`、
 * `settings.json`），规矩完全一样，写两遍迟早会分叉：
 *   1. 读不到就当空对象（文件不存在是常态，不建空文件）；
 *   2. **坏文件不硬修**：解析失败直接报错，绝不「重写成一个干净的 JSON」；
 *   3. 写回走「临时文件 + rename」，写一半崩了也不会留下半个空文件。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export type JsonObject = Record<string, unknown>;

export function readJsonObject(file: string): { json: JsonObject; exists: boolean } | { error: string } {
	if (!existsSync(file)) return { json: {}, exists: false };
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
			return { error: `${file} 不是一个 JSON 对象` };
		}
		return { json: parsed as JsonObject, exists: true };
	} catch (error) {
		return { error: `${file} 解析失败：${error instanceof Error ? error.message : String(error)}` };
	}
}

export function writeJsonObject(file: string, json: JsonObject): void {
	mkdirSync(dirname(file), { recursive: true });
	const tmp = `${file}.oh-my-agent-web-${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(json, null, 2)}\n`, "utf8");
	renameSync(tmp, file);
}

/** 取一个子对象表（不是对象就给空表：坏结构不要连累整份视图） */
export function tableOf(json: JsonObject, table: string): Record<string, unknown> {
	const value = json[table];
	if (value === undefined || value === null) return {};
	return typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
}
