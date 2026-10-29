/**
 * Claude Code（claude-code-acp）ACP 的**纯映射**（不碰网络/子进程）。
 *
 * 三件事：
 *   1. `session/new` 的 `models` → 我们的模型下拉；
 *   2. `session/update` 通知 → 我们的 EngineEvent；
 *   3. `session/request_permission` → 我们的审批请求 + 回包选项。
 *
 * 实测依据（claude-code-acp 0.16.2 + Claude Code 2.1.301，读适配器 `dist/acp-agent.js` 的产出侧）：
 *   - `session/new` 回 `models:{availableModels:[{modelId:"default"|"opus"|"haiku"|"claude-opus-4-6", name, description}],
 *     currentModelId}`。**没有 configOptions**（与 opencode / dsh 不同），换模型走 `session/set_model`。
 *     别名（`opus` / `haiku`）与全名（`claude-opus-4-6`）会同时出现在列表里，值直接透传即可。
 *   - 正文是**增量**：`agent_message_chunk` / `agent_thought_chunk`，`content:{type:"text", text}`。
 *   - 工具：`tool_call`（`toolCallId` + `title` + `kind` + `rawInput` + `status:"pending"`，
 *     `_meta.claudeCode.toolName` 是**真工具名** Bash/Write/Edit/Read/Task…）→ 之后
 *     `tool_call_update`（`status:"completed"|"failed"` + `rawOutput`）。与 opencode 的「两段式」
 *     不同，`rawInput` 第一条就齐全，所以不需要延迟开卡片。
 *   - `TodoWrite` 不发 `tool_call`，改发 `plan`（`entries[]`）：不映射成工具卡片，直接忽略。
 *   - 权限请求带 `toolCall:{toolCallId, title, rawInput}` + 三个选项：
 *     `{optionId:"allow_always", kind:"allow_always"}` / `{optionId:"allow"}` / `{optionId:"reject"}`。
 *     `ExitPlanMode` 是另一组（`acceptEdits` / `default` / `plan`）→ 一律**按 kind 匹配**，不认 id。
 *   - `session/prompt` 只回 `{stopReason}`（**没有 usage**）：用量从会话 JSONL 里读（claude-sessions.ts）。
 */
import type { ApprovalRequest, EngineEvent, EngineModelInfo } from "./port.js";

/** 模型 id 的前缀：界面按 `provider/model` 显示，Claude 只有一家 provider */
export const CLAUDE_PROVIDER = "anthropic";

// ---------------------------------------------------------------------------
// 模型
// ---------------------------------------------------------------------------

type ClaudeModelDescriptor = { modelId?: string; name?: string; description?: string };

export type ClaudeModels = { availableModels?: ClaudeModelDescriptor[]; currentModelId?: string };

/** `session/new` / `session/resume` 的返回值（只写我们用到的那几项） */
export type ClaudeSessionResult = { sessionId?: string; models?: ClaudeModels };

/** ACP 的模型表 → 我们的模型下拉（id 统一成 `anthropic/<modelId>`，label 用适配器给的名字） */
export function modelOptions(models: ClaudeModels | undefined): EngineModelInfo[] {
	const current = models?.currentModelId;
	const out: EngineModelInfo[] = [];
	for (const model of models?.availableModels ?? []) {
		const modelId = typeof model.modelId === "string" ? model.modelId.trim() : "";
		if (modelId === "") continue;
		out.push({
			id: `${CLAUDE_PROVIDER}/${modelId}`,
			label: (model.name ?? modelId).trim(),
			...(modelId === current ? { current: true } : {}),
		});
	}
	return out;
}

export function currentModelId(models: ClaudeModels | undefined): string | null {
	const id = typeof models?.currentModelId === "string" ? models.currentModelId.trim() : "";
	return id === "" ? null : id;
}

/** `anthropic/opus` → `opus`；`opus` 也接受（AGENT_WEB_CLAUDE_MODEL 允许写裸别名） */
function parseClaudeModelId(value: string | undefined | null): string | null {
	const raw = (value ?? "").trim();
	if (raw === "") return null;
	if (!raw.startsWith(`${CLAUDE_PROVIDER}/`)) return raw;
	const rest = raw.slice(CLAUDE_PROVIDER.length + 1).trim();
	return rest === "" ? null : rest;
}

/**
 * 一个模型标识 → 发给 `session/set_model` 的 modelId。
 *
 * 只认**列表里有的**（给 null = 这个模型不存在）：和 opencode 一样，「点了就要么成功要么
 * 给出可读原因」，而不是把随便一个字符串塞给引擎再收一个 500。
 * 列表为空（还没建会话）时也不放行 —— 调用方会先 resume 拿列表。
 */
export function modelIdFor(models: ClaudeModels | undefined, wanted: string): string | null {
	const target = parseClaudeModelId(wanted);
	if (target === null) return null;
	for (const model of models?.availableModels ?? []) {
		if (model.modelId === target) return target;
	}
	return null;
}

/** 当前模型 → port 的 `{provider, model}`（取不到给 null） */
export function currentModelOf(models: ClaudeModels | undefined): { provider: string; model: string } | null {
	const id = currentModelId(models);
	return id === null ? null : { provider: CLAUDE_PROVIDER, model: id };
}

// ---------------------------------------------------------------------------
// session/update → EngineEvent
// ---------------------------------------------------------------------------

export type ClaudeUpdate = {
	sessionUpdate?: string;
	content?: unknown;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
	rawOutput?: unknown;
	entries?: unknown;
	_meta?: { claudeCode?: { toolName?: string } };
};

/** ACP 的 content 块 → 纯文本（图片块不参与正文） */
export function textOfContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((item) => textOfContent(item))
			.filter((text) => text !== "")
			.join("");
	}
	if (content !== null && typeof content === "object") {
		const block = content as { type?: unknown; text?: unknown };
		if (typeof block.text === "string" && (block.type === undefined || block.type === "text")) return block.text;
	}
	return "";
}

/** 正文 / 思考增量；其余 update（plan / available_commands / current_mode…）不产生事件 */
export function textEventOf(update: ClaudeUpdate): EngineEvent | null {
	if (update.sessionUpdate === "agent_message_chunk") {
		const text = textOfContent(update.content);
		return text === "" ? null : { type: "text_delta", text };
	}
	if (update.sessionUpdate === "agent_thought_chunk") {
		const text = textOfContent(update.content);
		return text === "" ? null : { type: "thinking_delta", text };
	}
	return null;
}

export type ToolFacts = { toolCallId: string; toolName?: string; title?: string; kind?: string; rawInput?: unknown };

/** 从 tool_call / tool_call_update 里抽出工具事实（后到的 update 更详细，合并而不是覆盖） */
export function toolFactsOf(update: ClaudeUpdate): ToolFacts | null {
	const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "";
	if (toolCallId === "") return null;
	const facts: ToolFacts = { toolCallId };
	const toolName = update._meta?.claudeCode?.toolName;
	if (typeof toolName === "string" && toolName !== "") facts.toolName = toolName;
	if (typeof update.title === "string" && update.title !== "") facts.title = update.title;
	if (typeof update.kind === "string" && update.kind !== "") facts.kind = update.kind;
	if (update.rawInput !== undefined) facts.rawInput = update.rawInput;
	return facts;
}

/** 参数里挑一句最有用的话当摘要（Bash 的命令 / Write 的路径），拿不到才退回整段 JSON */
export function summarizeToolInput(toolName: string | undefined, rawInput: unknown): string {
	const input = rawInput !== null && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : null;
	const pick = (...keys: string[]): string | null => {
		for (const key of keys) {
			const value = input?.[key];
			if (typeof value === "string" && value.trim() !== "") return value;
		}
		return null;
	};
	const name = (toolName ?? "").toLowerCase();
	if (name === "bash" || name === "shell") {
		const command = pick("command", "cmd");
		if (command) return command;
	}
	if (["read", "write", "edit", "multiedit", "notebookread", "notebookedit"].includes(name)) {
		const path = pick("file_path", "notebook_path", "path");
		if (path) return path;
	}
	if (name === "grep" || name === "glob") {
		const pattern = pick("pattern");
		if (pattern) return pattern;
	}
	if (name === "webfetch" || name === "websearch") {
		const target = pick("url", "query");
		if (target) return target;
	}
	if (name === "task") {
		const description = pick("description");
		if (description) return description;
	}
	// 认不出工具（自定义 / MCP）：把常见字段都试一遍，最后退回整段 JSON
	const generic = pick("command", "file_path", "path", "pattern", "url", "description", "prompt");
	return generic ?? safeJson(rawInput);
}

export function toolStartEvent(facts: ToolFacts): EngineEvent {
	const name = (facts.toolName ?? "").trim() || (facts.title ?? "").trim() || facts.kind || "tool";
	const summary = summarizeToolInput(facts.toolName, facts.rawInput);
	const full = facts.rawInput === undefined ? "" : safeJson(facts.rawInput);
	return {
		type: "tool_start",
		toolCallId: facts.toolCallId,
		name,
		// 摘要就是全部参数时（bash 就一句命令）不再给 argsFull，别让界面出现两份一样的
		argsSummary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
		...(hasSpareArgs(facts.rawInput, summary) ? { argsFull: full } : {}),
	};
}

/**
 * 完整参数里除了「已经当摘要的那一句」还有别的东西吗？
 *
 * 判据：超过一个键，或唯一的那个键不是字符串（嵌套对象/数组，摘要表达不了）。
 * 为什么不用「JSON 字符串 ≠ 摘要」：`{"command":"npm test"}` 永远不等于 `npm test`，
 * 那个判据会把每次 bash 都变成「有两份参数」。
 */
function hasSpareArgs(rawInput: unknown, summary: string): boolean {
	if (rawInput === null || typeof rawInput !== "object") return false;
	const keys = Object.keys(rawInput as Record<string, unknown>);
	if (keys.length === 0) return false;
	if (keys.length > 1) return true;
	const only = (rawInput as Record<string, unknown>)[keys[0] as string];
	return typeof only === "string" ? only !== summary : true;
}

/** 工具收口：只有 completed / failed 才发（pending 是过程态） */
export function isFinalToolStatus(status: string | undefined): boolean {
	return status === "completed" || status === "failed" || status === "cancelled";
}

export function toolEndEvent(update: ClaudeUpdate): EngineEvent {
	const toolCallId = typeof update.toolCallId === "string" ? update.toolCallId : "claude-tool";
	// rawOutput 是 SDK 的 tool_result.content：字符串、文本块数组、或 {stdout,stderr} 之类的对象
	const output = outputTextOf(update.rawOutput);
	return {
		type: "tool_end",
		toolCallId,
		status: update.status === "completed" ? "ok" : "failed",
		output,
	};
}

function outputTextOf(value: unknown): string {
	if (typeof value === "string") return value;
	if (Array.isArray(value)) {
		return value
			.map((item) => outputTextOf(item))
			.filter((text) => text !== "")
			.join("\n");
	}
	if (value !== null && typeof value === "object") {
		const record = value as Record<string, unknown>;
		if (typeof record.text === "string") return record.text;
		if (typeof record.content !== "undefined") return outputTextOf(record.content);
		const stdout = typeof record.stdout === "string" ? record.stdout : "";
		const stderr = typeof record.stderr === "string" ? record.stderr : "";
		if (stdout !== "" || stderr !== "") return [stdout, stderr].filter((text) => text !== "").join("\n");
		return safeJson(value);
	}
	return "";
}

function safeJson(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "";
	} catch {
		return String(value);
	}
}

// ---------------------------------------------------------------------------
// session/prompt 的结果
// ---------------------------------------------------------------------------

export type ClaudePromptResult = { stopReason?: string };

/** ACP stopReason → 我们的回合结束原因（与 dsh / opencode 同口径） */
export function stopReasonToTurnEnd(reason: string | undefined): "done" | "interrupted" | "error" {
	if (reason === "cancelled") return "interrupted";
	if (reason === "refusal") return "error";
	return "done"; // end_turn / max_tokens / max_turn_requests：这轮确实结束了
}

// ---------------------------------------------------------------------------
// 权限请求
// ---------------------------------------------------------------------------

type ClaudePermissionOption = { optionId?: string; name?: string; kind?: string };

export type ClaudePermissionRequest = {
	sessionId?: string;
	toolCall?: { toolCallId?: string; title?: string; rawInput?: unknown };
	options?: ClaudePermissionOption[];
};

/**
 * 权限请求 → 我们的审批请求。
 *
 * 请求体只有 `toolCall.title`（人话标题）与 `rawInput`，真工具名要靠 `tool_call` 那次通知
 * 缓存的 `_meta.claudeCode.toolName`（`toolFacts`）。拿不到就用标题当名字 ——
 * 审批规则按 `scopeKey` 匹配，宁可粗一点，也不要空着。
 */
export function permissionApprovalRequest(
	request: ClaudePermissionRequest,
	tool?: ToolFacts | undefined,
): ApprovalRequest {
	const toolName =
		(tool?.toolName ?? "").trim() || (tool?.title ?? request.toolCall?.title ?? "").trim() || "Claude 工具调用";
	const args = request.toolCall?.rawInput ?? tool?.rawInput;
	const summary = args === undefined ? "" : summarizeToolInput(toolName, args);
	const kind = tool?.kind ?? "";
	const riskNote =
		kind === "execute" || /bash|shell/i.test(toolName)
			? "Claude Code 请求执行这条命令；是否放行由你决定"
			: kind === "edit"
				? "Claude Code 请求修改这个文件；是否放行由你决定"
				: kind === "fetch"
					? "Claude Code 请求访问这个网络地址；是否放行由你决定"
					: "Claude Code 请求执行这个操作；是否放行由你决定";
	return {
		toolName,
		argsSummary: summary.length > 300 ? `${summary.slice(0, 300)}…` : summary,
		scopeKey: `claude|${toolName}`,
		scopeHint: toolName,
		riskNote,
	};
}

/**
 * 我们的三态 → 权限选项 id。
 *
 * 一律**按 kind 匹配**：Claude 有两组选项（普通工具 `allow_always/allow/reject`、
 * `ExitPlanMode` 的 `acceptEdits/default/plan`），写死 id 会在第二组上给出错的答案。
 */
export function permissionOptionId(
	options: ClaudePermissionOption[] | undefined,
	decision: "once" | "always" | "deny",
): string {
	const list = (options ?? []).filter(
		(option): option is { optionId: string; kind?: string } => typeof option.optionId === "string",
	);
	const byKind = (kinds: string[]): string | null => {
		for (const kind of kinds) {
			const hit = list.find((option) => option.kind === kind);
			if (hit) return hit.optionId;
		}
		return null;
	};
	const picked =
		decision === "deny"
			? (byKind(["reject_once", "reject_always"]) ??
				list.find((option) => /reject|deny|cancel|plan/i.test(option.optionId))?.optionId)
			: (byKind(decision === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) ??
				list.find((option) => /allow|accept|approve|default/i.test(option.optionId))?.optionId);
	// 兜底：宁可给第一个（Claude 的两组里第一个都是「允许」），也别让对端一直等回包
	return picked ?? list[0]?.optionId ?? (decision === "deny" ? "reject" : "allow");
}

// ---------------------------------------------------------------------------
// 错误 → 人话
// ---------------------------------------------------------------------------

export function friendlyClaudeError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/ENOENT|spawn .* ENOENT|command not found/i.test(message)) {
		return "没有找到 claude-code-acp / claude-agent-acp：先 `npm i -g @zed-industries/claude-code-acp`（或改名后的 `npm i -g @agentclientprotocol/claude-agent-acp`；Claude Code 本体也要装好并登录），或设 AGENT_WEB_CLAUDE_BIN 指向它";
	}
	if (/authRequired|authentication required|Please run \/login|Invalid API key|401|403|unauthor/i.test(message)) {
		return "Claude Code 没登录 / 凭据失效：先在终端里跑一次 `claude` 完成登录（本机凭据要单独登录），再切回来";
	}
	if (/model.*(not found|invalid|unknown)|unknown model/i.test(message)) {
		return "Claude Code 里没有这个模型：换一个（列表来自 claude 自己的可用模型）";
	}
	if (/Session not found|session.*not found/i.test(message)) {
		return "Claude Code 里找不到这条会话（可能已被清理）：新建一条即可";
	}
	return message;
}
