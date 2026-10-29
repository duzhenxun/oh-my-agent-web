/**
 * 导入模型的 HTTP 路由（ADR-0026 B 期）。
 *
 *   GET  /api/providers/:provider/remote-models  拉远端模型清单（只读，不写盘）
 *   POST /api/providers/:provider/import         { ids: string[] } 批量追加
 *
 * 走 HTTP 而不是 WS：这是"按需查目录"的一次性数据，不属于会话状态。
 */
import type { Express } from "express";
import { listCodexModels } from "./codex-models.js";
import { testCodex } from "./codex-test.js";
import { listRemoteModels } from "./import-models.js";
import { verifyProviderConfig } from "./probe.js";
import type { BuiltinProvider } from "./provider-store.js";
import type { ProviderCredential, ProviderStore } from "./provider-store.js";

/**
 * 「没有可用凭证」时给界面的人话：
 * 订阅登录（OAuth）与 api key 是两条路，错误文案必须分开说，
 * 否则用户会以为自己的 ChatGPT Plus/Pro 登录白做了（历史 bug：一律报 provider.no_key）。
 */
function noCredentialMessage(credential: ProviderCredential): string {
	return credential.kind === "oauth"
		? "这个 provider 走的是订阅登录（没有 api key）：拉取 / 验证走订阅额度时需要单独的协议支持"
		: "这个 provider 还没有 api key";
}

/** 拉远端模型清单：api key 走 OpenAI 兼容的 /models；订阅登录（Codex）走 /codex/models */
async function remoteModels(
	options: { store: ProviderStore },
	provider: string,
	view: { baseUrl: string; api: string },
	credential: ProviderCredential,
): Promise<Awaited<ReturnType<typeof listRemoteModels>> | Awaited<ReturnType<typeof listCodexModels>>> {
	const headers = await options.store.readHeaders(provider);
	if (credential.kind === "oauth") {
		return listCodexModels({
			baseUrl: view.baseUrl,
			access: credential.access,
			accountId: credential.accountId,
			headers,
		});
	}
	if (credential.kind === "apiKey") {
		return listRemoteModels({ baseUrl: view.baseUrl, api: view.api, apiKey: credential.key, headers });
	}
	return { ok: false, message: noCredentialMessage(credential) };
}

export function registerImportRoutes(
	app: Express,
	options: {
		store: ProviderStore;
		onChange?: () => void;
		/** 内置 provider 池：store.get 不传就查不到「官方内置」（opencode-go 这类） */
		builtinProviders?: () => Promise<BuiltinProvider[]>;
	},
): void {
	const views = async (provider: string) => options.store.get(provider, (await options.builtinProviders?.()) ?? []);
	app.get("/api/providers/:provider/remote-models", async (request, response) => {
		const provider = request.params.provider;
		const view = await views(provider);
		if (!view) {
			response.status(404).json({ error: { code: "provider.not_found", message: "没有这个 provider" } });
			return;
		}
		const credential = await options.store.readCredential(provider);
		if (credential.kind === "none") {
			response.status(400).json({ error: { code: "provider.no_key", message: noCredentialMessage(credential) } });
			return;
		}
		const result = await remoteModels(options, provider, view, credential);
		if (!result.ok) {
			response.status(502).json({ error: { code: "provider.remote_failed", message: result.message } });
			return;
		}
		// 已经导入过的标出来，界面置灰（避免重复导入）
		const imported = new Set(view.models.map((model) => model.id));
		response.json({ models: result.models.map((model) => ({ ...model, imported: imported.has(model.id) })) });
	});

	/** 保存前先探测模型清单：用**表单里还没保存**的值（新 provider 不用先存一次） */
	app.post("/api/providers/remote-models", async (request, response) => {
		const body = request.body as
			| { provider?: string; baseUrl?: string; api?: string; apiKey?: string; headers?: Record<string, string> }
			| undefined;
		// 表单没填 baseUrl 时回落到已保存的配置（内置 provider 就是这样：界面上不重复填）
		const stored = body?.provider ? await options.store.get(body.provider) : null;
		const baseUrl = (typeof body?.baseUrl === "string" ? body.baseUrl.trim() : "") || stored?.baseUrl || "";
		if (baseUrl === "") {
			response.status(400).json({ error: { code: "remote.no_base_url", message: "先填 base url" } });
			return;
		}
		const credential = body?.apiKey?.trim()
			? ({ kind: "apiKey", key: body.apiKey.trim() } as const)
			: await options.store.readCredential(body?.provider ?? "");
		if (credential.kind === "none") {
			response.status(400).json({ error: { code: "remote.no_key", message: noCredentialMessage(credential) } });
			return;
		}
		const headers = body?.headers ?? (body?.provider ? await options.store.readHeaders(body.provider) : {});
		// 订阅登录（Codex）：没有 /v1/models，只能走 /codex/models
		const result =
			credential.kind === "oauth"
				? await listCodexModels({
						baseUrl,
						access: credential.access,
						accountId: credential.accountId,
						...(Object.keys(headers ?? {}).length > 0 ? { headers } : {}),
					})
				: await listRemoteModels({
						baseUrl,
						api: (body?.api ?? stored?.api) || undefined,
						apiKey: credential.key,
						...(Object.keys(headers ?? {}).length > 0 ? { headers } : {}),
					});
		if (!result.ok) {
			response.status(502).json({ error: { code: "remote.failed", message: result.message } });
			return;
		}
		response.json({ models: result.models });
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
		const credential = body?.apiKey?.trim()
			? ({ kind: "apiKey", key: body.apiKey.trim() } as const)
			: await options.store.readCredential(body?.provider ?? "");
		if (credential.kind === "none") {
			response.status(400).json({ error: { code: "verify.no_key", message: noCredentialMessage(credential) } });
			return;
		}
		const headers = body?.headers ?? (body?.provider ? await options.store.readHeaders(body.provider) : {});
		// 订阅登录（Codex）：/models 不存在，得发一次最小的 /codex/responses
		if (credential.kind === "oauth") {
			const modelId = body?.modelId?.trim() ?? "";
			if (modelId === "") {
				response.status(400).json({ error: { code: "verify.no_model", message: "先填一个模型 id 再测试" } });
				return;
			}
			const result = await testCodex({
				baseUrl,
				modelId,
				access: credential.access,
				accountId: credential.accountId,
				...(Object.keys(headers ?? {}).length > 0 ? { headers } : {}),
			});
			response.status(result.ok ? 200 : 400).json(result);
			return;
		}
		const apiKey = credential.key;
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
		/** 内置 provider 池：与 registerImportRoutes 同理，没有它查不到「官方内置」 */
		builtinProviders?: () => Promise<BuiltinProvider[]>;
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
	const views = async (provider: string) => options.store.get(provider, (await options.builtinProviders?.()) ?? []);
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
		const provider = request.params.provider;
		const view = await views(provider);
		if (!view) {
			response.status(404).json({ error: { code: "provider.not_found", message: "没有这个 provider" } });
			return;
		}
		// 凭证可能是 api key，也可能是订阅登录写进去的 OAuth access token（Codex 就是后者）。
		// 两条路的端点/鉴权头完全不同，不能拿 `/chat/completions` 去测 Codex。
		const credential = await options.store.readCredential(provider);
		if (credential.kind === "none") {
			response
				.status(400)
				.json({ error: { code: "provider.no_key", message: "这个 provider 还没有凭证（订阅登录或 api key）" } });
			return;
		}
		const headers = await options.store.readHeaders(provider);
		/**
		 * 逐模型试连：**优先用模型自己的协议 / 端点**。
		 * OpenCode Go 这种同一 provider 下混了 anthropic / openai / gemini 三种协议，
		 * 拿 provider 级的 api 去测必然报「协议不支持」。
		 */
		const modelView = view.models.find((model) => model.id === request.params.modelId);
		const baseUrl = modelView?.baseUrl ?? view.baseUrl;
		const api = modelView?.api ?? view.api;
		const result =
			credential.kind === "oauth"
				? await testCodex({
						baseUrl,
						modelId: request.params.modelId,
						access: credential.access,
						accountId: credential.accountId,
						...(Object.keys(headers).length > 0 ? { headers } : {}),
					})
				: await options.testModel({
						baseUrl,
						api,
						apiKey: credential.key,
						modelId: request.params.modelId,
						headers,
					});
		response.json(result);
	});
}
