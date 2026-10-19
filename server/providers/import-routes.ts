/**
 * 导入模型的 HTTP 路由（ADR-0026 B 期）。
 *
 *   GET  /api/providers/:provider/remote-models  拉远端模型清单（只读，不写盘）
 *   POST /api/providers/:provider/import         { ids: string[] } 批量追加
 *
 * 走 HTTP 而不是 WS：这是"按需查目录"的一次性数据，不属于会话状态。
 */
import type { Express } from "express";
import { listRemoteModels } from "./import-models.js";
import type { ProviderStore } from "./provider-store.js";

export function registerImportRoutes(app: Express, options: { store: ProviderStore; onChange?: () => void }): void {
	app.get("/api/providers/:provider/remote-models", async (request, response) => {
		const provider = request.params.provider;
		const view = await options.store.get(provider);
		if (!view) {
			response.status(404).json({ error: { code: "provider.not_found", message: "没有这个 provider" } });
			return;
		}
		if (view.source === "builtin") {
			response
				.status(400)
				.json({ error: { code: "provider.builtin", message: "内置 provider 由 pi 管理，不能导入模型" } });
			return;
		}
		const apiKey = await options.store.readKey(provider);
		if (!apiKey) {
			response.status(400).json({ error: { code: "provider.no_key", message: "这个 provider 还没有 api key" } });
			return;
		}
		const result = await listRemoteModels({ baseUrl: view.baseUrl, apiKey });
		if (!result.ok) {
			response.status(502).json({ error: { code: "provider.remote_failed", message: result.message } });
			return;
		}
		// 已经导入过的标出来，界面置灰（避免重复导入）
		const imported = new Set(view.models.map((model) => model.id));
		response.json({ models: result.models.map((model) => ({ ...model, imported: imported.has(model.id) })) });
	});

	app.post("/api/providers/:provider/import", async (request, response) => {
		const body = request.body as { ids?: unknown } | undefined;
		const ids = Array.isArray(body?.ids)
			? body.ids.filter((item): item is string => typeof item === "string" && item.trim() !== "")
			: [];
		if (ids.length === 0) {
			response.status(400).json({ error: { code: "import.no_ids", message: "没有勾选任何模型" } });
			return;
		}
		const result = await options.store.addModels(request.params.provider, ids);
		if (!result.ok) {
			response.status(400).json({ error: { code: "import.failed", message: result.error } });
			return;
		}
		options.onChange?.();
		response.json(result);
	});
}
