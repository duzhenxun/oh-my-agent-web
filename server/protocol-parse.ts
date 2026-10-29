/**
 * 协议的输入校验（从 protocol.ts 拆出：400 行护栏 + 职责分离）。
 * 纯函数、无副作用：只做**形状**校验；业务级规则在各自模块里。
 */
import type { ApprovalDecision, AttachmentRef, ClientRequest, ClientRequestType, SettingsView } from "./protocol.js";
import { normalizeWorkspacePath } from "./util/paths.js";

// ---------------------------------------------------------------------------

const REQUEST_TYPES: ClientRequestType[] = [
	"set_engine",
	"refresh_actions",
	"send_message",
	"interrupt",
	"rename_session",
	"suggest_title",
	"approve",
	"get_state",
	"new_chat",
	"persist_conversation",
	"close_ephemeral",
	"fork_session",
	"switch_conversation",
	"move_session",
	"set_settings",
	"set_model",
	"set_approval_mode",
	"list_providers",
	"upsert_provider",
	"delete_provider",
	"test_provider",
	"set_thinking_level",
	"update_model",
	"remove_model",
	"cancel_queued",
	"set_enabled_models",
	"save_subagent_profile",
	"delete_subagent_profile",
	"set_subagent_settings",
	"interrupt_subagent",
];
const DECISIONS: ApprovalDecision[] = ["once", "always", "deny"];

function isAttachmentRef(value: unknown): value is AttachmentRef {
	if (!isRecord(value)) return false;
	const { id, kind, name, mime, bytes } = value;
	return (
		nonEmptyString(id) &&
		(kind === "image" || kind === "file") &&
		typeof name === "string" &&
		typeof mime === "string" &&
		typeof bytes === "number"
	);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function nonEmptyString(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

/**
 * 解析并校验一条上行请求。返回 null 表示「不是合法请求」，
 * 调用方负责回 `protocol.unknown_type` / `protocol.bad_payload`。
 */
export function parseClientRequest(raw: unknown): ClientRequest | null {
	if (!isRecord(raw)) return null;
	const { id, type } = raw;
	if (!nonEmptyString(id) || !nonEmptyString(type)) return null;
	if (!REQUEST_TYPES.includes(type as ClientRequestType)) return null;

	if (type === "get_state") return { id, type: "get_state" };
	if (type === "new_chat") {
		const payload = isRecord(raw.payload) ? raw.payload : null;
		// workspace 必须在这个入口就归一化（见 normalizeWorkspacePath 的注释：尾斜杠会变成两个项目）
		const workspace =
			payload && nonEmptyString(payload.workspace) ? normalizeWorkspacePath(payload.workspace) : undefined;
		// 只认显式 `true`：临时会话是个「不能默认开」的模式（消息不落盘）
		const ephemeral = payload?.ephemeral === true;
		const next: { workspace?: string; ephemeral?: boolean } = {
			...(workspace ? { workspace } : {}),
			...(ephemeral ? { ephemeral } : {}),
		};
		return Object.keys(next).length > 0 ? { id, type: "new_chat", payload: next } : { id, type: "new_chat" };
	}

	if (type === "persist_conversation") {
		const conversationId =
			isRecord(raw.payload) && nonEmptyString(raw.payload.conversationId) ? raw.payload.conversationId : "";
		return conversationId === "" ? null : { id, type: "persist_conversation", payload: { conversationId } };
	}

	if (type === "close_ephemeral") {
		const conversationId =
			isRecord(raw.payload) && nonEmptyString(raw.payload.conversationId) ? raw.payload.conversationId : "";
		return conversationId === "" ? null : { id, type: "close_ephemeral", payload: { conversationId } };
	}

	if (type === "fork_session") {
		if (!isRecord(raw.payload)) return null;
		const { conversationId, messageId } = raw.payload;
		if (!nonEmptyString(conversationId) || !nonEmptyString(messageId)) return null;
		return { id, type: "fork_session", payload: { conversationId, messageId } };
	}

	if (type === "refresh_actions") {
		const payload = isRecord(raw.payload) ? raw.payload : undefined;
		const conversationId = payload && nonEmptyString(payload.conversationId) ? payload.conversationId : undefined;
		const rawCount = payload?.count;
		const count =
			typeof rawCount === "number" && Number.isInteger(rawCount) && rawCount >= 1 && rawCount <= 5
				? rawCount
				: undefined;
		return {
			id,
			type: "refresh_actions",
			...(conversationId || count
				? { payload: { ...(conversationId ? { conversationId } : {}), ...(count ? { count } : {}) } }
				: {}),
		};
	}
	// 这两个请求的 provider 在**顶层**（老的形状），也容忍放进 payload 里
	if (type === "delete_provider" || type === "test_provider") {
		const source = isRecord(raw.payload) ? raw.payload.provider : undefined;
		const rawProvider = typeof raw.provider === "string" ? raw.provider : source;
		const provider = typeof rawProvider === "string" ? rawProvider.trim() : "";
		if (provider === "") return null;
		return type === "delete_provider"
			? { id, type: "delete_provider", provider }
			: { id, type: "test_provider", provider };
	}

	// list_providers 不需要 payload（前端 `requestProviders()` 就是 {id, type}）。
	// 这个早返回必须在下面的「payload 必须是对象」之前，否则每次刷新 provider 列表都会被判 bad_payload。
	if (type === "list_providers") return { id, type: "list_providers" };

	const payload = raw.payload;
	if (!isRecord(payload)) return null;

	if (type === "send_message") {
		// 附件只校验形状（id/kind/name/mime/bytes）：真正的文件校验在服务端读回时做
		const attachments = Array.isArray(payload.attachments)
			? payload.attachments.filter(isAttachmentRef).slice(0, 5)
			: undefined;
		if (!nonEmptyString(payload.text) && !attachments?.length) return null;
		return {
			id,
			type: "send_message",
			payload: {
				text: String(payload.text ?? ""),
				...(payload.mode === "queue" || payload.mode === "steer" ? { mode: payload.mode } : {}),
				...(attachments?.length ? { attachments } : {}),
			},
		};
	}

	if (type === "upsert_provider") {
		// 细节校验在 providers/validate.ts（这里只做形状校验，避免协议层重复实现业务规则）
		if (!isRecord(payload)) return null;
		const models = Array.isArray(payload.models) ? payload.models : null;
		if (models === null) return null;
		return {
			id,
			type: "upsert_provider",
			payload: {
				provider: String(payload.provider ?? ""),
				baseUrl: String(payload.baseUrl ?? ""),
				...(typeof payload.api === "string" ? { api: payload.api } : {}),
				...(typeof payload.apiKey === "string" ? { apiKey: payload.apiKey } : {}),
				...(typeof payload.previousProvider === "string" && payload.previousProvider.trim() !== ""
					? { previousProvider: payload.previousProvider.trim() }
					: {}),
				...(isRecord(payload.headers)
					? {
							headers: Object.fromEntries(
								Object.entries(payload.headers).filter(([, value]) => typeof value === "string"),
							) as Record<string, string>,
						}
					: {}),
				models: models.map((item) =>
					isRecord(item)
						? { id: String(item.id ?? ""), ...(typeof item.name === "string" ? { name: item.name } : {}) }
						: { id: "" },
				),
			},
		};
	}

	if (type === "update_model") {
		if (!isRecord(payload)) return null;
		const provider = typeof payload.provider === "string" ? payload.provider.trim() : "";
		const model = isRecord(payload.model) ? payload.model : null;
		if (provider === "" || model === null) return null;
		return { id, type: "update_model", payload: { provider, model } };
	}

	if (type === "remove_model") {
		const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
		const modelId = typeof payload?.modelId === "string" ? payload.modelId.trim() : "";
		return provider === "" || modelId === "" ? null : { id, type: "remove_model", payload: { provider, modelId } };
	}

	if (type === "set_enabled_models") {
		const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
		if (provider === "" || typeof payload?.enabled !== "boolean") return null;
		const modelId =
			typeof payload?.modelId === "string" && payload.modelId.trim() !== "" ? payload.modelId.trim() : undefined;
		return {
			id,
			type: "set_enabled_models",
			payload: { provider, enabled: payload.enabled, ...(modelId ? { modelId } : {}) },
		};
	}

	if (type === "cancel_queued") {
		const queueId = typeof payload?.queueId === "string" ? payload.queueId.trim() : "";
		return queueId === "" ? null : { id, type: "cancel_queued", payload: { queueId } };
	}

	if (type === "set_thinking_level") {
		const level = typeof payload?.level === "string" ? payload.level.trim() : "";
		return level === "" ? null : { id, type: "set_thinking_level", payload: { level } };
	}

	if (type === "set_approval_mode") {
		const mode = payload.mode;
		if (mode !== "ask" && mode !== "allow") return null;
		// 会话 id 可省略（老客户端）：给了就必须是字符串，别的形状当非法请求
		const conversationId = payload.conversationId;
		if (conversationId !== undefined && !nonEmptyString(conversationId)) return null;
		return {
			id,
			type: "set_approval_mode",
			payload: typeof conversationId === "string" ? { mode, conversationId: conversationId.trim() } : { mode },
		};
	}

	if (type === "set_engine") {
		// 引擎名只做形状校验；「是不是注册过的引擎」由目录判断（未知名字要回一条可读错误）
		return nonEmptyString(payload.engine) ? { id, type: "set_engine", payload: { engine: payload.engine } } : null;
	}
	if (type === "set_model") {
		return nonEmptyString(payload.modelId) ? { id, type: "set_model", payload: { modelId: payload.modelId } } : null;
	}
	if (type === "set_settings") {
		// 结构有意放宽：真正的归一化在服务端 settings 模块（超长/重复/条数都在那里收敛）
		return { id, type: "set_settings", payload: payload as Partial<SettingsView> };
	}
	if (type === "switch_conversation") {
		return nonEmptyString(payload.conversationId)
			? { id, type: "switch_conversation", payload: { conversationId: payload.conversationId } }
			: null;
	}
	if (type === "move_session") {
		const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
		// 同理：搬家目标也要归一化，否则搬完新项目里会多出一个「同名不同 key」的组
		const workspace = typeof payload.workspace === "string" ? normalizeWorkspacePath(payload.workspace) : "";
		return conversationId !== "" && workspace !== ""
			? { id, type: "move_session", payload: { conversationId, workspace } }
			: null;
	}
	if (type === "rename_session") {
		const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
		const title = typeof payload.title === "string" ? payload.title.replace(/\s+/g, " ").trim().slice(0, 60) : "";
		return conversationId === "" ? null : { id, type: "rename_session", payload: { conversationId, title } };
	}

	/**
	 * AI 起名：只接受一个会话 id（标题由服务端生成，客户端不能传）。
	 * 跟 `rename_session` 同一个校验风格 —— 空 id 直接判非法。
	 */
	if (type === "suggest_title") {
		const conversationId = typeof payload.conversationId === "string" ? payload.conversationId.trim() : "";
		return conversationId === "" ? null : { id, type: "suggest_title", payload: { conversationId } };
	}

	if (type === "delete_subagent_profile") {
		const profileId = typeof payload?.profileId === "string" ? payload.profileId.trim() : "";
		return profileId === "" ? null : { id, type: "delete_subagent_profile", payload: { profileId } };
	}

	if (type === "interrupt_subagent") {
		const runId = typeof payload?.runId === "string" ? payload.runId.trim() : "";
		return runId === "" ? null : { id, type: "interrupt_subagent", payload: { runId } };
	}

	if (type === "set_subagent_settings") {
		const enabled = typeof payload?.enabled === "boolean" ? payload.enabled : undefined;
		const rawConcurrency = payload?.concurrency;
		const concurrency =
			typeof rawConcurrency === "number" && Number.isFinite(rawConcurrency)
				? Math.min(12, Math.max(1, Math.round(rawConcurrency)))
				: undefined;
		if (enabled === undefined && concurrency === undefined) return null;
		return {
			id,
			type: "set_subagent_settings",
			payload: { ...(enabled === undefined ? {} : { enabled }), ...(concurrency === undefined ? {} : { concurrency }) },
		};
	}

	if (type === "save_subagent_profile") {
		// 只做形状校验：id 的合法性与「内置不能删」这些业务规则在 profile-store 里
		const profile = isRecord(payload?.profile) ? payload.profile : null;
		if (profile === null) return null;
		const profileId = typeof profile.id === "string" ? profile.id.trim() : "";
		if (profileId === "") return null;
		const tools = Array.isArray(profile.tools)
			? profile.tools.filter((tool): tool is string => typeof tool === "string")
			: [];
		const maxTurns =
			typeof profile.maxTurns === "number" && profile.maxTurns > 0 ? Math.round(profile.maxTurns) : undefined;
		return {
			id,
			type: "save_subagent_profile",
			payload: {
				profile: {
					id: profileId,
					label: typeof profile.label === "string" ? profile.label : "",
					description: typeof profile.description === "string" ? profile.description : "",
					systemPrompt: typeof profile.systemPrompt === "string" ? profile.systemPrompt : "",
					tools,
					...(typeof profile.model === "string" && profile.model.trim() !== "" ? { model: profile.model.trim() } : {}),
					...(typeof profile.thinking === "string" && profile.thinking.trim() !== ""
						? { thinking: profile.thinking.trim() }
						: {}),
					...(maxTurns === undefined ? {} : { maxTurns }),
					enabled: profile.enabled !== false,
					builtin: profile.builtin === true,
				},
			},
		};
	}

	if (type === "interrupt") {
		return nonEmptyString(payload.conversationId)
			? { id, type: "interrupt", payload: { conversationId: payload.conversationId } }
			: null;
	}
	return nonEmptyString(payload.requestId) && DECISIONS.includes(payload.decision as ApprovalDecision)
		? { id, type: "approve", payload: { requestId: payload.requestId, decision: payload.decision as ApprovalDecision } }
		: null;
}
