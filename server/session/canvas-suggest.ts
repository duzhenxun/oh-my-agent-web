/**
 * 「就这几步说两句」的候选指令：让模型看一眼选区，给几条**用户可能想说的话**。
 *
 * 为什么要这个：那个输入框是空的，很多人（用户原话「有时候不喜欢自己输入文字」）
 * 面对空白光标就卡住了。给几条贴着这几步的候选，点一下就能发。
 *
 * 三条纪律：
 *   - 输出只认 JSON 字符串数组；解析不出来就退回**按上下文写死的候选**（不空手而归）；
 *   - 每条 ≤ 24 字：候选是"一句话指令"，长了就变成让模型替用户写小作文；
 *   - 最多 4 条，去重。
 */
import type { CanvasNode } from "../protocol.js";

const MAX_SUGGESTIONS = 4;
const MAX_LENGTH = 24;

export const CANVAS_SUGGEST_SYSTEM = [
	"你在帮用户操作一张任务画布。用户选中了几个节点，要对着它们给 AI 助手下一句指令。",
	"请给出 4 条**用户可能想说的话**，每条不超过 24 个字，口语化，像人随手打的。",
	"要求：贴着这些节点说（比如太粗就建议拆细、顺序乱就建议重排、缺验收就建议补上）；",
	"不要客套话，不要编号，不要解释。",
	'只输出一个 JSON 字符串数组，例如 ["这两步太粗，拆细一点","合并成一步"]',
].join("\n");

/** 模型给的原始输出 → 候选列表（解析不了就返回空，由调用方兜底） */
export function parseSuggestions(raw: string | null): string[] {
	if (raw === null) return [];
	const text = raw.trim();
	// 先按 JSON 数组找；模型有时会包一层 ```json
	const start = text.indexOf("[");
	const end = text.lastIndexOf("]");
	let items: unknown[] = [];
	if (start >= 0 && end > start) {
		try {
			const parsed = JSON.parse(text.slice(start, end + 1)) as unknown;
			if (Array.isArray(parsed)) items = parsed;
		} catch {
			items = [];
		}
	}
	// 退一步：一行一条（去掉引号、编号、项目符号）
	if (items.length === 0) {
		items = text
			.split("\n")
			.map((line) => line.replace(/^[\s\-*•\d.、)）"']+|["',]+$/g, "").trim())
			.filter((line) => line !== "");
	}
	const out: string[] = [];
	for (const item of items) {
		if (typeof item !== "string") continue;
		const value = item.replace(/\s+/g, " ").trim();
		if (value === "" || value.length > MAX_LENGTH * 2) continue;
		const clipped = value.length > MAX_LENGTH ? `${value.slice(0, MAX_LENGTH)}` : value;
		if (out.includes(clipped)) continue;
		out.push(clipped);
		if (out.length >= MAX_SUGGESTIONS) break;
	}
	return out;
}

/** 提示词：把选区的现状说清楚（模型才知道"能建议什么"） */
export function buildCanvasSuggestPrompt(nodes: readonly CanvasNode[], goal: string): string {
	const lines = [goal === "" ? "画布目标：（未写）" : `画布目标：${goal}`, `用户选中了 ${nodes.length} 个节点：`];
	for (const node of nodes) {
		const detail = node.detail ? ` —— ${node.detail}` : "";
		const kind = node.kind ? `，${node.kind}` : "";
		lines.push(`- ${node.title}（${node.status}${kind}）${detail}`);
	}
	return lines.join("\n");
}

/**
 * 兜底候选：模型不可用 / 解析失败时用。
 * 按"选了几个"分两套 —— 单节点能做的事和多节点能做的事本来就不一样。
 */
export function fallbackSuggestions(count: number): string[] {
	if (count <= 1) return ["拆细一点，每步能独立做完", "补上验收标准", "这步其实不需要", "标成里程碑"];
	return ["这几步太粗，拆细一点", "合并成一步", "顺序不对，重排一下", "每步补上验收标准"];
}
