/**
 * `POST /api/templates/generate-prompt`：提示词模板的「AI 生成」按钮。
 *
 * 语义是一次**真实的模型调用**（花额度），但不做二次确认：界面只在用户主动点按钮时才发。
 * 失败（没模型 / 输入为空 / 上游报错）一律回 200 + `ok:false` 和可读原因，
 * 界面直接把 `message` 放到编辑框里，不走 500。
 */
import type { Express } from "express";
import type { GenerateTemplatePromptResult, TemplatePromptInput } from "./template-prompt.js";

export function registerTemplatePromptRoutes(
	app: Express,
	options: {
		generate: (
			input: Partial<Record<keyof TemplatePromptInput, unknown>>,
			conversationId: string | null,
		) => Promise<GenerateTemplatePromptResult>;
		log: (message: string, meta?: Record<string, unknown>) => void;
	},
): void {
	app.post("/api/templates/generate-prompt", async (request, response) => {
		response.setHeader("cache-control", "no-store");
		const body = (request.body ?? {}) as Record<string, unknown>;
		// 模型按「这条会话在用的那个」选；弹窗可能在还没开会话时打开，所以允许缺省
		const conversationId =
			typeof body.conversationId === "string" && body.conversationId !== "" ? body.conversationId : null;
		try {
			const result = await options.generate(body, conversationId);
			options.log("提示词 AI 生成", {
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
			options.log("提示词 AI 生成异常", { message });
			response.json({ ok: false, code: "template.failed", message: `生成失败：${message}` });
		}
	});
}
