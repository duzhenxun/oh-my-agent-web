/**
 * provider 请求的处理（从 index.ts 抽出来：400 行护栏，ADR-0010）。
 *
 * 保持极简：校验 → 写盘 → 用提示条回传结果（前端没有 request/response 配对机制）。
 */
import type { ProviderView, UpsertProviderRequest } from "../protocol.js";
import type { BuiltinProvider, ProviderStore } from "./provider-store.js";
import { validateModelSpec, validateProviderInput } from "./validate.js";
import { toggleModel, toggleProvider } from "./enabled-models.js";

export type ProviderHandlerDeps = {
	store: ProviderStore;
	/** 给界面推一条提示（成功/失败都用它回传结果） */
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logInfo: (message: string, meta?: Record<string, unknown>) => void;
	/** 引擎报上来的内置 provider（pi 内置目录里的 nexita / nexita-anthropic …） */
	builtinProviders: () => { provider: string; models: { id: string; name: string }[] }[];
	/** 测试连通性时要读明文 key（只在这一处、只用于发出请求，不返回给界面） */
	readKey: (provider: string) => Promise<string | null>;
	/** 启用白名单（pi settings.json 的 enabledModels） */
	enabled: { read: () => Promise<string[]>; write: (patterns: string[]) => Promise<void> };
	probe: (options: {
		baseUrl: string;
		api?: string;
		apiKey: string;
		headers?: Record<string, string>;
	}) => Promise<{ ok: boolean; status?: number; latencyMs?: number; message?: string }>;
};

export type ProviderReply = { ok: true; result?: unknown } | { ok: false; error: { code: string; message: string } };

/** 返回 null = 不是 provider 相关请求（交回主分发） */
export async function handleProviderRequest(
	request: { type: string } & Record<string, unknown>,
	deps: ProviderHandlerDeps,
): Promise<ProviderReply | null> {
	if (request.type === "list_providers")
		return { ok: true, result: { providers: await deps.store.list(deps.builtinProviders()) } };

	if (request.type === "upsert_provider") {
		const parsed = validateProviderInput((request as unknown as UpsertProviderRequest).payload);
		if (!parsed.ok) {
			const message = parsed.errors.join("；");
			deps.notify(`provider 配置有问题：${message}`, "error");
			return { ok: false, error: { code: "provider.invalid", message } };
		}
		const result = await deps.store.upsert(parsed.value);
		if (!result.ok) {
			deps.notify(`provider 保存失败：${result.error}`, "error");
			return { ok: false, error: { code: "provider.upsert_failed", message: result.error } };
		}
		deps.logInfo("provider 已保存", {
			provider: result.view.provider,
			hasKey: result.view.hasKey,
			models: result.view.models.length,
		});
		const from = (request as unknown as { payload?: { previousProvider?: string } }).payload?.previousProvider;
		const what = from
			? `provider「${from}」已改名为「${result.view.provider}」`
			: `provider「${result.view.provider}」已保存`;
		deps.notify(
			`${what}：${result.view.models.length} 个模型${result.view.hasKey ? `，key ${result.view.keyHint}` : ""}（已热重载）`,
			"info",
		);
		return { ok: true, result: { provider: result.view } };
	}

	if (request.type === "update_model") {
		const payload = (request as unknown as { payload: { provider: string; model: unknown } }).payload;
		const parsed = validateModelSpec(payload.model);
		if (!parsed.ok) {
			const message = parsed.errors.join("；");
			deps.notify(`模型信息有问题：${message}`, "error");
			return { ok: false, error: { code: "model.invalid", message } };
		}
		const view = await deps.store.get(payload.provider, deps.builtinProviders());
		const seed =
			view?.source === "builtin"
				? { baseUrl: view.baseUrl, api: view.api, models: view.models.map((m) => ({ id: m.id, name: m.name })) }
				: undefined;
		const result = await deps.store.updateModel(payload.provider, parsed.value, seed);
		if (!result.ok) {
			deps.notify(`保存模型失败：${result.error}`, "error");
			return { ok: false, error: { code: "model.update_failed", message: result.error } };
		}
		deps.notify(`模型「${parsed.value.name}」已保存，模型表已热重载`, "info");
		return { ok: true };
	}

	if (request.type === "set_enabled_models") {
		const payload = (request as unknown as { payload: { provider: string; enabled: boolean; modelId?: string } })
			.payload;
		// provider === "*"：全开（pi 的语义是「没有白名单 = 不限制」）
		if (payload.provider === "*") {
			await deps.enabled.write([]);
			deps.notify("已启用全部模型（清空 enabledModels 白名单）", "info");
			return { ok: true, result: { enabledModels: [] } };
		}
		const patterns = await deps.enabled.read();
		const builtins = deps.builtinProviders();
		// 内置 provider 也在名单里：否则 view 为 null，modelIds 为空，
		// 「停用其中一个模型」会被展开成 []（= 禁用整个 provider）
		const view = await deps.store.get(payload.provider, builtins);
		// 全开状态下停用一个 provider，需要知道「其它 provider 有哪些模型」才能展开成白名单
		const universe = (await deps.store.list(builtins)).map((item) => ({
			provider: item.provider,
			models: item.models.map((model) => model.id),
		}));
		const modelIds = (view?.models ?? []).map((model) => model.id);
		const next = payload.modelId
			? toggleModel(patterns, payload.provider, modelIds, payload.modelId, payload.enabled, universe)
			: toggleProvider(patterns, payload.provider, modelIds, payload.enabled, universe);
		await deps.enabled.write(next);
		const what = payload.modelId ? `模型「${payload.modelId}」` : `provider「${payload.provider}」`;
		deps.notify(`${what}${payload.enabled ? "已启用" : "已停用"}（写进 pi 的 settings.json）`, "info");
		return { ok: true, result: { enabledModels: next } };
	}

	if (request.type === "remove_model") {
		const payload = (request as unknown as { payload: { provider: string; modelId: string } }).payload;
		const view = await deps.store.get(payload.provider, deps.builtinProviders());
		const seed =
			view?.source === "builtin"
				? { baseUrl: view.baseUrl, api: view.api, models: view.models.map((m) => ({ id: m.id, name: m.name })) }
				: undefined;
		const result = await deps.store.removeModel(payload.provider, payload.modelId, seed);
		if (!result.ok) {
			deps.notify(`移除模型失败：${result.error}`, "error");
			return { ok: false, error: { code: "model.remove_failed", message: result.error } };
		}
		deps.notify(`已从「${payload.provider}」移除模型：${payload.modelId}`, "info");
		return { ok: true };
	}

	if (request.type === "delete_provider") {
		const provider = String((request as { provider?: unknown }).provider ?? "");
		const result = await deps.store.remove(provider);
		if (!result.ok) {
			deps.notify(`删除失败：${result.error}`, "error");
			return { ok: false, error: { code: "provider.delete_failed", message: result.error } };
		}
		deps.logInfo("provider 已删除", { provider, removed: result.removed });
		deps.notify(
			result.removed
				? `provider「${provider}」已删除`
				: `provider「${provider}」不在这两份配置文件里（可能是插件注册的），无法从这里删除`,
			result.removed ? "info" : "warn",
		);
		return { ok: true, result: { removed: result.removed } };
	}

	if (request.type === "test_provider") {
		const provider = String((request as { provider?: unknown }).provider ?? "");
		// 内置 provider 也要能测：以前查不到直接报「没有这个 provider」
		const view = await deps.store.get(provider, deps.builtinProviders());
		if (!view) {
			deps.notify(`没有这个 provider：${provider}`, "warn");
			return { ok: false, error: { code: "provider.not_found", message: "没有这个 provider" } };
		}
		const apiKey = await deps.readKey(provider);
		if (!apiKey) {
			deps.notify(`provider「${provider}」还没有 api key，无法测试`, "warn");
			return { ok: false, error: { code: "provider.no_key", message: "没有 api key" } };
		}
		const result = await deps.probe({
			baseUrl: view.baseUrl,
			api: view.api,
			apiKey,
			headers: await deps.store.readHeaders(provider),
		});
		deps.notify(
			result.ok
				? `provider「${provider}」连通正常（HTTP ${result.status}，${result.latencyMs}ms）`
				: `provider「${provider}」连不通：${result.message}`,
			result.ok ? "info" : "error",
		);
		return { ok: true, result };
	}

	return null;
}

/** 组装依赖：把「读 key / 发探测 / 日志 / 提示」这些副作用集中在一处，index 里只留一行 */
export function createProviderDeps(options: {
	store: ProviderStore;
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
	probe: ProviderHandlerDeps["probe"];
	builtinProviders: ProviderHandlerDeps["builtinProviders"];
	enabled?: ProviderHandlerDeps["enabled"];
}): ProviderHandlerDeps {
	return {
		store: options.store,
		notify: options.notify,
		logInfo: (message, meta) => options.logger.info(message, meta),
		readKey: (provider) => options.store.readKey(provider),
		builtinProviders: options.builtinProviders,
		enabled: options.enabled ?? {
			read: async () => [],
			write: async () => {},
		},
		probe: options.probe,
	};
}

/**
 * 把「处理 → 刷新快照 → 回包」串起来（index.ts 里只留一行，见 400 行护栏）。
 * 回包用回调传入，这样这里不需要认识 WebSocket。
 */
export function createProviderRunner(options: {
	store: ProviderStore;
	notify: (text: string, level: "info" | "warn" | "error") => void;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
	probe: ProviderHandlerDeps["probe"];
	builtinProviders: ProviderHandlerDeps["builtinProviders"];
	enabled?: ProviderHandlerDeps["enabled"];
	/** 变更后把最新列表塞回 state 并推快照（前端只认快照，ADR-0004） */
	refresh: () => Promise<void>;
}): (request: { type: string } & Record<string, unknown>, reply: (result: ProviderReply) => void) => Promise<void> {
	const deps = createProviderDeps(options);
	return async (request, reply) => {
		const handled = await handleProviderRequest(request, deps);
		await options.refresh();
		if (handled) reply(handled);
	};
}

/** 引擎报上来的模型按 provider 前缀分组（`provider/modelId`）→「内置 provider」列表 */
export function builtinProviderGroups(
	models: { id: string; label: string; baseUrl?: string; api?: string }[],
): BuiltinProvider[] {
	const groups = new Map<string, { id: string; name: string }[]>();
	const endpoint = new Map<string, { baseUrl?: string; api?: string }>();
	for (const model of models) {
		const slash = model.id.indexOf("/");
		if (slash <= 0) continue;
		const provider = model.id.slice(0, slash);
		groups.set(provider, [...(groups.get(provider) ?? []), { id: model.id.slice(slash + 1), name: model.label }]);
		// 引擎知道内置 provider 的真实端点；没有它，「测试」按钮对内 provider 就是死的
		if (!endpoint.has(provider) && (model.baseUrl || model.api)) {
			endpoint.set(provider, {
				...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
				...(model.api ? { api: model.api } : {}),
			});
		}
	}
	return [...groups].map(([provider, list]) => ({ provider, models: list, ...endpoint.get(provider) }));
}

/**
 * 把 provider 的「请求处理 + 快照刷新」接线整体封装（放在这里是为了 index.ts 的 400 行护栏）。
 * `getRuntime` 用 getter 传进来：runtime 在 index 里晚于本模块构造，只有调用时才需要它。
 */
export function createProviderWiring(options: {
	store: ProviderStore;
	logger: { info: (message: string, meta?: Record<string, unknown>) => void };
	probe: ProviderHandlerDeps["probe"];
	enabled?: ProviderHandlerDeps["enabled"];
	getRuntime: () => {
		notify: (text: string, level?: "info" | "warn" | "error") => void;
		/** 直接推一帧快照（不制造一条空提示） */
		pushSnapshot: () => void;
		reloadModels: () => Promise<void>;
		state: () => { providers: ProviderView[]; models: { id: string; label: string }[]; enabledModels: string[] };
	};
}): (request: { type: string } & Record<string, unknown>, reply: (result: ProviderReply) => void) => Promise<void> {
	const runtime = () => options.getRuntime();
	return createProviderRunner({
		store: options.store,
		logger: options.logger,
		probe: options.probe,
		...(options.enabled ? { enabled: options.enabled } : {}),
		notify: (text, level) => runtime().notify(text, level),
		builtinProviders: () => builtinProviderGroups(runtime().state().models),
		refresh: async () => {
			const live = runtime().state();
			live.providers = await options.store.list(builtinProviderGroups(live.models));
			// 启用白名单也一起刷：否则界面的开关会停在旧状态（点了像没生效）
			if (options.enabled) live.enabledModels = await options.enabled.read();
			await runtime().reloadModels();
			runtime().pushSnapshot();
		},
	});
}
