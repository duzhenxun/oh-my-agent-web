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
import { verifyProviderConfig } from "./probe.js";
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
		const result = await listRemoteModels({
			baseUrl: view.baseUrl,
			api: view.api,
			apiKey,
			headers: await options.store.readHeaders(provider),
		});
		if (!result.ok) {
			response.status(502).json({ error: { code: "provider.remote_failed", message: result.message } });
			return;
		}
		// 已经导入过的标出来，界面置灰（避免重复导入）
		const imported = new Set(view.models.map((model) => model.id));
		response.json({ models: result.models.map((model) => ({ ...model, imported: imported.has(model.id) })) });
	});

	/** 保存前先验证：用**表单里还没保存**的值试一次（key 留空则用已存的那把） */
	app.post("/api/providers/verify", async (request, response) => {
		const body = request.body as
			| {
					provider?: string;
					baseUrl?: string;
					api?: string;
					apiKey?: string;
					headers?: Record<string, string>;
					modelId?: string;
			  }
			| undefined;
		const baseUrl = typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "";
		if (baseUrl === "") {
			response.status(400).json({ error: { code: "verify.no_base_url", message: "先填 base url" } });
			return;
		}
		const apiKey = body?.apiKey?.trim() ? body.apiKey.trim() : await options.store.readKey(body?.provider ?? "");
		if (!apiKey) {
			response.status(400).json({ error: { code: "verify.no_key", message: "还没有 api key：先填一个再测试" } });
			return;
		}
		const headers = body?.headers ?? (body?.provider ? await options.store.readHeaders(body.provider) : {});
		const result = await verifyProviderConfig({
			baseUrl,
			...(body?.api ? { api: body.api } : {}),
			apiKey,
			...(Object.keys(headers ?? {}).length > 0 ? { headers } : {}),
			...(body?.modelId ? { modelId: body.modelId } : {}),
		});
		response.status(result.ok ? 200 : 400).json(result);
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

/** 「填入模型信息」与逐模型测试（ADR-0026 C 期）：两条都很轻，和导入放在一起注册 */
export function registerCatalogRoutes(
	app: Express,
	options: {
		store: ProviderStore;
		catalog: (modelId: string) => Promise<unknown>;
		testModel: (input: {
			baseUrl: string;
			api?: string;
			apiKey: string;
			modelId: string;
			headers?: Record<string, string>;
		}) => Promise<unknown>;
	},
): void {
	app.get("/api/providers/:provider/catalog", async (request, response) => {
		const modelId = typeof request.query.model === "string" ? request.query.model : "";
		if (modelId === "") {
			response.status(400).json({ error: { code: "catalog.no_model", message: "缺少 model 参数" } });
			return;
		}
		const spec = await options.catalog(modelId);
		if (!spec) {
			response
				.status(404)
				.json({ error: { code: "catalog.not_found", message: "models.dev 里没有这个模型，请手动填写" } });
			return;
		}
		response.json({ source: "models.dev", spec });
	});

	app.post("/api/providers/:provider/models/:modelId/test", async (request, response) => {
		const view = await options.store.get(request.params.provider);
		if (!view) {
			response.status(404).json({ error: { code: "provider.not_found", message: "没有这个 provider" } });
			return;
		}
		const apiKey = await options.store.readKey(request.params.provider);
		if (!apiKey) {
			response.status(400).json({ error: { code: "provider.no_key", message: "这个 provider 还没有 api key" } });
			return;
		}
		const result = await options.testModel({
			baseUrl: view.baseUrl,
			api: view.api,
			apiKey,
			modelId: request.params.modelId,
			headers: await options.store.readHeaders(request.params.provider),
		});
		response.json(result);
	});
}
