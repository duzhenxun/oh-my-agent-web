/**
 * `POST /api/cron/generate-prompt`：定时任务表单「提示词」旁的「AI 生成」按钮。
 *
 * 语义同 `/api/templates/generate-prompt`：一次真实的模型调用，只在用户点按钮时才发；
 * 失败一律回 200 + `ok:false` 和可读原因，界面直接展示 `message`。
 */
import type { Express } from "express";
import type { GenerateCronPromptResult } from "./cron-prompt.js";

export function registerCronPromptRoutes(
	app: Express,
	options: {
		generate: (name: unknown, conversationId: string | null) => Promise<GenerateCronPromptResult>;
		log: (message: string, meta?: Record<string, unknown>) => void;
	},
): void {
	app.post("/api/cron/generate-prompt", async (request, response) => {
		response.setHeader("cache-control", "no-store");
		const body = (request.body ?? {}) as Record<string, unknown>;
		const conversationId =
			typeof body.conversationId === "string" && body.conversationId !== "" ? body.conversationId : null;
		try {
			const result = await options.generate(body.name, conversationId);
			options.log("定时任务 AI 生成提示词", {
				ok: result.ok,
				...(result.ok ? { chars: result.text.length } : { code: result.error.code }),
			});
			if (result.ok) {
				response.json({ ok: true, text: result.text });
			} else {
				response.json({ ok: false, code: result.error.code, message: result.error.message });
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			options.log("定时任务 AI 生成异常", { message });
			response.json({ ok: false, code: "cron.failed", message: `生成失败：${message}` });
		}
	});
}
