/**
 * provider / 模型配置的校验（ADR-0025 §3）——纯函数，全部可单测。
 *
 * 这一层的存在理由：这些值会被写进 `~/.pi/agent/models-store.json` 与 `auth.json`，
 * 一旦写坏，下次 pi 启动可能整个模型表都读不出来。所以「用户能填什么」必须先收窄。
 */

/** 支持的上游 API 形态（与 pi 的 ModelDefinition.api 对齐） */
export const API_KINDS = [
	"openai-completions",
	"openai-responses",
	"openai-codex-responses",
	"anthropic-messages",
	"typesafe-system-one",
];
export const DEFAULT_API_KIND = "openai-completions";

export const MAX_PROVIDER_ID_CHARS = 32;
export const MAX_MODELS_PER_PROVIDER = 50;
export const MAX_API_KEY_CHARS = 512;
export const MIN_API_KEY_CHARS = 8;
export const MAX_HEADERS = 32;
export const MAX_HEADER_CHARS = 256;

export type ProviderModelInput = { id: string; name?: string; contextWindow?: number };

export type ProviderInput = {
	provider: string;
	baseUrl: string;
	api: string;
	/** 不传 = 不改动已有的 key（ADR-0025 §2：留空即不修改） */
	apiKey?: string;
	/** 自定义请求头；不传 = 保留已有值 */
	headers?: Record<string, string>;
	models: ProviderModelInput[];
};

export type ProviderValidation = { ok: true; value: ProviderInput } | { ok: false; errors: string[] };

const PROVIDER_RE = /^[a-z0-9][a-z0-9-]{1,30}$/;
const MODEL_ID_RE = /^[A-Za-z0-9._:/-]{1,120}$/;

/** 纯函数：baseUrl 只允许 http(s)，且禁止 user:pass@ 这种把凭证塞进地址的形态 */
export function validateBaseUrl(raw: unknown): { ok: true; value: string } | { ok: false; error: string } {
	if (typeof raw !== "string") return { ok: false, error: "baseUrl 必须是字符串" };
	const value = raw.trim();
	if (value === "") return { ok: false, error: "baseUrl 不能为空" };
	if (/^(file|javascript|data|vbscript):/i.test(value)) return { ok: false, error: "baseUrl 只允许 http(s)" };
	let url: URL;
	try {
		url = new URL(value);
	} catch {
		return { ok: false, error: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, error: "baseUrl 只允许 http(s)" };
	if (url.username !== "" || url.password !== "") return { ok: false, error: "baseUrl 里不能带用户名密码" };
	return { ok: true, value: value.replace(/\/+$/, "") };
}

/** 纯函数：api key 只做形态校验（长度 / 不许换行），不验真伪 */
export function validateHeaders(
	raw: unknown,
): { ok: true; value: Record<string, string> | undefined } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
	if (typeof raw !== "object" || Array.isArray(raw)) return { ok: false, error: "headers 必须是 JSON 对象" };
	const headers: Record<string, string> = {};
	for (const [rawName, rawValue] of Object.entries(raw as Record<string, unknown>)) {
		const name = rawName.trim();
		const value = typeof rawValue === "string" ? rawValue.trim() : "";
		if (name === "" || value === "") continue;
		if (!/^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/.test(name)) return { ok: false, error: `header 名称不合法：${name}` };
		if (name.length > MAX_HEADER_CHARS || value.length > MAX_HEADER_CHARS)
			return { ok: false, error: "header 名称和值不能超过 256 个字符" };
		if (/[\r\n]/.test(value)) return { ok: false, error: `header 值不能包含换行：${name}` };
		headers[name] = value;
		if (Object.keys(headers).length > MAX_HEADERS) return { ok: false, error: `最多配置 ${MAX_HEADERS} 个 header` };
	}
	return { ok: true, value: Object.keys(headers).length > 0 ? headers : undefined };
}

export function validateApiKey(raw: unknown): { ok: true; value: string | undefined } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: undefined };
	if (typeof raw !== "string") return { ok: false, error: "apiKey 必须是字符串" };
	const value = raw.trim();
	if (value === "") return { ok: true, value: undefined };
	if (value.length < MIN_API_KEY_CHARS) return { ok: false, error: `apiKey 太短（至少 ${MIN_API_KEY_CHARS} 位）` };
	if (value.length > MAX_API_KEY_CHARS) return { ok: false, error: `apiKey 太长（最多 ${MAX_API_KEY_CHARS} 位）` };
	if (/[\r\n]/.test(value)) return { ok: false, error: "apiKey 不能包含换行" };
	return { ok: true, value };
}

/** 纯函数：把 key 变成「尾 4 位」提示（前端只能看到这个） */
export function maskKey(key: string | undefined): string | null {
	if (!key) return null;
	const tail = key.slice(-4);
	return `…${tail}`;
}

/** 纯函数：整张表单的校验（一次收集所有错误，别让用户挤牙膏式试错） */
export function validateProviderInput(input: unknown): ProviderValidation {
	if (typeof input !== "object" || input === null) return { ok: false, errors: ["入参不是对象"] };
	const record = input as Record<string, unknown>;
	const errors: string[] = [];

	const provider = typeof record.provider === "string" ? record.provider.trim().toLowerCase() : "";
	if (!PROVIDER_RE.test(provider)) errors.push("provider 只能是小写字母/数字/短横线（2–32 位）");

	const baseUrlResult = validateBaseUrl(record.baseUrl);
	if (!baseUrlResult.ok) errors.push(baseUrlResult.error);

	const api = typeof record.api === "string" && record.api.trim() !== "" ? record.api.trim() : DEFAULT_API_KIND;
	if (!API_KINDS.includes(api)) errors.push(`api 必须是：${API_KINDS.join(" / ")}`);

	const keyResult = validateApiKey(record.apiKey);
	if (!keyResult.ok) errors.push(keyResult.error);
	const headersResult = validateHeaders(record.headers);
	if (!headersResult.ok) errors.push(headersResult.error);

	const models: ProviderModelInput[] = [];
	const rawModels = Array.isArray(record.models) ? record.models : [];
	const seen = new Set<string>();
	for (const item of rawModels) {
		const id =
			typeof item === "string"
				? item.trim()
				: typeof item === "object" && item !== null
					? String((item as { id?: unknown }).id ?? "").trim()
					: "";
		if (id === "") continue;
		if (!MODEL_ID_RE.test(id)) {
			errors.push(`模型 id 含非法字符：${id}`);
			continue;
		}
		if (seen.has(id)) continue;
		seen.add(id);
		const name = typeof item === "object" && item !== null ? (item as { name?: unknown }).name : undefined;
		const contextWindow =
			typeof item === "object" && item !== null ? (item as { contextWindow?: unknown }).contextWindow : undefined;
		models.push({
			id,
			...(typeof name === "string" && name.trim() !== "" ? { name: name.trim().slice(0, 80) } : {}),
			...(typeof contextWindow === "number" && Number.isFinite(contextWindow) && contextWindow > 0
				? { contextWindow: Math.floor(contextWindow) }
				: {}),
		});
	}
	if (models.length === 0) errors.push("至少填一个模型 id");
	if (models.length > MAX_MODELS_PER_PROVIDER) errors.push(`最多 ${MAX_MODELS_PER_PROVIDER} 个模型`);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			provider,
			baseUrl: baseUrlResult.ok ? baseUrlResult.value : "",
			api,
			...(keyResult.ok && keyResult.value ? { apiKey: keyResult.value } : {}),
			...(headersResult.ok && headersResult.value ? { headers: headersResult.value } : {}),
			models,
		},
	};
}

/** 单个模型的规格（ADR-0026 A 期）：能力 + 上下文窗口 + 最大输出 + 每百万 tokens 价格 */
export type ModelSpec = {
	id: string;
	name: string;
	/** 推理 / 思考 */
	reasoning: boolean;
	/** 支持图片输入 */
	imageInput: boolean;
	contextWindow: number | null;
	maxTokens: number | null;
	cost: { input: number; output: number; cacheRead: number; cacheWrite: number } | null;
};

export const MAX_CONTEXT_WINDOW = 100_000_000;
export const MAX_MAX_TOKENS = 10_000_000;

/** 纯函数：正整数（可空）；空串/null/undefined 都算"未提供" */
function positiveInteger(
	raw: unknown,
	limit: number,
	label: string,
): { ok: true; value: number | null } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: null };
	const value = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(value) || value <= 0) return { ok: false, error: `${label} 必须是正整数` };
	const rounded = Math.floor(value);
	if (rounded > limit) return { ok: false, error: `${label} 不能超过 ${limit}` };
	return { ok: true, value: rounded };
}

/** 纯函数：非负价格（可空） */
function price(raw: unknown, label: string): { ok: true; value: number } | { ok: false; error: string } {
	if (raw === undefined || raw === null || raw === "") return { ok: true, value: 0 };
	const value = typeof raw === "number" ? raw : Number(String(raw).trim());
	if (!Number.isFinite(value) || value < 0) return { ok: false, error: `${label} 必须是非负数` };
	return { ok: true, value };
}

/** 纯函数：整张模型表单的校验（一次收集全部错误） */
export function validateModelSpec(input: unknown): { ok: true; value: ModelSpec } | { ok: false; errors: string[] } {
	if (typeof input !== "object" || input === null) return { ok: false, errors: ["入参不是对象"] };
	const record = input as Record<string, unknown>;
	const errors: string[] = [];

	const id = typeof record.id === "string" ? record.id.trim() : "";
	if (!MODEL_ID_RE.test(id)) errors.push("模型 id 只能包含字母数字与 . _ : / -（1–120 位）");

	const contextWindow = positiveInteger(record.contextWindow, MAX_CONTEXT_WINDOW, "上下文窗口");
	if (!contextWindow.ok) errors.push(contextWindow.error);
	const maxTokens = positiveInteger(record.maxTokens, MAX_MAX_TOKENS, "最大输出 tokens");
	if (!maxTokens.ok) errors.push(maxTokens.error);

	const costInput = record.cost as Record<string, unknown> | undefined;
	const cost = {
		input: price(costInput?.input, "输入价格"),
		output: price(costInput?.output, "输出价格"),
		cacheRead: price(costInput?.cacheRead, "缓存读价格"),
		cacheWrite: price(costInput?.cacheWrite, "缓存写价格"),
	};
	for (const item of Object.values(cost)) if (!item.ok) errors.push(item.error);
	const costProvided =
		costInput !== undefined &&
		Object.values(costInput).some((value) => value !== "" && value !== null && value !== undefined);

	if (errors.length > 0) return { ok: false, errors };
	return {
		ok: true,
		value: {
			id,
			name: typeof record.name === "string" && record.name.trim() !== "" ? record.name.trim().slice(0, 80) : id,
			reasoning: record.reasoning === true,
			imageInput: record.imageInput === true,
			contextWindow: contextWindow.ok ? contextWindow.value : null,
			maxTokens: maxTokens.ok ? maxTokens.value : null,
			cost: costProvided
				? {
						input: cost.input.ok ? cost.input.value : 0,
						output: cost.output.ok ? cost.output.value : 0,
						cacheRead: cost.cacheRead.ok ? cost.cacheRead.value : 0,
						cacheWrite: cost.cacheWrite.ok ? cost.cacheWrite.value : 0,
					}
				: null,
		},
	};
}
