/**
 * 客户端请求分发（从 index.ts 抽出来：400 行护栏）。
 *
 * 只做「解析 → 分发 → 回包」；真正的活儿都在 runtime / provider 接线里。
 * 单源：请求形状校验在 protocol-parse.ts（ADR-0002 纪律①）。
 */
import type { WebSocket } from "ws";
import { parseClientRequest, type ProtocolError, type Snapshot } from "../protocol.js";
import type { Logger } from "../util/log.js";
import type { Runtime } from "../session/runtime-types.js";

export type HandleDeps = {
	runtime: Runtime;
	/** 哪个客户端发的（ADR-0033：会话视图按它区分） */
	clientId?: string;
	reply: (socket: WebSocket, id: string, result: { ok: true } | { ok: false; error: ProtocolError }) => void;
	sender: { pushSnapshot: (snapshot: Snapshot) => void; flush: (now: number) => void };
	logger: Logger;
	runProviderRequest: (
		request: { type: string } & Record<string, unknown>,
		reply: (result: unknown) => void,
	) => Promise<void>;
};

export async function handleMessage(socket: WebSocket, raw: string, deps: HandleDeps): Promise<void> {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		deps.logger.warn("收到非法 JSON，已忽略");
		return;
	}

	const request = parseClientRequest(parsed);
	if (!request) {
		const id = typeof (parsed as { id?: unknown })?.id === "string" ? (parsed as { id: string }).id : "unknown";
		const type = (parsed as { type?: unknown })?.type;
		const error: ProtocolError =
			typeof type === "string"
				? { code: "protocol.bad_payload", message: `请求 ${type} 的载荷不合法` }
				: { code: "protocol.unknown_type", message: "无法识别的请求" };
		deps.logger.warn("拒绝非法请求", { id, type, code: error.code });
		deps.reply(socket, id, { ok: false, error });
		return;
	}

	try {
		switch (request.type) {
			case "send_message": {
				deps.reply(
					socket,
					request.id,
					await deps.runtime.sendMessage(request.payload.text, request.payload.attachments, request.payload.mode),
				);
				return;
			}
			case "interrupt":
				deps.reply(socket, request.id, await deps.runtime.interrupt());
				return;
			case "approve":
				deps.reply(socket, request.id, deps.runtime.approve(request.payload.requestId, request.payload.decision));
				return;
			case "new_chat":
				deps.reply(socket, request.id, await deps.runtime.newConversation(request.payload?.workspace));
				return;
			case "switch_conversation":
				deps.reply(
					socket,
					request.id,
					await deps.runtime.switchConversation(request.payload.conversationId, deps.clientId),
				);
				return;
			case "list_providers":
			case "upsert_provider":
			case "delete_provider":
			case "test_provider":
			case "update_model":
			case "remove_model":
			case "set_enabled_models":
				await deps.runProviderRequest(request, (result) => deps.reply(socket, request.id, result as never));
				return;
			case "set_approval_mode": {
				deps.reply(socket, request.id, deps.runtime.setApprovalMode(request.payload.mode));
				return;
			}
			case "cancel_queued":
				deps.reply(socket, request.id, deps.runtime.cancelQueued(request.payload.queueId));
				return;
			case "set_thinking_level":
				deps.reply(socket, request.id, await deps.runtime.setThinkingLevel(request.payload.level));
				return;
			case "set_model": {
				deps.reply(socket, request.id, await deps.runtime.setModel(request.payload.modelId));
				return;
			}
			case "set_settings": {
				deps.reply(socket, request.id, await deps.runtime.applySettings(request.payload));
				return;
			}
			case "get_state": {
				// 重连/刷新后的第一件事：拉一份权威快照（ADR-0004 §3）；顺便刷一次 pi 会话列表（带 10s 下限）
				await deps.runtime.refreshPiSessions();
				await deps.runtime.refreshProviders();
				deps.sender.pushSnapshot(deps.runtime.snapshot());
				deps.sender.flush(Date.now());
				deps.reply(socket, request.id, { ok: true });
				return;
			}
		}
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		deps.logger.error("处理请求失败", { type: request.type, message });
		deps.reply(socket, request.id, { ok: false, error: { code: "protocol.handler_failed", message } });
	}
}
