/**
 * Codex（订阅登录）的远端模型清单。
 *
 * 和普通 OpenAI 兼容网关不同，ChatGPT 后端**没有** `/v1/models`，只有：
 *   GET {baseUrl}/codex/models?client_version=<x.y.z>
 * 且 `client_version` 是**必填**（缺了 400 missing field）；版本号还会影响返回内容
 * （实测 0.36.0 / 0.5.0 返回空数组，1.0.0 才给完整清单）。
 *
 * 所以这里固定报一个较新的 client_version，并做两件事：
 *   - 过滤 `visibility: "hide"`（后端有但没打算给用户看的，例如 reserve / auto-review）
 *     和 `supported_in_api: false` 的条目；
 *   - 返回形状与 `import-models.ts` 的 `RemoteModel` 对齐，路由层不用分支改写响应。
 *
 * 只读、8 秒超时、错误信息不含 token —— 与 probe / import-models 同一套安全纪律。
 */
import { DEFAULT_CODEX_BASE_URL } from "./codex-test.js";
import { accountIdFromToken } from "./codex-test.js";
import type { RemoteListResult, RemoteModel } from "./import-models.js";

/**
 * 报给后端的 Codex 客户端版本。
 * 这是一个**故意写在明处**的常量：它决定后端返回哪一批模型，改动前请先手工验证一次。
 */
const CODEX_CLIENT_VERSION = "1.0.0";

/** `{baseUrl}/codex/models`（baseUrl 可能带 /codex 或 /codex/responses 后缀） */
function modelsUrl(baseUrl: string | undefined, clientVersion: string): URL | null {
	const raw = (baseUrl && baseUrl.trim() !== "" ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	const root = raw.replace(/\/codex\/responses$/, "").replace(/\/codex$/, "");
	try {
		const url = new URL(`${root}/codex/models`);
		if (url.protocol !== "http:" && url.protocol !== "https:") return null;
		url.searchParams.set("client_version", clientVersion);
		return url;
	} catch {
		return null;
	}
}

export async function listCodexModels(options: {
	baseUrl?: string;
	access: string;
	accountId?: string | null;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<RemoteListResult> {
	const accountId = (options.accountId ?? "").trim() || accountIdFromToken(options.access);
	if (!accountId) return { ok: false, message: "订阅凭据里没有 chatgpt-account-id（重新登录一次）" };
	const url = modelsUrl(options.baseUrl, CODEX_CLIENT_VERSION);
	if (!url) return { ok: false, message: "baseUrl 不是合法 URL" };

	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
	try {
		const response = await doFetch(url.toString(), {
			method: "GET",
			headers: {
				originator: "pi",
				...options.headers,
				authorization: `Bearer ${options.access}`,
				"chatgpt-account-id": accountId,
				accept: "application/json",
			},
			signal: controller.signal,
		});
		if (!response.ok) {
			return {
				ok: false,
				message:
					response.status === 401 || response.status === 403
						? `${response.status}（订阅凭据无效或已过期：在「订阅服务」里重新登录一次即可续期）`
						: String(response.status),
			};
		}
		const body = (await response.json()) as { models?: unknown };
		const raw = Array.isArray(body.models) ? body.models : [];
		const models: RemoteModel[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			if (typeof item !== "object" || item === null) continue;
			const record = item as { slug?: unknown; visibility?: unknown; supported_in_api?: unknown };
			const id = typeof record.slug === "string" ? record.slug.trim() : "";
			if (id === "" || seen.has(id)) continue;
			if (record.visibility === "hide") continue;
			if (record.supported_in_api === false) continue;
			seen.add(id);
			models.push({ id, ownedBy: null });
		}
		models.sort((left, right) => left.id.localeCompare(right.id));
		return { ok: true, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "超时（8 秒内没有响应）" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}
