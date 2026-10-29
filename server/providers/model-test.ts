/**
 * 逐模型测试（ADR-0026 C 期）：发一次最小 chat completion。
 *
 * ⚠️ 这会**花钱**（一次请求），所以：
 *   - 界面按钮必须标注、并二次确认；
 *   - 请求体最小：max_tokens=1、单条 "ping"；
 *   - 只判「有没有正常返回」，不解析内容；
 *   - 失败只给状态码 / 类型，**不回显 key 与完整请求体**。
 */
import { providerHeaders } from "./request-headers.js";

type ModelTestResult = { ok: true; status: number; latencyMs: number } | { ok: false; message: string };

export async function testModel(options: {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	api?: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<ModelTestResult> {
	const api = options.api ?? "openai-completions";
	/**
	 * 不同协议族的路径 / 请求体 / 鉴权头都不一样（pi 里由各家 SDK 分别拼接）：
	 *   - anthropic-messages → `{baseUrl}/v1/messages`，x-api-key；
	 *   - openai-responses → `{baseUrl}/responses`，Bearer；
	 *   - google-generative-ai → `{baseUrl}/models/<id>:generateContent`，x-goog-api-key；
	 *   - 其余 OpenAI 兼容族 → `{baseUrl}/chat/completions`，Bearer。
	 */
	const anthropic = api === "anthropic-messages";
	const responses = api === "openai-responses" || api === "openai-codex-responses";
	const google = api === "google-generative-ai";
	const base = options.baseUrl.replace(/\/+$/, "");
	let url: URL;
	try {
		const path = anthropic
			? "/v1/messages"
			: responses
				? "/responses"
				: google
					? `/models/${encodeURIComponent(options.modelId)}:generateContent`
					: "/chat/completions";
		url = new URL(`${base}${path}`);
	} catch {
		return { ok: false, message: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只允许 http(s)" };

	const payload = google
		? { contents: [{ parts: [{ text: "ping" }] }] }
		: responses
			? { model: options.modelId, input: "ping", max_output_tokens: 16 }
			: {
					model: options.modelId,
					max_tokens: anthropic ? 16 : 1,
					messages: [{ role: "user", content: "ping" }],
				};
	const authHeaders = google
		? { "x-goog-api-key": options.apiKey }
		: providerHeaders(api, options.apiKey, options.headers);
	/**
	 * OpenCode 网关要求带 `x-opencode-session`（pi 里由 withOpenCodeSessionHeader 自动加），
	 * 缺了会直接 400 MissingSessionID —— 试连得自己补一个，否则永远测不通。
	 */
	const sessionHeaders: Record<string, string> = /(^|\.)opencode\.ai$/.test(url.hostname)
		? { "x-opencode-session": `ses_probe_${options.modelId}`.replace(/[^\w-]/g, "_") }
		: {};

	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
	const started = Date.now();
	try {
		const response = await doFetch(url.toString(), {
			method: "POST",
			headers: { ...authHeaders, ...sessionHeaders, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal: controller.signal,
		});
		const latencyMs = Date.now() - started;
		if (response.ok) return { ok: true, status: response.status, latencyMs };
		/**
		 * 失败原因要按上游说的写：403 不一定是 key 不对
		 * （OpenCode 的 GPT 模型会回 403 unsupported_country_region_territory）。
		 * 只取错误码 / 一句话，不回显请求体。
		 */
		const upstream = await response.text().catch(() => "");
		const detail = upstreamError(upstream);
		const hint =
			detail !== ""
				? `（${detail}）`
				: response.status === 401
					? "（key 可能不对）"
					: response.status === 404
						? "（模型 id 或端点不对）"
						: "";
		return { ok: false, message: `${response.status}${hint}` };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "超时（20 秒内没有响应）" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}

/** 从上游错误体里抽一句人话（错误码优先）；抽不到就返回空串。 */
function upstreamError(body: string): string {
	const text = body.trim();
	if (text === "") return "";
	try {
		const parsed = JSON.parse(text) as {
			error?: { code?: unknown; type?: unknown; message?: unknown };
			message?: unknown;
		};
		const error = parsed.error;
		const code = typeof error?.code === "string" ? error.code : typeof error?.type === "string" ? error.type : "";
		const message =
			typeof error?.message === "string" ? error.message : typeof parsed.message === "string" ? parsed.message : "";
		const text2 = code !== "" ? code : message;
		return text2.slice(0, 80);
	} catch {
		return text.slice(0, 80);
	}
}
