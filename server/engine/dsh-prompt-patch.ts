/**
 * 把「下一步建议」的写法带进 dsh（ADR-0022 的 dsh 版）。
 *
 * 为什么只能走 patch 文件：ACP 是**唯一**入口，而它的 `session/new` 只有
 * `cwd / additionalDirectories / mcpServers / _meta`（schema 实测），没有系统提示字段；
 * dsh 的系统提示由插件栈里的 `@deepseek-ai/dsh-system-prompt` 组装，其中
 * `personaSuffix` 排在系统提示末尾 —— 正好是这段说明该待的位置。
 *
 * 两个必须写清的约束：
 *   1. patch 的 `config` 是**整块替换**（不是深合并）：只写 `personaSuffix` 会把 acp 模板
 *      原本的 `personaPrefix` 冲掉（实测 dump 里会整个消失）。所以两句 persona 都带上，
 *      取值照抄 `@deepseek-ai/dsh-acp-app` 的默认值；dsh 改这两句默认值时这里要跟着改。
 *   2. 它是**进程级**的：dsh 子进程启动时才 compose 配置栈，所以改完「想想」条数要
 *      重启工作台（引擎）才生效 —— 不像 pi / codex 那样每条新会话现读。
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

/** `@deepseek-ai/dsh-acp-app` 给 acp profile 的默认 persona（照抄，别改措辞） */
const PERSONA_PREFIX = "You are a coding agent powered by the {{model}} model.";
const PERSONA_SUFFIX = "Your working directory is {{cwd}}.";

/** YAML 块标量的缩进：`personaSuffix: |` 下的内容比 key 深两级 */
function indentBlock(text: string): string {
	return text
		.split("\n")
		.map((line) => (line === "" ? "" : `      ${line}`))
		.join("\n");
}

/** 纯函数：生成 patch 文件内容（喂给 `dsh --patch <file>`） */
export function dshSuggestionPatch(guidance: string): string {
	return [
		"# 由 oh-my-agent-web 生成（不要手改）：给 dsh 的 system prompt 追加「下一步建议」写法。",
		"# 改条数请改设置里的「想想」，然后重启工作台 —— dsh 的配置栈是进程启动时 compose 的。",
		"- id: system-prompt",
		"  config:",
		"    personaPrefix: |",
		indentBlock(PERSONA_PREFIX),
		"    personaSuffix: |",
		indentBlock(`${PERSONA_SUFFIX}\n\n${guidance}`),
		"",
	].join("\n");
}

/** 写到一个临时目录里（不污染用户的 `dsh-patches` 目录），返回 patch 文件路径 */
export function writeDshSuggestionPatch(dir: string, guidance: string): string {
	mkdirSync(dir, { recursive: true });
	const file = join(dir, "dsh-suggestion-patch.yml");
	writeFileSync(file, dshSuggestionPatch(guidance), "utf8");
	return file;
}
