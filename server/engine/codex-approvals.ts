/**
 * 审批回包（codex → 工作台 → codex）。
 *
 * codex 在危险操作前会发**服务端请求**（`item/commandExecution/requestApproval` /
 * `item/fileChange/requestApproval` …）。这些必须回包，否则那一轮会一直等。
 *
 * 纪律（ADR-0006）：
 *   - 宿主没有 handler → **一律 decline**（绝不因为「没接上」就放行）；
 *   - 认不出的请求也要回一个错误包，不能装作没看见；
 *   - `willRetry` 的瞬时错误由 codex 自己重试，这里不参与。
 *
 * 单独一个文件是为了 400 行护栏（ADR-0010）：codex 引擎本体已经贴着上限。
 */
import type { ApprovalHandler } from "./port.js";
import { approvalDecision, commandApprovalRequest, fileChangeApprovalRequest } from "./codex-map.js";
import type { CodexClient, CodexServerRequest } from "./codex-transport.js";

export function registerCodexApprovals(options: {
	client: CodexClient;
	getHandler: () => ApprovalHandler | null;
}): void {
	const { client } = options;

	client.onServerRequest((request: CodexServerRequest) => {
		const method = request.method;
		const ask = async (build: () => Parameters<ApprovalHandler>[0], kind: "command" | "file"): Promise<void> => {
			if (!options.getHandler()) {
				client.respond(request.id, { decision: "decline" });
				return;
			}
			let decision: "once" | "always" | "deny" = "deny";
			try {
				const handler = options.getHandler();
				decision = handler ? await handler(build()) : "deny";
			} catch {
				decision = "deny";
			}
			client.respond(request.id, { decision: approvalDecision(decision, kind) });
		};

		if (method === "item/commandExecution/requestApproval") {
			void ask(() => commandApprovalRequest(request.params), "command");
			return;
		}
		if (method === "item/fileChange/requestApproval") {
			void ask(() => fileChangeApprovalRequest(request.params), "file");
			return;
		}
		if (method === "item/tool/requestUserInput") {
			// 工作台还没有「结构化提问」的界面：给空答案，让这一轮继续往下走
			client.respond(request.id, { answers: {} });
			return;
		}
		if (method === "item/tool/call") {
			client.respond(request.id, { contentItems: [], success: false });
			return;
		}
		if (method === "mcpServer/elicitation/request") {
			client.respond(request.id, { action: "decline", content: null, _meta: null });
			return;
		}
		// 认不出的服务端请求必须回包，否则 codex 会一直等它
		client.respondError(request.id, -32601, `agent-web 未实现的服务端请求：${method}`);
	});
}
