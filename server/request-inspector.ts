/**
 * Local Responses API proxy and request/response recorder.
 *
 * Codex app-server talks to this loopback proxy when it is managed by the UI.
 * The proxy forwards the request to the real Codex endpoint while keeping a
 * redacted, thread-aware copy of the exchange for the session log drawer.
 */
import { createServer, type IncomingMessage, type Server as HttpServer, type ServerResponse } from "node:http";
import { chmod, mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_UPSTREAM = "https://chatgpt.com/backend-api/codex";
const DEFAULT_MAX_BODY = 16 * 1024 * 1024;
const HISTORY_LIMIT = 400;
const REQUEST_TIMEOUT_MS = 15 * 60 * 1000;

export interface RequestLogSummary {
	id: string;
	startedAt: string;
	status: number | null;
	model: string | null;
	durationMs: number | null;
	requestBytes: number;
	responseBytes: number;
	error: string | null;
	threadId: string;
	turnId: string;
	source: string;
	trigger: string;
	internal: boolean;
	question: string;
	answer: string;
	reasoning: string;
	tools: string[];
	usage: Record<string, unknown> | null;
	tokens: {
		input: number;
		cached: number;
		cacheWrite: number;
		output: number;
		reasoning: number;
	};
}

export interface RequestLogDetail extends RequestLogSummary {
	requestHeaders: Record<string, string>;
	responseHeaders: Record<string, string>;
	requestBody: string;
	responseBody: string;
	responseTruncated: boolean;
}

interface ExchangeRecord {
	id: string;
	startedAt: string;
	method: string;
	path: string;
	_ids: {
		threadId: string;
		turnId: string;
		source: string;
		trigger: string;
		internal: boolean;
	};
	_question: string;
	requestHeaders: Record<string, string>;
	requestBody: string;
	requestBytes: number;
	status: number | null;
	responseHeaders: Record<string, string>;
	responseBody: string;
	responseBytes: number;
	responseTruncated: boolean;
	durationMs: number | null;
	error: string | null;
	model: string | null;
}

interface InspectorOptions {
	upstream?: string;
	dataDir: string;
	maxBody?: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function asString(value: unknown): string {
	return typeof value === "string" ? value : "";
}

function headerValue(headers: IncomingMessage["headers"], name: string): string {
	const value = headers[name.toLowerCase()];
	return Array.isArray(value) ? value.join(", ") : value ?? "";
}

function redactedHeaders(headers: Record<string, string>): Record<string, string> {
	const secret = /(authorization|cookie|token|secret|password|api[-_]?key)/i;
	return Object.fromEntries(
		Object.entries(headers).map(([key, value]) => {
			if (!secret.test(key)) return [key.toLowerCase(), value];
			const redacted = key.toLowerCase() === "authorization" && value.length > 12 ? `${value.slice(0, 7)}****${value.slice(-4)}` : "[REDACTED]";
			return [key.toLowerCase(), redacted];
		}),
	);
}

function incomingHeaders(headers: IncomingMessage["headers"]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const [key, value] of Object.entries(headers)) {
		if (value === undefined) continue;
		result[key.toLowerCase()] = Array.isArray(value) ? value.join(", ") : value;
	}
	return result;
}

function now(): string {
	return new Date().toISOString();
}

function clip(value: string, max: number): { value: string; truncated: boolean } {
	if (value.length <= max) return { value, truncated: false };
	return { value: value.slice(0, max), truncated: true };
}

function parseJson(value: string): Record<string, unknown> {
	try {
		const parsed: unknown = JSON.parse(value || "{}");
		return isRecord(parsed) ? parsed : {};
	} catch {
		return {};
	}
}

function extractQuestion(body: string): string {
	const obj = parseJson(body);
	const input = obj.input;
	if (typeof input === "string") return input.slice(0, 4000);
	if (!Array.isArray(input)) return "";
	for (let i = input.length - 1; i >= 0; i -= 1) {
		const entry = input[i];
		if (!isRecord(entry) || entry.role !== "user") continue;
		const content = entry.content;
		let text = "";
		if (typeof content === "string") text = content;
		else if (Array.isArray(content)) {
			text = content
				.filter(isRecord)
				.map((item) => asString(item.text))
				.join("");
		}
		text = text.trim();
		if (text && !text.startsWith("<environment_context")) return text.slice(0, 4000);
	}
	return "";
}

function extractIds(headers: Record<string, string>): ExchangeRecord["_ids"] {
	let meta: Record<string, unknown> = {};
	try {
		const parsed: unknown = JSON.parse(headers["x-codex-turn-metadata"] ?? "{}");
		if (isRecord(parsed)) meta = parsed;
	} catch {
		/* metadata is optional */
	}
	const threadId = asString(meta.thread_id) || headers["thread-id"] || headers["session-id"] || "unknown-session";
	const turnId = asString(meta.turn_id) || threadId;
	const source = asString(meta.thread_source);
	const trigger = asString(meta.turn_trigger);
	return {
		threadId,
		turnId,
		source,
		trigger,
		internal: Boolean(headers["x-openai-memgen-request"]) || source === "automation" || source === "memory_consolidation" || source === "guardian_review" || source === "system" || source === "thread_title" || trigger.startsWith("automation"),
	};
}

function sseEvents(body: string): Record<string, unknown>[] {
	const events: Record<string, unknown>[] = [];
	for (const block of body.split(/\n\s*\n/)) {
		let data = "";
		for (const line of block.split(/\r?\n/)) {
			if (line.startsWith("data:")) data = line.slice(5).trim();
		}
		if (!data || data === "[DONE]") continue;
		try {
			const value: unknown = JSON.parse(data);
			if (isRecord(value)) events.push(value);
		} catch {
			/* An incomplete SSE event is normal while a request is streaming. */
		}
	}
	return events;
}

function extractStream(body: string): Pick<RequestLogSummary, "answer" | "reasoning" | "tools" | "usage"> {
	const answer: string[] = [];
	const reasoning: string[] = [];
	const tools: string[] = [];
	let usage: Record<string, unknown> | null = null;
	for (const event of sseEvents(body)) {
		const type = asString(event.type);
		if (type === "response.output_text.delta") answer.push(asString(event.delta));
		else if (type === "response.reasoning_summary_text.delta") reasoning.push(asString(event.delta));
		else if (type === "response.output_item.done" && isRecord(event.item)) {
			const itemType = asString(event.item.type);
			if (["function_call", "custom_tool_call", "local_shell_call", "mcp_call"].includes(itemType)) {
				tools.push(asString(event.item.name) || itemType);
			}
		} else if (type === "response.completed" && isRecord(event.response) && isRecord(event.response.usage)) {
			usage = event.response.usage;
		}
	}
	return { answer: answer.join(""), reasoning: reasoning.join(""), tools, usage };
}

function tokenSummary(usage: Record<string, unknown> | null): RequestLogSummary["tokens"] {
	const inputDetails = isRecord(usage?.input_tokens_details) ? usage.input_tokens_details : {};
	const outputDetails = isRecord(usage?.output_tokens_details) ? usage.output_tokens_details : {};
	const numberValue = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);
	return {
		input: numberValue(usage?.input_tokens),
		cached: numberValue(inputDetails.cached_tokens),
		cacheWrite: numberValue(inputDetails.cache_write_tokens),
		output: numberValue(usage?.output_tokens),
		reasoning: numberValue(outputDetails.reasoning_tokens),
	};
}

function modelFromBody(body: string): string | null {
	const value = parseJson(body).model;
	return typeof value === "string" ? value : null;
}

function summarize(item: ExchangeRecord): RequestLogSummary {
	const stream = extractStream(item.responseBody);
	return {
		id: item.id,
		startedAt: item.startedAt,
		status: item.status,
		model: item.model,
		durationMs: item.durationMs,
		requestBytes: item.requestBytes,
		responseBytes: item.responseBytes,
		error: item.error,
		threadId: item._ids.threadId,
		turnId: item._ids.turnId,
		source: item._ids.source,
		trigger: item._ids.trigger,
		internal: item._ids.internal,
		question: item._question,
		answer: stream.answer.slice(-8000),
		reasoning: stream.reasoning.slice(-4000),
		tools: stream.tools,
		usage: stream.usage,
		tokens: tokenSummary(stream.usage),
	};
}

function detail(item: ExchangeRecord): RequestLogDetail {
	return {
		...summarize(item),
		requestHeaders: item.requestHeaders,
		responseHeaders: item.responseHeaders,
		requestBody: item.requestBody,
		responseBody: item.responseBody,
		responseTruncated: item.responseTruncated,
	};
}

function exchangeFromJson(value: unknown): ExchangeRecord | null {
	if (!isRecord(value) || typeof value.id !== "string") return null;
	const ids = isRecord(value._ids) ? value._ids : {};
	return {
		id: value.id,
		startedAt: asString(value.startedAt) || asString(value.started_at),
		method: asString(value.method) || "POST",
		path: asString(value.path) || "/responses",
		_ids: {
			threadId: asString(ids.threadId) || asString(ids.thread_id) || asString(value.threadId) || asString(value.thread_id) || "unknown-session",
			turnId: asString(ids.turnId) || asString(ids.turn_id) || asString(value.turnId) || asString(value.turn_id) || "",
			source: asString(ids.source) || asString(value.source),
			trigger: asString(ids.trigger) || asString(value.trigger),
			internal: ids.internal === true || value.internal === true,
		},
		_question: asString(value._question) || asString(value.question),
		requestHeaders: isRecord(value.requestHeaders) ? Object.fromEntries(Object.entries(value.requestHeaders).map(([k, v]) => [k, asString(v)])) : isRecord(value.request_headers) ? Object.fromEntries(Object.entries(value.request_headers).map(([k, v]) => [k, asString(v)])) : {},
		requestBody: asString(value.requestBody) || asString(value.request_body),
		requestBytes: typeof value.requestBytes === "number" ? value.requestBytes : typeof value.request_bytes === "number" ? value.request_bytes : 0,
		status: typeof value.status === "number" ? value.status : null,
		responseHeaders: isRecord(value.responseHeaders) ? Object.fromEntries(Object.entries(value.responseHeaders).map(([k, v]) => [k, asString(v)])) : isRecord(value.response_headers) ? Object.fromEntries(Object.entries(value.response_headers).map(([k, v]) => [k, asString(v)])) : {},
		responseBody: asString(value.responseBody) || asString(value.response_body),
		responseBytes: typeof value.responseBytes === "number" ? value.responseBytes : typeof value.response_bytes === "number" ? value.response_bytes : 0,
		responseTruncated: value.responseTruncated === true || value.response_truncated === true,
		durationMs: typeof value.durationMs === "number" ? value.durationMs : typeof value.duration_ms === "number" ? value.duration_ms : null,
		error: typeof value.error === "string" ? value.error : null,
		model: typeof value.model === "string" ? value.model : modelFromBody(asString(value.requestBody) || asString(value.request_body)),
	};
}

async function readRequestBody(req: IncomingMessage): Promise<Buffer<ArrayBufferLike>> {
	const chunks: Buffer[] = [];
	for await (const chunk of req) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
	return Buffer.concat(chunks);
}

function copyableHeaders(headers: Record<string, string>): Record<string, string> {
	return Object.fromEntries(Object.entries(headers).filter(([key]) => !["host", "connection", "content-length", "transfer-encoding"].includes(key.toLowerCase())));
}

function jsonResponse(res: ServerResponse, status: number, value: unknown): void {
	const body = Buffer.from(JSON.stringify(value));
	res.statusCode = status;
	res.setHeader("content-type", "application/json; charset=utf-8");
	res.setHeader("content-length", body.length);
	res.end(body);
}

export class RequestInspector {
	private readonly upstream: string;
	private readonly dataDir: string;
	private readonly maxBody: number;
	private readonly live = new Map<string, ExchangeRecord>();
	private server: HttpServer | null = null;
	private baseUrl = "";

	constructor(options: InspectorOptions) {
		this.upstream = (options.upstream || process.env.OMAW_CODEX_UPSTREAM || DEFAULT_UPSTREAM).replace(/\/$/, "");
		this.dataDir = options.dataDir;
		this.maxBody = options.maxBody ?? Number(process.env.OMAW_LOG_MAX_BODY ?? DEFAULT_MAX_BODY);
	}

	async start(host = "127.0.0.1"): Promise<string> {
		if (this.server) return this.baseUrl;
		await mkdir(this.dataDir, { recursive: true, mode: 0o700 });
		this.server = createServer((req, res) => {
			void this.handle(req, res).catch((error) => {
				if (!res.headersSent) jsonResponse(res, 502, { error: error instanceof Error ? error.message : String(error) });
				else res.destroy();
			});
		});
		await new Promise<void>((resolve, reject) => {
			this.server?.once("error", reject);
			this.server?.listen(0, host, resolve);
		});
		const address = this.server.address();
		if (!address || typeof address === "string") throw new Error("request inspector failed to bind");
		this.baseUrl = `http://${host}:${address.port}`;
		return this.baseUrl;
	}

	async close(): Promise<void> {
		const server = this.server;
		this.server = null;
		if (!server) return;
		await new Promise<void>((resolve) => server.close(() => resolve()));
	}

	url(): string {
		return this.baseUrl;
	}

	async list(threadId?: string, limit = HISTORY_LIMIT): Promise<RequestLogSummary[]> {
		const rows: ExchangeRecord[] = [];
		for (const item of this.live.values()) {
			if (!threadId || item._ids.threadId === threadId) rows.push(item);
		}
		try {
			const days = (await readdir(this.dataDir)).sort().reverse();
			for (const day of days) {
				const folder = join(this.dataDir, day);
				if (!(await stat(folder).catch(() => null))?.isDirectory()) continue;
				const names = (await readdir(folder)).filter((name) => name.endsWith(".json")).sort().reverse();
				for (const name of names) {
					const parsed = exchangeFromJson(JSON.parse(await readFile(join(folder, name), "utf8")));
					if (parsed && (!threadId || parsed._ids.threadId === threadId)) rows.push(parsed);
				}
			}
		} catch {
			/* The log directory may not exist yet. */
		}
		return rows
			.sort((a, b) => b.startedAt.localeCompare(a.startedAt))
			.slice(0, Math.max(1, Math.min(limit, HISTORY_LIMIT)))
			.map(summarize);
	}

	async get(id: string): Promise<RequestLogDetail | null> {
		const live = this.live.get(id);
		if (live) return detail(live);
		try {
			const days = (await readdir(this.dataDir)).sort().reverse();
			for (const day of days) {
				const file = join(this.dataDir, day, `${id}.json`);
				if (!(await stat(file).catch(() => null))?.isFile()) continue;
				const parsed = exchangeFromJson(JSON.parse(await readFile(file, "utf8")));
				return parsed ? detail(parsed) : null;
			}
		} catch {
			return null;
		}
		return null;
	}

	private async handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
		const parsed = new URL(req.url ?? "/", this.baseUrl || "http://127.0.0.1");
		if (req.method === "OPTIONS") {
			res.statusCode = 204;
			res.end();
			return;
		}
		if (req.method !== "GET" && req.method !== "POST") {
			jsonResponse(res, 405, { error: "method not allowed" });
			return;
		}
		let body: Buffer<ArrayBufferLike> = Buffer.alloc(0);
		if (req.method === "POST") body = await readRequestBody(req);
		const target = `${this.upstream}${parsed.pathname}${parsed.search}`;
		const headers = incomingHeaders(req.headers);
		const requestHeaders = redactedHeaders(headers);

		// GET /models and similar discovery calls are proxied but not recorded as
		// session exchanges; only POST responses contain a user turn.
		if (req.method !== "POST") {
			await this.forward(target, req.method, headers, body, res);
			return;
		}

		const requestBody = body.toString("utf8");
		const clippedRequest = clip(requestBody, this.maxBody);
		const ids = extractIds(headers);
		const id = `${new Date().toISOString().replace(/[-:.TZ]/g, "").slice(0, 12)}-${randomUUID().slice(0, 6)}`;
		const item: ExchangeRecord = {
			id,
			startedAt: now(),
			method: req.method,
			path: parsed.pathname,
			_ids: ids,
			_question: extractQuestion(requestBody),
			requestHeaders,
			requestBody: clippedRequest.value,
			requestBytes: body.length,
			status: null,
			responseHeaders: {},
			responseBody: "",
			responseBytes: 0,
			responseTruncated: false,
			durationMs: null,
			error: null,
			model: modelFromBody(requestBody),
		};
		this.live.set(id, item);
		try {
			await this.forward(target, req.method, headers, body, res, item);
		} catch (error) {
			item.status = 502;
			item.error = error instanceof Error ? error.message : String(error);
			if (!res.headersSent) jsonResponse(res, 502, { error: item.error });
		} finally {
			item.durationMs = Date.now() - Date.parse(item.startedAt);
			this.live.delete(id);
			await this.persist(item);
		}
	}

	private async forward(target: string, method: string, headers: Record<string, string>, body: Buffer<ArrayBufferLike>, res: ServerResponse, item?: ExchangeRecord): Promise<void> {
		const response = await fetch(target, {
			method,
			headers: copyableHeaders(headers),
			body: method === "POST" ? new Uint8Array(body) : undefined,
			signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
		});
		if (item) {
			item.status = response.status;
			response.headers.forEach((value, key) => { item.responseHeaders[key] = value; });
		}
		res.statusCode = response.status;
		response.headers.forEach((value, key) => {
			if (!["content-length", "transfer-encoding", "connection", "content-encoding"].includes(key.toLowerCase())) res.setHeader(key, value);
		});
		res.flushHeaders();
		if (!response.body) {
			res.end();
			return;
		}
		const reader = response.body.getReader();
		const captured: Buffer[] = [];
		let capturedBytes = 0;
		try {
			while (true) {
				const next = await reader.read();
				if (next.done) break;
				const chunk = Buffer.from(next.value);
				res.write(chunk);
				if (item) {
					item.responseBytes += chunk.length;
					if (capturedBytes < this.maxBody) {
						const part = chunk.subarray(0, Math.max(0, this.maxBody - capturedBytes));
						captured.push(part);
						capturedBytes += part.length;
						item.responseBody = Buffer.concat(captured).toString("utf8");
						item.responseTruncated = item.responseTruncated || capturedBytes < item.responseBytes;
					}
				}
			}
		} finally {
			reader.releaseLock();
		}
		res.end();
	}

	private async persist(item: ExchangeRecord): Promise<void> {
		const folder = join(this.dataDir, new Date().toISOString().slice(0, 10));
		await mkdir(folder, { recursive: true, mode: 0o700 });
		const path = join(folder, `${item.id}.json`);
		await writeFile(path, JSON.stringify(item, null, 2), { encoding: "utf8", mode: 0o600 });
		await chmod(path, 0o600).catch(() => undefined);
	}
}
