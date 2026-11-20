/**
 * 一次性文本补全（直连 provider HTTP）：**不经过任何 agent 会话**。
 *
 * 用途：「AI 起名」「AI 生成提示词」「想想」这三处只想要一段文本，
 * 不需要工具、不需要历史、不需要审批 —— 走引擎回合既慢又会把请求写进对话记录。
 *
 * 四个协议族的路径 / 请求体 / 取值位置都不一样（与 `model-test.ts` 同一套判断），
 * 但这里要**收正文**，所以每个分支各自取文本。
 */
import { providerHeaders } from "./request-headers.js";
import { accountIdFromToken } from "./codex-test.js";

export type OneShotInput = {
	/** 协议族：openai-completions / anthropic-messages / openai-responses / google-generative-ai */
	api: string;
	baseUrl: string;
	modelId: string;
	/** apiKey 或订阅登录的 access token（调用方负责从 providerStore 取） */
	credential: string;
	/** 订阅登录的账号 id（openai-codex 必需，缺了会 401/403） */
	accountId?: string | null;
	headers?: Record<string, string>;
	system: string;
	prompt: string;
	timeoutMs?: number;
	signal?: AbortSignal;
	maxTokens?: number;
	fetchImpl?: typeof fetch;
};

export type OneShotResult = { ok: true; text: string } | { ok: false; message: string };

export async function completeOnce(input: OneShotInput): Promise<OneShotResult> {
	const anthropic = input.api === "anthropic-messages";
	const codex = input.api === "openai-codex-responses";
	const responses = input.api === "openai-responses" || codex;
	const google = input.api === "google-generative-ai";
	const base = input.baseUrl.replace(/\/+$/, "");
	let url: URL;
	try {
		const path = anthropic
			? "/v1/messages"
			: codex
				? "/codex/responses"
				: responses
					? "/responses"
					: google
						? `/models/${encodeURIComponent(input.modelId)}:generateContent`
						: "/chat/completions";
		url = new URL(`${base}${path}`);
	} catch {
		return { ok: false, message: "这个 provider 的 baseUrl 不是合法 URL" };
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return { ok: false, message: "只允许 http(s) 端点" };

	const maxTokens = input.maxTokens ?? 1024;
	const payload = google
		? {
				systemInstruction: { parts: [{ text: input.system }] },
				contents: [{ role: "user", parts: [{ text: input.prompt }] }],
				generationConfig: { maxOutputTokens: maxTokens },
			}
		: codex
			? {
					model: input.modelId,
					store: false,
					stream: true,
					instructions: input.system,
					input: [{ type: "message", role: "user", content: [{ type: "input_text", text: input.prompt }] }],
					text: { verbosity: "low" },
				}
			: responses
				? {
						model: input.modelId,
						instructions: input.system,
						input: input.prompt,
						max_output_tokens: maxTokens,
					}
			: {
					model: input.modelId,
					max_tokens: maxTokens,
					...(anthropic
						? { system: input.system, messages: [{ role: "user", content: input.prompt }] }
						: {
								messages: [
									{ role: "system", content: input.system },
									{ role: "user", content: input.prompt },
								],
							}),
				};

	const codexHeaders: Record<string, string> = codex
		? (() => {
				const accountId = (input.accountId ?? "").trim() || accountIdFromToken(input.credential) || "";
				return {
					originator: "pi",
					"OpenAI-Beta": "responses=experimental",
					accept: "text/event-stream",
					...(accountId !== "" ? { "chatgpt-account-id": accountId } : {}),
				};
			})()
		: {};
	const authHeaders = google
		? { "x-goog-api-key": input.credential }
		: providerHeaders(input.api, input.credential, { ...codexHeaders, ...input.headers });
	// OpenCode 网关缺这个头会直接 400 MissingSessionID（见 model-test.ts 同款处理）
	const sessionHeaders: Record<string, string> = /(^|\.)opencode\.ai$/.test(url.hostname)
		? { "x-opencode-session": "ses_oneshot" }
		: {};

	const controller = new AbortController();
	const signal = input.signal ? AbortSignal.any([input.signal, controller.signal]) : controller.signal;
	const timer = setTimeout(() => controller.abort(), input.timeoutMs ?? 45_000);
	try {
		const response = await (input.fetchImpl ?? fetch)(url.toString(), {
			method: "POST",
			headers: { ...authHeaders, ...sessionHeaders, "content-type": "application/json" },
			body: JSON.stringify(payload),
			signal,
		});
		if (!response.ok) {
			const body = await response.text().catch(() => "");
			return { ok: false, message: `${response.status}${upstreamHint(body)}` };
		}
		// codex 的 ChatGPT 后端只吐事件流：正文在 response.output_text.delta 里
		const text = codex && response.body ? await readSseText(response.body) : extractText(await response.text().catch(() => ""), { anthropic, responses, google });
		if (text.trim() === "") return { ok: false, message: "模型返回了空内容" };
		return { ok: true, text };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return { ok: false, message: /abort/i.test(message) ? "请求超时" : `请求失败：${url.host}` };
	} finally {
		clearTimeout(timer);
	}
}

/** 按协议从响应体里取正文（取不到就空串，让上层报「空内容」） */
function extractText(raw: string, kind: { anthropic: boolean; responses: boolean; google: boolean }): string {
	let parsed: unknown;
	try {
		parsed = JSON.parse(raw);
	} catch {
		return "";
	}
	const body = parsed as Record<string, unknown>;
	if (kind.google) {
		const candidates = body.candidates as { content?: { parts?: { text?: unknown }[] } }[] | undefined;
		return (candidates?.[0]?.content?.parts ?? [])
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
	}
	if (kind.anthropic) {
		const content = body.content as { type?: unknown; text?: unknown }[] | undefined;
		return (content ?? []).map((part) => (typeof part.text === "string" ? part.text : "")).join("");
	}
	if (kind.responses) {
		if (typeof body.output_text === "string") return body.output_text;
		const output = body.output as { content?: { text?: unknown }[] }[] | undefined;
		return (output ?? [])
			.flatMap((item) => item.content ?? [])
			.map((part) => (typeof part.text === "string" ? part.text : ""))
			.join("");
	}
	const choices = body.choices as { message?: { content?: unknown } }[] | undefined;
	const content = choices?.[0]?.message?.content;
	if (typeof content === "string") return content;
	// 少数兼容层回的是分段数组
	if (Array.isArray(content)) {
		return content
			.map((part) =>
				typeof (part as { text?: unknown })?.text === "string" ? String((part as { text: string }).text) : "",
			)
			.join("");
	}
	return "";
}

/** 从上游错误体里抽一句人话（错误码 / message 优先），不回显 key */
function upstreamHint(body: string): string {
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
		const hint = code !== "" ? code : message;
		return hint === "" ? "" : `（${hint.slice(0, 80)}）`;
	} catch {
		return `（${text.slice(0, 80)}）`;
	}
}

/**
 * 读 Responses 的事件流，拼接 `response.output_text.delta`。
 *
 * 只认正文增量：思考（`reasoning_summary_*`）与工具调用一律丢掉 ——
 * 这三处要的就是一段干净文本，混进思考摘要反而更难用。
 */
async function readSseText(stream: ReadableStream<Uint8Array>): Promise<string> {
	const reader = stream.getReader();
	const decoder = new TextDecoder();
	let buffer = "";
	let text = "";
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			buffer += decoder.decode(value, { stream: true });
			const lines = buffer.split("\n");
			buffer = lines.pop() ?? "";
			for (const line of lines) {
				const trimmed = line.trim();
				if (!trimmed.startsWith("data:")) continue;
				const data = trimmed.slice(5).trim();
				if (data === "" || data === "[DONE]") continue;
				try {
					const event = JSON.parse(data) as { type?: unknown; delta?: unknown; text?: unknown };
					if (event.type === "response.output_text.delta" && typeof event.delta === "string") text += event.delta;
					else if (event.type === "response.output_text.done" && typeof event.text === "string") text ||= event.text;
				} catch {
					// 半截 JSON / 注释行：跳过
				}
			}
		}
	} finally {
		reader.releaseLock();
	}
	return text;
}
