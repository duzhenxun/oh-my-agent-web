/**
 * 导入模型（ADR-0026 B 期）：拉一次 `GET {baseUrl}/models` 拿远端可用模型清单。
 *
 * 约束与 probe 一致（安全同一套）：只允许 http(s)、8 秒超时、错误信息不含 key。
 * 刻意**只读**：这里不写任何配置，写盘由用户勾选后走 addModels。
 */
import { providerHeaders } from "./request-headers.js";

export type RemoteModel = { id: string; ownedBy: string | null };
export type RemoteListResult = { ok: true; models: RemoteModel[] } | { ok: false; message: string };

export async function listRemoteModels(options: {
	baseUrl: string;
	api?: string;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<RemoteListResult> {
	const root = options.baseUrl.replace(/\/+$/, "");
	// 有的网关 baseUrl 不带 /v1（例如 https://codeapi.nexita.net），/models 会 404；
	// 所以按 [/models, /v1/models] 依次试，第一次成功就用它。
	const candidates = [`${root}/models`, `${root}/v1/models`].filter(
		(value, index, all) => all.indexOf(value) === index,
	);
	let url: URL;
	try {
		url = new URL(candidates[0] ?? "");
	} catch {
		return { ok: false, message: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只允许 http(s)" };

	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
	try {
		const headers = providerHeaders(options.api ?? "openai-completions", options.apiKey, options.headers);
		let response = await doFetch(url.toString(), { method: "GET", headers, signal: controller.signal });
		for (const candidate of candidates.slice(1)) {
			if (response.status !== 404 && response.status !== 405) break;
			url = new URL(candidate);
			response = await doFetch(url.toString(), { method: "GET", headers, signal: controller.signal });
		}
		if (!response.ok) {
			return {
				ok: false,
				message: `${response.status}${response.status === 401 || response.status === 403 ? "（地址可达，key 可能不对）" : ""}`,
			};
		}
		const body: unknown = await response.json();
		// OpenAI 兼容端点是 { data: [{ id, owned_by }] }；也容忍直接给数组
		const raw = Array.isArray(body)
			? body
			: Array.isArray((body as { data?: unknown }).data)
				? (body as { data: unknown[] }).data
				: [];
		const models: RemoteModel[] = [];
		const seen = new Set<string>();
		for (const item of raw) {
			if (typeof item !== "object" || item === null) continue;
			const record = item as { id?: unknown; owned_by?: unknown };
			const id = typeof record.id === "string" ? record.id.trim() : "";
			if (id === "" || seen.has(id)) continue;
			seen.add(id);
			models.push({ id, ownedBy: typeof record.owned_by === "string" ? record.owned_by : null });
		}
		models.sort((a, b) => a.id.localeCompare(b.id));
		return { ok: true, models };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "超时（8 秒内没有响应）" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}
