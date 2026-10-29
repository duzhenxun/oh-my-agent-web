/**
 * Codex（`openai-codex`，也就是界面上的「OpenAI Codex (legacy)」）的连通性测试。
 *
 * 为什么不能复用 `probe.ts` / `model-test.ts`：
 *   - 订阅登录写进 auth.json 的是 **OAuth access token**，不是 API key（`provider.no_key` 就是这么冒出来的）；
 *   - ChatGPT 后端没有 `/models`、也没有 `/chat/completions`，只有 `POST {baseUrl}/codex/responses`；
 *   - 鉴权除了 `Authorization: Bearer <access>` 还必须带 `chatgpt-account-id`（订阅账号 id），
 *     否则一律 401/403。
 *
 * 请求头 / 请求体形状照抄 pi 自己的 `openai-codex-responses` 实现（originator / OpenAI-Beta /
 * Responses API 体），差别只有一处：这里是**一次性探测**，拿到 200 就把流掐掉，
 * 不等模型把话说（省钱、也不改任何远端状态）。
 */
import { randomUUID } from "node:crypto";

type CodexTestResult = { ok: true; status: number; latencyMs: number } | { ok: false; message: string };

/** pi 的 codex 默认端点（baseUrl 没配时的兜底） */
export const DEFAULT_CODEX_BASE_URL = "https://chatgpt.com/backend-api";

/** `{baseUrl}/codex/responses`（与 pi 的 resolveCodexUrl 一致：baseUrl 可能已经带 /codex） */
function resolveCodexUrl(baseUrl: string | undefined): URL | null {
	const raw = (baseUrl && baseUrl.trim() !== "" ? baseUrl.trim() : DEFAULT_CODEX_BASE_URL).replace(/\/+$/, "");
	const full = raw.endsWith("/codex/responses")
		? raw
		: raw.endsWith("/codex")
			? `${raw}/responses`
			: `${raw}/codex/responses`;
	try {
		const url = new URL(full);
		return url.protocol === "http:" || url.protocol === "https:" ? url : null;
	} catch {
		return null;
	}
}

/**
 * 从 JWT 里取 `chatgpt_account_id`（auth.json 没存 accountId 时的兜底）。
 * 解不开就返回 null —— 调用方据此给一句人话，而不是抛错。
 */
export function accountIdFromToken(token: string): string | null {
	const parts = token.split(".");
	if (parts.length !== 3 || !parts[1]) return null;
	try {
		const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf8")) as Record<string, unknown>;
		const auth = payload["https://api.openai.com/auth"] as { chatgpt_account_id?: unknown } | undefined;
		const id = auth?.chatgpt_account_id;
		return typeof id === "string" && id !== "" ? id : null;
	} catch {
		return null;
	}
}

/** 401/403/429 的失败原因：只留状态码与一句提示，**不回显 token 与请求体** */
function describeFailure(status: number, body: string): string {
	if (status === 401 || status === 403)
		return `${status}（订阅凭据无效或已过期：在「订阅服务」里重新登录一次即可续期）`;
	if (status === 429) return "429（订阅额度用完了或限流，稍后再试）";
	let detail = "";
	try {
		const parsed = JSON.parse(body) as { error?: { message?: unknown; code?: unknown }; message?: unknown };
		const message = parsed.error?.message ?? parsed.message;
		if (typeof message === "string") detail = message;
	} catch {
		detail = body.replace(/\s+/g, " ").slice(0, 80);
	}
	return detail === "" ? String(status) : `${status}（${detail.slice(0, 100)}）`;
}

export async function testCodex(options: {
	baseUrl?: string;
	modelId: string;
	access: string;
	accountId?: string | null;
	headers?: Record<string, string>;
	timeoutMs?: number;
	fetchImpl?: typeof fetch;
}): Promise<CodexTestResult> {
	// 注意：**不**在这里根据 expires 提前判死。access token 过期后 pi 会在真正调用时用 refresh token 换新的，
	// auth.json 随即更新；提前拒绝反而会把「其实能用」报成失败。真过期了就是 401/403，文案里会提。
	const accountId = (options.accountId ?? "").trim() || accountIdFromToken(options.access);
	if (!accountId) {
		return { ok: false, message: "订阅凭据里没有 chatgpt-account-id（重新登录一次）" };
	}
	const url = resolveCodexUrl(options.baseUrl);
	if (!url) return { ok: false, message: "baseUrl 不是合法 URL" };

	const requestId = randomUUID();
	const doFetch = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 20_000);
	const started = Date.now();
	try {
		const response = await doFetch(url.toString(), {
			method: "POST",
			headers: {
				originator: "pi",
				...options.headers,
				authorization: `Bearer ${options.access}`,
				"chatgpt-account-id": accountId,
				"OpenAI-Beta": "responses=experimental",
				accept: "text/event-stream",
				"content-type": "application/json",
				"session-id": requestId,
				"x-client-request-id": requestId,
			},
			body: JSON.stringify({
				model: options.modelId,
				store: false,
				stream: true,
				instructions: "You are a helpful assistant.",
				input: [{ type: "message", role: "user", content: [{ type: "input_text", text: "ping" }] }],
				text: { verbosity: "low" },
			}),
			signal: controller.signal,
		});
		const latencyMs = Date.now() - started;
		if (response.ok) {
			// 只要「能开始回答」就够了：把流掐掉，别等它把话说完
			await response.body?.cancel().catch(() => undefined);
			return { ok: true, status: response.status, latencyMs };
		}
		const text = await response.text().catch(() => "");
		return { ok: false, message: describeFailure(response.status, text) };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "超时（20 秒内没有响应）" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}
