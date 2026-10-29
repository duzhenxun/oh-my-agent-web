/**
 * provider 连通性测试（ADR-0025 B 期）。
 *
 * 只做一件事：拿保存好的 key 去 `GET {baseUrl}/models` 打一次，判断能不能通。
 * 为什么是 /models 而不是发一次 completion：这条路径不花钱、不改任何远端状态，
 * 且 OpenAI 兼容端点几乎都实现了它（我们默认的 api 形态就是 openai-completions）。
 *
 * 安全约束（都会被测试盯住）：
 *   - 只允许 http(s)（保存时已校验，这里再挡一次，防止旧文件里的脏数据）；
 *   - **超时**：8 秒，不让界面卡死；
 *   - **不泄露 key**：错误信息里只出现状态码 / 主机名，绝不出现 key 或完整 URL 的查询串。
 */
type ProbeResult = { ok: true; status: number; latencyMs: number } | { ok: false; message: string };

import { testModel } from "./model-test.js";
import { providerHeaders } from "./request-headers.js";

export async function probeProvider(options: {
	baseUrl: string;
	api?: string;
	apiKey: string;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<ProbeResult> {
	let url: URL;
	try {
		url = new URL(`${options.baseUrl.replace(/\/+$/, "")}/models`);
	} catch {
		return { ok: false, message: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只允许 http(s)" };

	const doFetch = options.fetchImpl ?? fetch;
	const started = Date.now();
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 8000);
	try {
		const response = await doFetch(url.toString(), {
			method: "GET",
			headers: providerHeaders(options.api ?? "openai-completions", options.apiKey, options.headers),
			signal: controller.signal,
		});
		const latencyMs = Date.now() - started;
		if (response.ok) return { ok: true, status: response.status, latencyMs };
		// 401/403 说明地址通但 key 不对；其余按状态码报
		return {
			ok: false,
			message: `${response.status}${response.status === 401 || response.status === 403 ? "（地址可达，key 可能不对）" : ""}`,
		};
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "超时（8 秒内没有响应）" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}

/**
 * 「保存前先验证」：把表单里**还没保存**的 baseUrl / 协议 / key / headers 拿去试一次。
 *
 * 两步：
 *   1. `GET /models` —— 验证地址可达、key 与鉴权头对不对（不花钱）；
 *   2. 给了 modelId 时再发一次最小 completion —— **这一步才真正验证协议**
 *      （有的网关 /models 能通，但 chat 不接受该协议），会花一次请求。
 */
type VerifyResult =
	| { ok: true; status: number; latencyMs: number; modelLatencyMs?: number }
	| { ok: false; step: "models" | "chat"; message: string };

export async function verifyProviderConfig(options: {
	baseUrl: string;
	api?: string;
	apiKey: string;
	headers?: Record<string, string>;
	modelId?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<VerifyResult> {
	const probe = await probeProvider({
		baseUrl: options.baseUrl,
		api: options.api,
		apiKey: options.apiKey,
		...(options.headers ? { headers: options.headers } : {}),
		...(options.timeoutMs === undefined ? {} : { timeoutMs: options.timeoutMs }),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
	});
	/**
	 * 404 = 这个网关没有 `/models`（OpenCode Go 就是这样：模型列表在 `/inference/v1/models`，
	 * 不在订阅端点下面）。这**不能**当作“配错了”：只要给了模型 id，就直接做协议测试，
	 * 让真正发请求的那一步说话。
	 */
	const noModelList = !probe.ok && /(^|\D)404(\D|$)/.test(probe.message);
	if (noModelList && options.modelId) {
		const chat = await testModel({
			baseUrl: options.baseUrl,
			api: options.api,
			apiKey: options.apiKey,
			modelId: options.modelId,
			...(options.headers ? { headers: options.headers } : {}),
			...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
		});
		if (!chat.ok) return { ok: false, step: "chat", message: chat.message };
		// 网关没有 /models：status 用协议测试的 200，不编造一个不存在的列表状态
		return { ok: true, status: chat.status ?? 200, latencyMs: chat.latencyMs, modelLatencyMs: chat.latencyMs };
	}
	if (!probe.ok) return { ok: false, step: "models", message: probe.message };
	if (!options.modelId) return { ok: true, status: probe.status ?? 200, latencyMs: probe.latencyMs };

	const chat = await testModel({
		baseUrl: options.baseUrl,
		api: options.api,
		apiKey: options.apiKey,
		modelId: options.modelId,
		...(options.headers ? { headers: options.headers } : {}),
		...(options.fetchImpl ? { fetchImpl: options.fetchImpl } : {}),
	});
	if (!chat.ok) return { ok: false, step: "chat", message: chat.message };
	return { ok: true, status: probe.status ?? 200, latencyMs: probe.latencyMs, modelLatencyMs: chat.latencyMs };
}
