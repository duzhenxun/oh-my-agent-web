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
export type ProbeResult = { ok: true; status: number; latencyMs: number } | { ok: false; message: string };

export async function probeProvider(options: {
	baseUrl: string;
	apiKey: string;
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
			headers: { authorization: `Bearer ${options.apiKey}` },
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
