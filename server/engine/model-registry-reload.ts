/**
 * 让「刚加进去的自定义 provider / 模型」立刻对 pi 生效。
 *
 * 为什么需要这一层（实测出来的）：
 *   - pi 的模型注册表是**进程内缓存**；
 *   - `ModelRuntime.refresh()` 只重新拉「动态 provider 的远端目录」，
 *     不会重新读 `models.json` 里的 provider 定义；
 *   - 于是「界面上加了 abc，但模型选择器里没有」—— 因为活着的会话里根本没有这个 provider。
 *
 * 所以除了重建预热会话，还要对**每个活着的会话**调 `registerProvider()` 把配置推过去。
 * 这些都是 pi 的公开 API（registerProvider / unregisterProvider）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { setPriceIndex } from "../util/pricing-index.js";

type WarmSession = {
	unsubscribe: () => void;
	session: {
		dispose: () => void;
		modelRuntime?: {
			refresh?: (options?: unknown) => Promise<unknown>;
			registerProvider?: (id: string, config: Record<string, unknown>) => void;
			unregisterProvider?: (id: string) => void;
		};
	};
};

type ModelJson = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
	headers?: Record<string, string>;
	[key: string]: unknown;
};

type ProviderConfig = {
	id: string;
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models: ModelJson[];
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}

/** 把 pi 的两份配置读成「可直接 registerProvider 的形状」 */
export async function readProviderConfigs(agentDir: string): Promise<ProviderConfig[]> {
	const catalog = await readJson<{ providers?: Record<string, Record<string, unknown>> }>(
		join(agentDir, "models.json"),
		{},
	);
	const store = await readJson<Record<string, { models?: ModelJson[] }>>(join(agentDir, "models-store.json"), {});
	const auth = await readJson<Record<string, { key?: string }>>(join(agentDir, "auth.json"), {});

	const configs: ProviderConfig[] = [];
	for (const [id, entry] of Object.entries(catalog.providers ?? {})) {
		configs.push({
			id,
			...(typeof entry.api === "string" ? { api: entry.api } : {}),
			...(typeof entry.baseUrl === "string" ? { baseUrl: entry.baseUrl } : {}),
			...(typeof entry.apiKey === "string" ? { apiKey: entry.apiKey } : {}),
			...(entry.headers ? { headers: entry.headers as Record<string, string> } : {}),
			models: (entry.models as ModelJson[] | undefined) ?? [],
		});
	}
	for (const [id, entry] of Object.entries(store)) {
		const models = Array.isArray(entry.models) ? entry.models : [];
		const template = models.find((model) => model.api && model.baseUrl);
		if (!template) continue;
		configs.push({
			id,
			api: template.api,
			baseUrl: template.baseUrl,
			...(auth[id]?.key ? { apiKey: auth[id].key } : {}),
			...(template.headers ? { headers: template.headers } : {}),
			models,
		});
	}
	return configs;
}

/** pi 认的模型字段（缺省给安全值，避免 provider 被拒） */
function toProviderModel(model: ModelJson) {
	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning === true,
		input: Array.isArray(model.input) ? model.input : ["text"],
		contextWindow: model.contextWindow ?? 128_000,
		maxTokens: model.maxTokens ?? 8_192,
		cost: model.cost ?? { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		...(model.headers ? { headers: model.headers } : {}),
	};
}

/** 我们通过 registerProvider 推给运行时的 provider（用来在改名/删除后注销旧的） */
const pushed = new Set<string>();

export async function reloadModelRegistry(
	sessions: Map<string, WarmSession>,
	prewarmId: string,
	prewarm: () => Promise<void> | undefined,
	agentDir: string,
): Promise<void> {
	const warm = sessions.get(prewarmId);
	if (warm) {
		try {
			warm.unsubscribe();
			warm.session.dispose();
		} catch {
			// 预热会话无关紧要，dispose 失败忽略
		}
		sessions.delete(prewarmId);
	}
	await prewarm();

	const configs = await readProviderConfigs(agentDir);
	// 分时价格索引（ADR-0026 D 期）：反正这两份配置刚读过，顺手把「时段 → 价格」也刷一遍，
	// 不然用户刚改完价格，下一轮的消息花费还是按旧价算的。
	setPriceIndex(configs.map((config) => ({ provider: config.id, models: config.models })));
	for (const handle of sessions.values()) {
		const runtime = handle.session.modelRuntime;
		await runtime?.refresh?.({ allowNetwork: false }).catch(() => undefined);
		// 配置里已经没有的（改名 / 删除）：从运行时注销，否则旧名字会一直挂在模型表里。
		// 先收集再删：在遍历 `pushed` 时 delete 会让后续会话跳过这些 id（旧的注销不干净）。
		const stale = [...pushed].filter((id) => !configs.some((config) => config.id === id));
		for (const id of stale) runtime?.unregisterProvider?.(id);
		if (sessions.size > 0) for (const id of stale) pushed.delete(id);
		for (const config of configs) {
			try {
				runtime?.registerProvider?.(config.id, {
					...(config.api ? { api: config.api } : {}),
					...(config.baseUrl ? { baseUrl: config.baseUrl } : {}),
					...(config.apiKey ? { apiKey: config.apiKey } : {}),
					...(config.headers ? { headers: config.headers } : {}),
					models: config.models.map(toProviderModel),
				});
				pushed.add(config.id);
			} catch {
				// 单个 provider 注册失败不该拖垮整次刷新（它只是不出现在列表里）
			}
		}
	}
}
