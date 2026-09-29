/**
 * open-web-app — browser <-> server wire protocol.
 *
 * The browser talks to OUR server (not directly to codex). Our server is a thin,
 * transparent proxy in front of `codex app-server --listen ws://127.0.0.1:25258`:
 *
 *   browser  <--ws /ws-->  open-web-app server  <--ws-->  codex app-server
 *
 * Because the proxy is transparent, the browser may invoke ANY codex app-server
 * JSON-RPC method by name (`thread/start`, `turn/start`, `model/list`, ...) and
 * receives every codex notification verbatim. The names/types below therefore
 * mirror codex's own protocol; only the *envelope* is ours.
 *
 * Codex types can be regenerated with:
 *   codex app-server generate-ts --out shared/codex-ts
 *
 * Envelope rules
 * --------------
 * client -> server:
 *   { type: "rpc", requestId, method, params }   invoke a codex method (or `cw/*`)
 *   { type: "reply", id, result }                answer a serverRequest (approval, user input)
 *   { type: "reply", id, error }                 reject a serverRequest
 *   { type: "ping" }
 *
 * server -> client:
 *   { type: "welcome", ... }                     handshake, sent once per connection
 *   { type: "status", codex }                    supervisor state, on change
 *   { type: "rpcResult", requestId, ok, ... }    answer to our rpc
 *   { type: "event", method, params }            codex notification (verbatim)
 *   { type: "serverRequest", id, method, params }codex -> client request (verbatim)
 *   { type: "pong" }
 */

export const PROTOCOL_VERSION = 1;

/** JSON-RPC id as used by codex (`RequestId` in the generated bindings). */
export type RequestId = number | string;

export interface JsonRpcError {
	code: number;
	message: string;
	data?: unknown;
}

/* ------------------------------------------------------------------ */
/* client -> server                                                    */
/* ------------------------------------------------------------------ */

export type ClientMessage =
	| { type: "rpc"; requestId: string; method: string; params?: unknown }
	| { type: "reply"; id: RequestId; result: unknown }
	| { type: "reply"; id: RequestId; error: JsonRpcError }
	| { type: "ping" };

/* ------------------------------------------------------------------ */
/* server -> client                                                    */
/* ------------------------------------------------------------------ */

/** Lifecycle of the managed `codex app-server` child process. */
export type CodexPhase = "starting" | "ready" | "stopped" | "error";

export interface CodexStatus {
	phase: CodexPhase;
	/** ws:// endpoint the app-server listens on. */
	url: string;
	pid: number | null;
	/** True once initialize + WS handshake completed. */
	connected: boolean;
	/** Last supervisor error, if any. */
	error: string | null;
	/** ms timestamp of the last successful (re)connect. */
	since: number | null;
	/** Restart counter — grows on every respawn. */
	restarts: number;
}

export interface ServerInfo {
	version: string;
	protocolVersion: number;
	cwd: string;
	codexUrl: string;
	codexVersion: string | null;
	platform: NodeJS.Platform;
}

export type ServerMessage =
	| { type: "welcome"; info: ServerInfo }
	| { type: "status"; codex: CodexStatus }
	| { type: "rpcResult"; requestId: string; ok: true; result: unknown }
	| { type: "rpcResult"; requestId: string; ok: false; error: JsonRpcError }
	| { type: "event"; method: string; params: unknown }
	| { type: "serverRequest"; id: RequestId; method: string; params: unknown }
	| { type: "pong" };

/* ------------------------------------------------------------------ */
/* local (`cw/*`) methods — handled by OUR server, not proxied         */
/* ------------------------------------------------------------------ */

export const LOCAL_METHODS = {
	/** -> { status: CodexStatus } */
	codexStatus: "cw/codex/status",
	/** -> { ok: true } — kill + respawn the app-server */
	codexRestart: "cw/codex/restart",
	/** -> { lines: string[] } — tail of the app-server log */
	codexLog: "cw/codex/log",
	/** { threadId?: string, limit?: number } -> request/response summaries */
	requestLogsList: "cw/request-logs/list",
	/** { id: string } -> one full request/response exchange */
	requestLogsDetail: "cw/request-logs/detail",
	/** { path?: string } -> { path, entries: [{name,path,kind,size,mtime}] } */
	fsList: "cw/fs/list",
	/** { path: string, maxBytes?: number } -> { path, text, truncated } */
	fsRead: "cw/fs/read",
	/** -> { cwd, home, codexHome } */
	paths: "cw/paths",
} as const;

export interface FsEntry {
	name: string;
	path: string;
	kind: "file" | "directory" | "symlink" | "other";
	size: number;
	mtime: number;
}

export interface CwPaths {
	cwd: string;
	home: string;
	codexHome: string;
}

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

/* ------------------------------------------------------------------ */
/* codex method names we rely on — kept loose on purpose               */
/* ------------------------------------------------------------------ */

export const CODEX = {
	initialize: "initialize",
	threadStart: "thread/start",
	threadResume: "thread/resume",
	threadRead: "thread/read",
	threadList: "thread/list",
	threadDelete: "thread/delete",
	threadArchive: "thread/archive",
	threadUnarchive: "thread/unarchive",
	threadFork: "thread/fork",
	threadSetName: "thread/name/set",
	threadTurnsList: "thread/turns/list",
	threadItemsList: "thread/items/list",
	turnStart: "turn/start",
	turnSteer: "turn/steer",
	turnInterrupt: "turn/interrupt",
	modelList: "model/list",
	accountRead: "account/read",
	accountRateLimits: "account/rateLimits/read",
	getAuthStatus: "getAuthStatus",
	configRead: "config/read",
	fsReadFile: "fs/readFile",
	fsReadDirectory: "fs/readDirectory",
	fuzzyFileSearch: "fuzzyFileSearch",
} as const;

/** codex notification methods that the UI cares about most. */
export const CODEX_EVENTS = {
	threadStarted: "thread/started",
	threadStatusChanged: "thread/status/changed",
	threadNameUpdated: "thread/name/updated",
	turnStarted: "turn/started",
	turnCompleted: "turn/completed",
	turnDiffUpdated: "turn/diff/updated",
	turnPlanUpdated: "turn/plan/updated",
	itemStarted: "item/started",
	itemCompleted: "item/completed",
	agentMessageDelta: "item/agentMessage/delta",
	reasoningSummaryDelta: "item/reasoning/summaryTextDelta",
	reasoningTextDelta: "item/reasoning/textDelta",
	planDelta: "item/plan/delta",
	commandOutputDelta: "item/commandExecution/outputDelta",
	fileChangeDelta: "item/fileChange/outputDelta",
	mcpProgress: "item/mcpToolCall/progress",
	tokenUsage: "thread/tokenUsage/updated",
	error: "error",
} as const;

/** codex server -> client request methods (need a `reply`). */
export const CODEX_REQUESTS = {
	commandApproval: "item/commandExecution/requestApproval",
	fileChangeApproval: "item/fileChange/requestApproval",
	permissionsApproval: "item/permissions/requestApproval",
	toolInput: "item/tool/requestUserInput",
	elicitation: "mcpServer/elicitation/request",
	dynamicToolCall: "item/tool/call",
} as const;
