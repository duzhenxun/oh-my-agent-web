/**
 * 「填入模型信息」（ADR-0026 C 期）：从 models.dev 查公开的模型规格，**只作建议值**。
 *
 * 三条纪律：
 *   - **只在用户点按钮时联网**，不后台偷偷请求（离线可用性 + 不惊扰用户）；
 *   - 查不到就返回 null，**绝不猜**（猜错的上下文窗口会让 pi 记错账）；
 *   - 内存缓存 10 分钟：同一个模型连点几次不该反复打外网。
 *
 * models.dev 的 api.json 结构不像官方文档那样稳定，所以解析写成"广谱 + 容错"：
 * 顶层是 provider 映射，每层找 models，再按 id / 名称匹配。
 */
type CatalogSpec = {
	name: string;
	contextWindow: number | null;
	maxTokens: number | null;
	reasoning: boolean;
	imageInput: boolean;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
};

const CATALOG_URL = "https://models.dev/api.json";
const CACHE_MS = 10 * 60 * 1000;

function asNumber(value: unknown): number | null {
	const number = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
	return Number.isFinite(number) && number >= 0 ? number : null;
}

/** 纯函数：从 api.json 里按模型 id 找规格（找不到返回 null） */
function extractSpec(json: unknown, modelId: string): CatalogSpec | null {
	if (typeof json !== "object" || json === null) return null;
	const wanted = modelId.toLowerCase();
	for (const provider of Object.values(json as Record<string, unknown>)) {
		if (typeof provider !== "object" || provider === null) continue;
		const models = (provider as { models?: unknown }).models;
		const entries: Array<[string, unknown]> = Array.isArray(models)
			? (models as unknown[]).map((item) => [String((item as { id?: unknown })?.id ?? ""), item])
			: typeof models === "object" && models !== null
				? Object.entries(models as Record<string, unknown>)
				: [];
		for (const [key, value] of entries) {
			if (typeof value !== "object" || value === null) continue;
			const record = value as Record<string, unknown>;
			const id = String(record.id ?? key).toLowerCase();
			if (id !== wanted) continue;
			const limit = (record.limit ?? record.limits ?? {}) as Record<string, unknown>;
			const cost = (record.cost ?? {}) as Record<string, unknown>;
			const modalities = (record.modalities ?? {}) as { input?: unknown };
			const inputs = Array.isArray(modalities.input) ? modalities.input.map(String) : [];
			const numeric = ["input", "output", "cacheRead", "cacheWrite"].map((field) =>
				asNumber(cost[field] ?? cost[field.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`)]),
			);
			const anyCost = numeric.some((value) => value !== null);
			return {
				name: typeof record.name === "string" ? record.name : modelId,
				contextWindow: asNumber(limit.context ?? limit.context_window),
				maxTokens: asNumber(limit.output ?? limit.max_output),
				reasoning: record.reasoning === true,
				imageInput: inputs.includes("image"),
				cost: anyCost
					? {
							input: numeric[0] ?? 0,
							output: numeric[1] ?? 0,
							cacheRead: numeric[2] ?? 0,
							cacheWrite: numeric[3] ?? 0,
						}
					: null,
			};
		}
	}
	return null;
}

type CatalogLookup = (modelId: string) => Promise<CatalogSpec | null>;

/** 带缓存与超时的查询器（网络失败一律返回 null，界面显示「没查到」即可） */
export function createCatalogLookup(options: { fetchImpl?: typeof fetch; timeoutMs?: number } = {}): CatalogLookup {
	let cache: { at: number; json: unknown } | null = null;
	return async (modelId) => {
		const now = Date.now();
		if (!cache || now - cache.at > CACHE_MS) {
			const doFetch = options.fetchImpl ?? fetch;
			const controller = new AbortController();
			const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000);
			try {
				const response = await doFetch(CATALOG_URL, { signal: controller.signal });
				if (!response.ok) return null;
				cache = { at: now, json: await response.json() };
			} catch {
				return null;
			} finally {
				clearTimeout(timer);
			}
		}
		return extractSpec(cache.json, modelId);
	};
}
