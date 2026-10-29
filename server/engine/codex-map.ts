/**
 * codex app-server 的**纯映射**（不碰网络/子进程）。
 *
 * 三件事：
 *   1. thread items → 工作台的 `UiMessage`（对话区与历史都靠它）；
 *   2. model catalog → 模型下拉的条目 + 思考档位；
 *   3. 审批请求 → 工作台的 ApprovalRequest（审批弹窗的文字与作用域）。
 *
 * 为什么单独一个文件：这些规则又多又碎（item 有 18 种），混进引擎里会很快破 400 行，
 * 也没法测。引擎只负责「收通知 → 按 threadId 分发」。
 */
import { TOOL_EXCERPT_CHARS, type UiMessage } from "../protocol.js";
import type { ApprovalRequest, EngineEvent, EngineModelInfo, EngineMessage } from "./port.js";

export type CodexItem = {
	id?: string;
	type: string;
	text?: string;
	content?: Array<{ type?: string; text?: string }> | string[];
	summary?: string[];
	command?: string | null;
	aggregatedOutput?: string | null;
	exitCode?: number | null;
	status?: string;
	changes?: Array<{ path?: string; kind?: string }>;
	server?: string;
	tool?: string;
	namespace?: string | null;
	arguments?: unknown;
	result?: unknown;
	error?: { message?: string } | null;
	path?: string;
};

export type CodexTurn = {
	id?: string;
	status?: string;
	startedAt?: number | null;
	completedAt?: number | null;
	items?: CodexItem[];
};

export type CodexModel = {
	id: string;
	model: string;
	displayName?: string;
	hidden?: boolean;
	isDefault?: boolean;
	supportedReasoningEfforts?: Array<{ reasoningEffort?: string }>;
	defaultReasoningEffort?: string;
};

const EXCERPT = TOOL_EXCERPT_CHARS;

function clip(text: string): { outputExcerpt: string; truncated: boolean } {
	if (text.length <= EXCERPT) return { outputExcerpt: text, truncated: false };
	return { outputExcerpt: text.slice(0, EXCERPT), truncated: true };
}

function textOf(content: CodexItem["content"]): string {
	if (!Array.isArray(content)) return "";
	return content
		.map((part) => (typeof part === "string" ? part : typeof part.text === "string" ? part.text : ""))
		.join("");
}

/** codex 的工具状态 → 工作台的三态 */
function toolStatus(status: string | undefined): "running" | "ok" | "failed" {
	if (status === undefined || status === "inProgress" || status === "running") return "running";
	if (status === "completed" || status === "ok") return "ok";
	return "failed";
}

/**
 * 一轮 turn 的 items → 界面消息。
 *
 * 规则：
 *   - `userMessage` 开一条用户消息；`agentMessage` 开一条助手消息；
 *   - `reasoning` / `plan` 接到当前助手消息上（折叠块）；
 *   - 工具类（commandExecution / fileChange / mcpToolCall）也接在当前助手消息上，
 *     没有助手消息就先开一条（否则工具卡会丢）。
 */
export function itemsToUiMessages(items: CodexItem[], ts: number): UiMessage[] {
	const messages: UiMessage[] = [];
	let assistant: UiMessage | null = null;

	const ensureAssistant = (): UiMessage => {
		if (assistant) return assistant;
		assistant = { id: `codex-asst-${ts}-${messages.length}`, role: "assistant", ts, blocks: [] };
		messages.push(assistant);
		return assistant;
	};

	for (const item of items) {
		const type = item.type;
		if (type === "userMessage") {
			const text = textOf(item.content);
			if (text.trim() === "") continue;
			messages.push({
				id: item.id ?? `codex-user-${ts}-${messages.length}`,
				role: "user",
				ts,
				blocks: [{ kind: "text", text }],
			});
			assistant = null;
			continue;
		}
		if (type === "agentMessage") {
			const text = item.text ?? "";
			if (text === "") continue;
			// 连续的 agentMessage（分段回复）接到同一条助手消息上
			const target = ensureAssistant();
			target.blocks = [...target.blocks, { kind: "text", text }];
			continue;
		}
		if (type === "reasoning" || type === "plan") {
			const text =
				type === "plan"
					? (item.text ?? "")
					: [
							...(item.summary ?? []),
							...(Array.isArray(item.content) ? item.content.filter((c): c is string => typeof c === "string") : []),
						].join("\n");
			if (text.trim() === "") continue;
			const target = ensureAssistant();
			target.blocks = [...target.blocks, { kind: "thinking", text }];
			continue;
		}
		if (type === "commandExecution") {
			const target = ensureAssistant();
			const output = clip(item.aggregatedOutput ?? "");
			target.blocks = [
				...target.blocks,
				{
					kind: "tool",
					toolCallId: item.id ?? `codex-exec-${ts}`,
					name: "shell",
					argsSummary: item.command ?? "",
					argsFull: item.command ?? "",
					status: toolStatus(item.status),
					outputExcerpt: output.outputExcerpt,
					truncated: output.truncated,
					...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
					startedAt: ts,
				},
			];
			continue;
		}
		if (type === "fileChange") {
			const target = ensureAssistant();
			const paths = (item.changes ?? []).map((change) => change.path ?? "").filter(Boolean);
			target.blocks = [
				...target.blocks,
				{
					kind: "tool",
					toolCallId: item.id ?? `codex-patch-${ts}`,
					name: "apply_patch",
					argsSummary: paths.length > 0 ? paths.join(", ") : "改动文件",
					status: toolStatus(item.status),
					outputExcerpt: "",
					truncated: false,
					startedAt: ts,
				},
			];
			continue;
		}
		if (type === "mcpToolCall" || type === "dynamicToolCall") {
			const target = ensureAssistant();
			const name = item.server ? `${item.server}.${item.tool ?? "tool"}` : (item.tool ?? "tool");
			const outputText = item.error?.message ?? (item.result === undefined ? "" : JSON.stringify(item.result));
			const output = clip(outputText);
			target.blocks = [
				...target.blocks,
				{
					kind: "tool",
					toolCallId: item.id ?? `codex-tool-${ts}`,
					name,
					argsSummary: item.arguments === undefined ? "" : JSON.stringify(item.arguments).slice(0, 200),
					argsFull: item.arguments === undefined ? "" : JSON.stringify(item.arguments),
					status: toolStatus(item.status),
					outputExcerpt: output.outputExcerpt,
					truncated: output.truncated,
					startedAt: ts,
				},
			];
			continue;
		}
		if (type === "imageView" || type === "imageGeneration" || type === "webSearch") {
			const target = ensureAssistant();
			const text =
				type === "webSearch"
					? "（联网搜索）"
					: type === "imageView"
						? `（查看图片：${item.path ?? ""}）`
						: "（生成图片）";
			target.blocks = [...target.blocks, { kind: "text", text }];
		}
	}
	return messages;
}

/** 一轮 turn 的 items 拍平成转录（`readTranscript` 用） */
export function itemsToTranscript(items: CodexItem[], ts: number): EngineMessage[] {
	return itemsToUiMessages(items, ts)
		.filter((message) => message.blocks.some((block) => block.kind === "text"))
		.map((message) => ({
			role: message.role,
			text: message.blocks
				.map((block) => (block.kind === "text" ? block.text : ""))
				.join("")
				.trim(),
			ts,
		}))
		.filter((message) => message.text !== "");
}

/** turn 的起始时间（秒 → 毫秒）；没有就用兜底值 */
export function turnTs(turn: CodexTurn, fallback: number): number {
	return typeof turn.startedAt === "number" ? turn.startedAt * 1000 : fallback;
}

/** 模型目录 → 模型下拉（隐藏模型不显示；id 用 model slug，切模型直接回传它） */
export function mapModels(models: CodexModel[]): EngineModelInfo[] {
	return models
		.filter((model) => model.hidden !== true)
		.map((model) => ({
			id: model.model || model.id,
			label: model.displayName && model.displayName !== model.model ? `${model.displayName}` : model.model || model.id,
			...(model.isDefault ? { current: true } : {}),
		}));
}

/** 某个模型支持的思考档位（codex 的 reasoning efforts） */
export function thinkingLevelsOf(models: CodexModel[], modelId: string | null): string[] {
	const model =
		models.find((item) => (item.model || item.id) === modelId) ?? models.find((item) => item.id === modelId);
	if (!model?.supportedReasoningEfforts) return [];
	return model.supportedReasoningEfforts
		.map((effort) => effort.reasoningEffort)
		.filter((effort): effort is string => typeof effort === "string" && effort !== "");
}

/** 命令行 → 「这类」的作用域键（与 pi 侧的 bash 规则同构，`总是允许这类` 才有意义） */
function commandScope(command: string): { scopeKey: string; scopeHint: string } {
	const first = command.trim().split(/\s+/)[0] ?? "";
	const clean = first.replace(/^.*\//, "");
	return { scopeKey: `bash|${clean}`, scopeHint: clean === "" ? command.trim().slice(0, 60) : clean };
}

/** 命令执行审批 → 工作台的审批请求 */
export function commandApprovalRequest(params: Record<string, unknown>): ApprovalRequest {
	const command = typeof params.command === "string" ? params.command : "";
	const scope = commandScope(command);
	const reason = typeof params.reason === "string" && params.reason !== "" ? params.reason : null;
	return {
		toolName: "shell",
		argsSummary: command === "" ? "（未提供命令）" : command.slice(0, 300),
		scopeKey: scope.scopeKey,
		scopeHint: scope.scopeHint,
		riskNote: reason ?? "codex 请求执行命令；是否放行由你决定",
	};
}

/** 文件改动审批 → 工作台的审批请求 */
export function fileChangeApprovalRequest(params: Record<string, unknown>): ApprovalRequest {
	const root = typeof params.grantRoot === "string" ? params.grantRoot : "";
	const reason = typeof params.reason === "string" && params.reason !== "" ? params.reason : null;
	return {
		toolName: "apply_patch",
		argsSummary: root === "" ? "改动工作区文件" : `允许写入 ${root}`,
		scopeKey: `write|${root}`,
		scopeHint: root === "" ? "工作区文件" : root,
		riskNote: reason ?? "codex 想改动工作区文件，确认后才继续",
	};
}

/** 审批决定 → codex 的 decision 字符串 */
export function approvalDecision(
	decision: "once" | "always" | "deny",
	kind: "command" | "file",
): "accept" | "acceptForSession" | "decline" | "cancel" {
	if (decision === "deny") return "decline";
	if (decision === "always") return "acceptForSession";
	return kind === "command" ? "accept" : "accept";
}

export function toolStartOf(item: CodexItem): EngineEvent | null {
	const id = item.id ?? `codex-tool-${item.type}`;
	if (item.type === "commandExecution") {
		return {
			type: "tool_start",
			toolCallId: id,
			name: "shell",
			argsSummary: item.command ?? "",
			argsFull: item.command ?? "",
		};
	}
	if (item.type === "fileChange") {
		return { type: "tool_start", toolCallId: id, name: "apply_patch", argsSummary: "改动工作区文件" };
	}
	if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
		const name = item.server ? `${item.server}.${item.tool ?? "tool"}` : (item.tool ?? "tool");
		return { type: "tool_start", toolCallId: id, name, argsSummary: "" };
	}
	return null;
}

export function toolEndOf(item: CodexItem): EngineEvent | null {
	const id = item.id ?? `codex-tool-${item.type}`;
	const ok = item.status === "completed" || item.status === "ok";
	if (item.type === "commandExecution") {
		return {
			type: "tool_end",
			toolCallId: id,
			status: ok ? "ok" : "failed",
			output: item.aggregatedOutput ?? "",
			...(typeof item.exitCode === "number" ? { exitCode: item.exitCode } : {}),
		};
	}
	if (item.type === "fileChange") {
		return { type: "tool_end", toolCallId: id, status: ok ? "ok" : "failed", output: "" };
	}
	if (item.type === "mcpToolCall" || item.type === "dynamicToolCall") {
		const output = item.error?.message ?? (item.result === undefined ? "" : JSON.stringify(item.result));
		return { type: "tool_end", toolCallId: id, status: ok ? "ok" : "failed", output };
	}
	return null;
}

/**
 * codex 的错误 → 人话。
 * 最常见的一条是**写入锁**：同一个 thread 同时被 Codex 桌面端/TUI 打开时，app-server 会拒绝
 * resume（`thread-store conflict` / `active writer`）—— 这不是 bug，是原生行为，
 * 必须让用户知道该关哪一边，而不是只看到「切换模型失败」。
 */
export function friendlyCodexError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/active writer|thread-store conflict/i.test(message)) {
		return "这个会话正被 Codex（桌面端/终端）打开着，写入锁被占用：先在那里关掉它，或新建一条会话";
	}
	if (/no rollout found/i.test(message)) return "这个会话还没有落盘（先发一条消息，或换一条有历史的会话）";
	if (/not found/i.test(message)) return "Codex 里找不到这个会话（可能已被删除或归档）";
	return message;
}
