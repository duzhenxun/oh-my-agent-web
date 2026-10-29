/**
 * 模型测速（`POST /api/models/probe`）：交给**当前引擎**真跑一个最小回合。
 *
 * 为什么是独立一条路由，而不是复用 `/api/providers/:provider/models/:id/test`：
 *   - 那条是 **provider 级 HTTP ping**，前提是工作台自己持有 key（pi 的 models-store.json + auth.json）；
 *   - codex / claude / opencode / dsh 的凭证在**它们自己**的 auth 里，工作台不持有也不该去读，
 *     所以只能让引擎自己发一个 `ping` 回合，量首字节延迟与出字速度（见 engine/port.ts 的 probeModel）。
 *
 * 语义上这是一次**真实调用**：会消耗额度，所以界面必须标注 + 二次确认；
 * 这里不做并发控制（界面是顺序测的），但同一个模型连点时后一个请求会各自跑各自的临时会话，
 * 互不干扰（引擎侧每次都是新 thread / 新 session）。
 */
import type { Express } from "express";
import type { ModelProbeResult } from "../engine/port.js";

export function registerProbeRoutes(
	app: Express,
	options: {
		/** 取当前引擎的探针；引擎不支持时内部会给一条可读结果，这里不关心实现 */
		probeModel: (modelId: string) => Promise<ModelProbeResult>;
		log: (message: string, meta?: Record<string, unknown>) => void;
	},
): void {
	app.post("/api/models/probe", async (request, response) => {
		response.setHeader("cache-control", "no-store");
		const body = request.body as { modelId?: unknown } | undefined;
		const modelId = typeof body?.modelId === "string" ? body.modelId.trim() : "";
		if (modelId === "") {
			response.status(400).json({ ok: false, message: "缺少 modelId" });
			return;
		}
		try {
			const result = await options.probeModel(modelId);
			options.log("模型测速完成", {
				modelId,
				ok: result.ok,
				...(result.ok ? { ttftMs: result.ttftMs, tps: result.tps } : { message: result.message }),
			});
			response.json(result);
		} catch (error) {
			// 探针失败不该是 500：界面上要显示「这个模型测不出来」+ 原因
			const message = error instanceof Error ? error.message : String(error);
			options.log("模型测速失败", { modelId, message });
			response.json({ ok: false, message });
		}
	});
}
