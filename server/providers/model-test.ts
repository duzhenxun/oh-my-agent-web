/**
 * 逐模型测试（ADR-0026 C 期）：发一次最小 chat completion。
 *
 * ⚠️ 这会**花钱**（一次请求），所以：
 *   - 界面按钮必须标注、并二次确认；
 *   - 请求体最小：max_tokens=1、单条 "ping"；
 *   - 只判「有没有正常返回」，不解析内容；
 *   - 失败只给状态码 / 类型，**不回显 key 与完整请求体**。
 */
export type ModelTestResult = { ok: true; status: number; latencyMs: number } | { ok: false; message: string };

export async function testModel(options: {
	baseUrl: string;
	apiKey: string;
	modelId: string;
	api?: string;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<ModelTestResult> {
	let url: URL;
	try {
		url = new URL(`${options.baseUrl.replace(/\/+$/, "")}/chat/completions`);
	} catch {
		return { ok: false, message: "baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只允许 http(s)" };

	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
	const started = Date.now();
	try {
		const response = await doFetch(url.toString(), {
			method: "POST",
			headers: { authorization: `Bearer ${options.apiKey}`, "content-type": "application/json" },
			body: JSON.stringify({ model: options.modelId, max_tokens: 1, messages: [{ role: "user", content: "ping" }] }),
			signal: controller.signal,
		});
		const latencyMs = Date.now() - started;
		if (response.ok) return { ok: true, status: response.status, latencyMs };
		const hint =
			response.status === 401 || response.status === 403
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
