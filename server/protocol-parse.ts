/**
 * 协议的输入校验（从 protocol.ts 拆出：400 行护栏 + 职责分离）。
 * 纯函数、无副作用：只做**形状**校验；业务级规则在各自模块里。
 */
import type { ApprovalDecision, AttachmentRef, ClientRequest, ClientRequestType, SettingsView } from "./protocol.js";

// ---------------------------------------------------------------------------

const REQUEST_TYPES: ClientRequestType[] = [
	"send_message",
	"interrupt",
	"approve",
	"get_state",
	"new_chat",
	"switch_conversation",
	"set_settings",
	"set_model",
	"set_approval_mode",
	"list_providers",
	"upsert_provider",
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
		const workspace =
			isRecord(raw.payload) && nonEmptyString(raw.payload.workspace) ? raw.payload.workspace : undefined;
		return workspace ? { id, type: "new_chat", payload: { workspace } } : { id, type: "new_chat" };
	}

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
			payload: { text: String(payload.text ?? ""), ...(attachments?.length ? { attachments } : {}) },
		};
	}
	if (type === "list_providers") return { id, type: "list_providers" };

	if (type === "delete_provider" || type === "test_provider") {
		const provider = typeof payload?.provider === "string" ? payload.provider.trim() : "";
		if (provider === "") return null;
		return type === "delete_provider"
			? { id, type: "delete_provider", provider }
			: { id, type: "test_provider", provider };
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
				models: models.map((item) =>
					isRecord(item)
						? { id: String(item.id ?? ""), ...(typeof item.name === "string" ? { name: item.name } : {}) }
						: { id: "" },
				),
			},
		};
	}

	if (type === "set_approval_mode") {
		const mode = payload.mode;
		return mode === "ask" || mode === "allow" ? { id, type: "set_approval_mode", payload: { mode } } : null;
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
	if (type === "interrupt") {
		return nonEmptyString(payload.conversationId)
			? { id, type: "interrupt", payload: { conversationId: payload.conversationId } }
			: null;
	}
	return nonEmptyString(payload.requestId) && DECISIONS.includes(payload.decision as ApprovalDecision)
		? { id, type: "approve", payload: { requestId: payload.requestId, decision: payload.decision as ApprovalDecision } }
		: null;
}
