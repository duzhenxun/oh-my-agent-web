/**
 * 客户端请求分发（从 index.ts 抽出来：400 行护栏）。
 *
 * 只做「解析 → 分发 → 回包」；真正的活儿都在 runtime / provider 接线里。
 * 单源：请求形状校验在 protocol-parse.ts（ADR-0002 纪律①）。
 */
import { parseClientRequest } from "../protocol-parse.js";
import type { ProtocolError, Snapshot } from "../protocol.js";
import type { Logger } from "../util/log.js";
import type { Runtime } from "../session/runtime-types.js";

/**
 * 能回包的最小客户端通道。
 *
 * 以前这里直接写 `WebSocket`，但 WS 传输层已经整个移除（客户端是纯 HTTP/SSE，
 * 见 `web/src/ws.ts` 文件头）—— 现在唯一的实现是 `http/live-routes.ts` 里那个
 * 「把回包塞进当前响应帧」的 shim。所以只声明真正用到的一个方法。
 */
export type ClientSink = { send: (payload: string) => void };

type HandleDeps = {
	runtime: Runtime;
	/** 哪个客户端发的（ADR-0033：会话视图按它区分） */
	clientId?: string;
	reply: (socket: ClientSink, id: string, result: { ok: true } | { ok: false; error: ProtocolError }) => void;
	sender: { pushSnapshot: (snapshot: Snapshot) => void; flush: (now: number) => void };
	logger: Logger;
	runProviderRequest: (
		request: { type: string } & Record<string, unknown>,
		reply: (result: unknown) => void,
	) => Promise<void>;
};

export async function handleMessage(socket: ClientSink, raw: string, deps: HandleDeps): Promise<void> {
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
					await deps.runtime.sendMessage(
						request.payload.text,
						request.payload.attachments,
						request.payload.mode,
						undefined,
						deps.clientId,
					),
				);
				return;
			}
			case "interrupt":
				deps.reply(socket, request.id, await deps.runtime.interrupt(request.payload.conversationId));
				return;
			case "refresh_actions":
				deps.reply(
					socket,
					request.id,
					await deps.runtime.refreshActions(request.payload?.conversationId, request.payload?.count),
				);
				return;
			case "set_engine":
				// 零重启切引擎：项目 / 模型 / 能力都跟着新引擎走（engine-switch.ts）
				deps.reply(socket, request.id, await deps.runtime.setEngine(request.payload.engine));
				return;
			case "approve":
				deps.reply(socket, request.id, deps.runtime.approve(request.payload.requestId, request.payload.decision));
				return;
			case "new_chat": {
				// 临时对话（pi 的 `--no-session`）只在显式要的时候开：不传就是普通会话
				const seed = request.payload?.ephemeral ? { ephemeral: true } : undefined;
				deps.reply(
					socket,
					request.id,
					await deps.runtime.newConversation(request.payload?.workspace, deps.clientId, seed),
				);
				return;
			}
			case "persist_conversation":
				deps.reply(socket, request.id, await deps.runtime.persistConversation(request.payload.conversationId));
				return;
			case "close_ephemeral":
				deps.reply(socket, request.id, deps.runtime.closeEphemeral(request.payload.conversationId));
				return;
			case "fork_session":
				deps.reply(
					socket,
					request.id,
					await deps.runtime.forkSession(request.payload.conversationId, request.payload.messageId, deps.clientId),
				);
				return;
			case "rename_session":
				deps.reply(
					socket,
					request.id,
					await deps.runtime.renameSession(request.payload.conversationId, request.payload.title),
				);
				return;
			case "suggest_title":
				// AI 起名：一次问答 + 改名都在服务端跑完，回包带最终标题（界面拿去做提示）
				deps.reply(socket, request.id, await deps.runtime.suggestSessionTitle(request.payload.conversationId));
				return;
			case "move_session":
				deps.reply(
					socket,
					request.id,
					await deps.runtime.moveSession(request.payload.conversationId, request.payload.workspace),
				);
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
				deps.reply(
					socket,
					request.id,
					deps.runtime.setApprovalMode(request.payload.mode, request.payload.conversationId ?? null),
				);
				return;
			}
			case "cancel_queued":
				deps.reply(socket, request.id, deps.runtime.cancelQueued(request.payload.queueId));
				return;
			case "set_thinking_level":
				deps.reply(socket, request.id, await deps.runtime.setThinkingLevel(request.payload.level));
				return;
			case "interrupt_subagent":
				deps.reply(socket, request.id, await deps.runtime.interruptSubagent(request.payload.runId));
				return;
			case "save_subagent_profile":
				deps.reply(socket, request.id, await deps.runtime.saveSubagentProfile(request.payload.profile));
				return;
			case "delete_subagent_profile":
				deps.reply(socket, request.id, await deps.runtime.deleteSubagentProfile(request.payload.profileId));
				return;
			case "set_subagent_settings":
				deps.reply(socket, request.id, await deps.runtime.setSubagentSettings(request.payload));
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
				// 必须按**这个客户端**生成：用全局快照会让重连的手机拿到电脑的会话
				// （真实症状：电脑上切会话，手机跟着切 —— get_state 是每次重连都会调的）
				deps.sender.pushSnapshot(deps.runtime.snapshotFor(deps.clientId));
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
