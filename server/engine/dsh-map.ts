/**
 * DSH（DeepSeek Harness）ACP 的**纯映射**（不碰网络/子进程，单测直接覆盖）。
 *
 * 三件事：
 *   1. `configOptions`（模型 / 思考档）→ 我们的模型下拉与档位；
 *   2. `session/update` 通知 → 我们的 EngineEvent；
 *   3. `session/request_permission` → 我们的审批请求 + 回包选项。
 *
 * 实测依据（dsh 0.2.0-rc.2，`dsh-acp` 的 lib/index.js）：
 *   - 模型选项的 value 是 **JSON 元组字符串**：`["deepseek-account","deepseek-flash"]`；
 *   - ACP 只推**已提交**的语义更新（没有 token 级增量）：`agent_message_chunk` / `agent_thought_chunk`
 *     每条是 assistant 消息里的一个 block；工具是 `tool_call` → `tool_call_update`；
 *   - `usage_update` 只有 `{used, size}`（上下文占用），**没有** input/output 分桶；
 *   - 权限请求只带 `{toolCall:{toolCallId}}` 两个选项：`allow-once` / `reject-once`，
 *     工具名与参数得靠前面 `tool_call` 更新自己记（见 `rememberToolCall`）。
 */
import type { ApprovalRequest, EngineEvent, EngineModelInfo } from "./port.js";

export type DshModelChoice = { value: string; name: string; description?: string; group?: string };

export type DshConfigOption = {
	id: string;
	name?: string;
	category?: string;
	type?: string;
	currentValue?: string;
	options?: Array<DshModelChoice | { group: string; name?: string; options: DshModelChoice[] }>;
};

export type DshPermissionOption = { optionId: string; name?: string; kind?: string };

export type DshPermissionRequest = {
	sessionId?: string;
	toolCall?: { toolCallId?: string; title?: string; kind?: string; rawInput?: unknown };
	options?: DshPermissionOption[];
};

/** 把 configOptions 里可能分组的选项摊平（保留 group 名，便于显示） */
export function flattenChoices(option: DshConfigOption | undefined): DshModelChoice[] {
	if (!option?.options) return [];
	const out: DshModelChoice[] = [];
	for (const entry of option.options) {
		if ("options" in entry && Array.isArray(entry.options)) {
			for (const choice of entry.options) out.push({ ...choice, group: choice.group ?? entry.group ?? entry.name });
		} else {
			out.push(entry as DshModelChoice);
		}
	}
	return out;
}

/** `["provider","model"]` → { provider, model }；解析失败给 null（不猜） */
export function parseModelValue(value: string | undefined | null): { provider: string; model: string } | null {
	if (!value) return null;
	try {
		const parsed = JSON.parse(value) as unknown;
		if (!Array.isArray(parsed) || parsed.length < 2) return null;
		const [provider, model] = parsed;
		if (typeof provider !== "string" || typeof model !== "string" || provider === "" || model === "") return null;
		return { provider, model };
	} catch {
		// 老版本可能直接给 `provider/model`
		const [provider, model] = value.split("/");
		return provider && model ? { provider, model } : null;
	}
}

/** 我们在界面上用的模型 id：`provider/model`（可读、可回填） */
export function modelIdOf(choice: DshModelChoice): string | null {
	const parsed = parseModelValue(choice.value);
	return parsed ? `${parsed.provider}/${parsed.model}` : null;
}

export function modelOptions(config: DshConfigOption[] | undefined): EngineModelInfo[] {
	const option = (config ?? []).find((entry) => entry.id === "model");
	const current = parseModelValue(option?.currentValue);
	const seen = new Set<string>();
	const models: EngineModelInfo[] = [];
	for (const choice of flattenChoices(option)) {
		const id = modelIdOf(choice);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		models.push({
			id,
			label: choice.name ?? id,
			...((current && id === `${current.provider}/${current.model}`) ? { current: true } : {}),
		});
	}
	return models;
}

export function currentModelId(config: DshConfigOption[] | undefined): string | null {
	const parsed = parseModelValue((config ?? []).find((entry) => entry.id === "model")?.currentValue);
	return parsed ? `${parsed.provider}/${parsed.model}` : null;
}

/** `provider/model` → ACP 需要的原始 value；找不到返回 null */
export function modelValueFor(config: DshConfigOption[] | undefined, modelId: string): string | null {
	const option = (config ?? []).find((entry) => entry.id === "model");
	for (const choice of flattenChoices(option)) {
		if (modelIdOf(choice) === modelId) return choice.value;
	}
	return null;
}

export function thinkingLevels(config: DshConfigOption[] | undefined): string[] {
	const option = (config ?? []).find((entry) => entry.id === "reasoning_effort");
	return flattenChoices(option)
		.map((choice) => choice.value)
		.filter((value): value is string => typeof value === "string" && value !== "");
}

export function currentThinkingLevel(config: DshConfigOption[] | undefined): string | null {
	return (config ?? []).find((entry) => entry.id === "reasoning_effort")?.currentValue ?? null;
}

/**
 * 新会话默认用哪条模型路由。
 *
 * 为什么要挑：ACP 的默认路由是 `deepseek-official`，它要 `DEEPSEEK_API_KEY`；
 * 只登录了 DeepSeek 账号的机器上第一次就报 "no API key"。所以优先选**账号路由**
 * （`deepseek-account`），其次才回落到默认。顺序可被 `AGENT_WEB_DSH_MODEL` 覆盖。
 */
export function pickDefaultModelValue(
	config: DshConfigOption[] | undefined,
	preferred?: string | null,
): string | null {
	const option = (config ?? []).find((entry) => entry.id === "model");
	const choices = flattenChoices(option);
	if (choices.length === 0) return null;
	if (preferred) {
		const hit =
			choices.find((choice) => modelIdOf(choice) === preferred) ?? choices.find((choice) => choice.value === preferred);
		if (hit) return hit.value;
	}
	const current = parseModelValue(option?.currentValue);
	// DSH 自己的默认不是官方路由（说明它配了自定义 provider / 账号）→ 尊重它，不要覆盖
	if (current && current.provider !== "deepseek-official") return null;
	// 官方路由要 DEEPSEEK_API_KEY，没配时第一次 prompt 就报 no API key：
	// 优先用用户自定义的 provider（如 nexita-deepseek），其次账号路由。
	const providerOf = (choice: DshModelChoice) => parseModelValue(choice.value)?.provider ?? "";
	const custom = choices.find((choice) => !["deepseek-official", "deepseek-account"].includes(providerOf(choice)));
	if (custom) return custom.value;
	const account = choices.find((choice) => providerOf(choice) === "deepseek-account");
	return (account ?? choices[0]).value;
}

/** ACP stopReason → 我们的回合结束原因 */
export function stopReasonToTurnEnd(reason: string | undefined): "done" | "interrupted" | "error" {
	if (reason === "cancelled") return "interrupted";
	if (reason === "refusal") return "error";
	return "done"; // end_turn / max_tokens / max_turn_requests：这轮确实结束了
}

/** 一条 `session/update` 的 update 体（形状见文件头注释） */
export type DshUpdate = {
	sessionUpdate?: string;
	messageId?: string;
	content?: { type?: string; text?: string } | Array<{ type?: string; content?: { type?: string; text?: string } }>;
	toolCallId?: string;
	title?: string;
	kind?: string;
	status?: string;
	rawInput?: unknown;
};

function textOfContent(update: DshUpdate): string {
	const content = update.content;
	if (!content) return "";
	if (Array.isArray(content)) {
		return content
			.map((item) => (item?.content?.type === "text" ? (item.content.text ?? "") : ""))
			.join("");
	}
	return content.type === "text" ? (content.text ?? "") : "";
}

/**
 * `session/update` → EngineEvent。
 * 注意：DSH 只给**已提交**的语义更新，所以这里每个 chunk 是一条完整 block 或一段文本，
 * 不是逐 token 增量 —— 界面是按段落出现的，这是 ACP 的既定行为（不是丢帧）。
 */
export function updateToEvent(update: DshUpdate): EngineEvent | null {
	switch (update.sessionUpdate) {
		case "agent_message_chunk": {
			const text = textOfContent(update);
			return text === "" ? null : { type: "text_delta", text };
		}
		case "agent_thought_chunk": {
			const text = textOfContent(update);
			return text === "" ? null : { type: "thinking_delta", text };
		}
		case "tool_call": {
			const raw = update.rawInput === undefined ? "" : JSON.stringify(update.rawInput);
			return {
				type: "tool_start",
				toolCallId: update.toolCallId ?? "dsh-tool",
				name: update.title ?? update.kind ?? "tool",
				argsSummary: raw.length > 300 ? `${raw.slice(0, 300)}…` : raw,
				// 摘要是截过的；完整那份留给「展开看全 + 复制」
				argsFull: raw,
			};
		}
		case "tool_call_update": {
			const status = update.status === "failed" ? "failed" : "ok";
			return {
				type: "tool_end",
				toolCallId: update.toolCallId ?? "dsh-tool",
				status,
				output: textOfContent(update),
			};
		}
		default:
			// usage_update 只有上下文占用（没有 input/output 分桶）、config_option_update 由引擎自己处理
			return null;
	}
}

/**
 * 权限请求 → 我们的审批请求。
 *
 * DSH 的请求体只带 `toolCallId`（没有命令/参数），所以调用方应先用记住的
 * `tool_call` 事实补全 `tool`（见 `rememberToolCall` 的用法）。
 */
export function permissionApprovalRequest(
	request: DshPermissionRequest,
	tool?: { title?: string; rawInput?: unknown },
): ApprovalRequest {
	const title = tool?.title ?? request.toolCall?.title ?? "dsh 工具调用";
	const args = tool?.rawInput === undefined ? request.toolCall?.rawInput : tool.rawInput;
	const summary = args === undefined ? (request.toolCall?.toolCallId ?? "") : JSON.stringify(args).slice(0, 300);
	return {
		toolName: title,
		argsSummary: summary,
		scopeKey: `dsh|${title}`,
		scopeHint: title,
		riskNote: "DSH 请求执行这个操作；是否放行由你决定",
	};
}

/** 我们的三态 → 权限选项 id（优先按 kind 匹配，其次按 optionId 猜） */
export function permissionOptionId(
	options: DshPermissionOption[] | undefined,
	decision: "once" | "always" | "deny",
): string {
	const list = options ?? [];
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
				list.find((option) => /reject|deny|cancel/i.test(option.optionId))?.optionId)
			: (byKind(decision === "always" ? ["allow_always", "allow_once"] : ["allow_once", "allow_always"]) ??
				list.find((option) => /allow|accept|approve/i.test(option.optionId))?.optionId);
	return picked ?? list[0]?.optionId ?? (decision === "deny" ? "reject-once" : "allow-once");
}

/**
 * DSH 的错误 → 人话。
 * 最常见两条：会话被 DSH 自己的 web/tui 占着（写句柄），以及模型路由没凭据。
 */
export function friendlyDshError(error: unknown): string {
	const message = error instanceof Error ? error.message : String(error);
	if (/active write handle|already owned/i.test(message)) {
		return "这个会话正在 DSH 自己的界面（web / tui）里打开着：先在那里关掉它，或新建一条会话";
	}
	if (/no API key/i.test(message)) {
		return "这条模型路由没有凭据：换一条（例如 deepseek-account）或在环境里配置 DEEPSEEK_API_KEY";
	}
	if (/not found|unknown session/i.test(message)) return "DSH 里找不到这个会话（可能已被删除）";
	return message;
}
