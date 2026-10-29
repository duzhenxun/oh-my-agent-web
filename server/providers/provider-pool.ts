/**
 * provider 池：**已鉴权的**（引擎报上来的模型）+ **目录里的**（pi 自带、只差一把 key）。
 *
 * 为什么需要后半截：`listModels()` 只回「现在能用」的模型，于是没配 key 的 provider
 * 在界面上根本不存在 —— 想用 xAI / Cerebras / Fireworks 这些「粘一把 key 就能用」的，
 * 只能自己去「添加自定义服务商」手写 baseUrl + 模型表，等于让用户替 pi 抄目录。
 *
 * 合并在这一层做（而不是在 store 里各查一遍）：
 *   - 引擎只负责说「目录里有什么」；
 *   - store 只负责「落盘的配置 + 凭证」；
 *   - 谁跟谁同名的取舍（已鉴权的优先）也只在这里出现一次。
 */
import type { EngineProviderCatalogEntry } from "../engine/port.js";
import { builtinProviderGroups } from "./provider-handlers.js";
import type { BuiltinProvider } from "./provider-store.js";

export async function providerPool(options: {
	/** 引擎当前能用的模型（`provider/modelId`） */
	models: { id: string; label: string; baseUrl?: string; api?: string }[];
	/** 引擎目录；引擎不支持就给 null/undefined */
	catalog?: () => Promise<EngineProviderCatalogEntry[]>;
}): Promise<BuiltinProvider[]> {
	const authenticated = builtinProviderGroups(options.models);
	if (!options.catalog) return authenticated;

	let entries: EngineProviderCatalogEntry[] = [];
	try {
		entries = await options.catalog();
	} catch {
		// 目录拿不到就当没有：面板少一块「官方内置」，但在用的 provider 照样列
		return authenticated;
	}

	// 目录里出现过的 provider 才叫「官方内置」：models.json 里用户手写的（nexita-…）
	// 虽然 source 也是 builtin，但那是自己的配置，归「自定义服务商」。
	const fromCatalog = new Set(entries.map((entry) => entry.provider));
	const marked = authenticated.map((item) => (fromCatalog.has(item.provider) ? { ...item, official: true } : item));
	/**
	 * 已鉴权的内置 provider 也可能拿不到 provider 级端点（引擎只报模型名）：
	 * 从目录条目里补一个，界面上的 base url 才不会空着。
	 */
	const catalogByProvider = new Map(entries.map((entry) => [entry.provider, entry]));
	const filled = marked.map((item) => {
		const entry = catalogByProvider.get(item.provider);
		if (!entry) return item;
		// 逐模型补协议 / 端点：引擎报上来的模型只有 id + 名字，试连时得知道用哪种协议
		const specById = new Map((entry.models ?? []).map((model) => [model.id, model]));
		const models = item.models.map((model) => {
			const spec = specById.get(model.id);
			if (!spec) return model;
			return {
				...model,
				...((model.api ?? spec.api) ? { api: model.api ?? spec.api } : {}),
				...((model.baseUrl ?? spec.baseUrl) ? { baseUrl: model.baseUrl ?? spec.baseUrl } : {}),
			};
		});
		if (item.baseUrl && item.api) return { ...item, models };
		return {
			...item,
			models,
			...(item.baseUrl ? {} : entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
			...(item.api ? {} : entry.api ? { api: entry.api } : {}),
		};
	});
	const known = new Set(filled.map((item) => item.provider));
	const placeholders = entries
		.filter((entry) => !known.has(entry.provider) && entry.modelCount > 0)
		.map((entry) => ({
			provider: entry.provider,
			name: entry.name,
			official: true,
			models: [],
			modelCount: entry.modelCount,
			...(entry.baseUrl ? { baseUrl: entry.baseUrl } : {}),
			...(entry.api ? { api: entry.api } : {}),
			...(entry.oauthOnly ? { oauthOnly: true } : {}),
			...(entry.needsExtraConfig ? { needsExtraConfig: true } : {}),
		}));
	return [...filled, ...placeholders];
}
