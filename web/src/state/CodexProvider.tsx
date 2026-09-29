// CodexProvider — owns the WebSocket, the thread/turn transcript state, and all
// actions the UI calls. Streaming deltas are coalesced outside React and flushed
// once per animation frame so a fast turn cannot jank the UI.

import {
	createContext,
	useCallback,
	useContext,
	useEffect,
	useMemo,
	useReducer,
	useRef,
	useState,
	type ReactNode,
} from "react";
import { CODEX, CODEX_EVENTS, CODEX_REQUESTS, LOCAL_METHODS } from "@shared/protocol";
import type { CodexStatus, RequestId, ServerInfo, CwPaths, FsEntry, RequestLogDetail, RequestLogSummary } from "@shared/protocol";
import type {
	FileUpdateChange,
	Model,
	Thread,
	ThreadTokenUsage,
	Turn,
	ThreadItem,
} from "@shared/codex-ts/v2";
import { CodexSocket, type ConnectionState } from "../lib/ws";
import {
	asArray,
	asString,
	errorMessage,
	isRecord,
	isTransientConnectionError,
	routeParams,
	type PendingRequest,
	type Toast,
	type TranscriptError,
	type TurnPlanState,
} from "../lib/codex-types";
import { basename } from "../lib/format";

/* ------------------------------------------------------------------ */
/* settings                                                            */
/* ------------------------------------------------------------------ */

export type ApprovalPolicy = "untrusted" | "on-request" | "never";
export type SandboxMode = "read-only" | "workspace-write" | "danger-full-access";
/**
 * Who reviews escalation requests (sandbox escapes, network, MCP prompts).
 * `null` = inherit codex's own config — which may well be `auto_review`, in which
 * case a subagent decides and the browser **never sees an approval dialog**.
 * Pick `user` to route every request to this UI.
 */
export type ApprovalsReviewer = "user" | "auto_review" | "guardian_subagent";

export interface Settings {
	model: string | null;
	effort: string | null;
	approvalPolicy: ApprovalPolicy;
	sandbox: SandboxMode;
	reviewer: ApprovalsReviewer | null;
	cwd: string;
	autoApprove: boolean;
}

const DEFAULT_SETTINGS: Settings = {
	model: null,
	effort: null,
	approvalPolicy: "on-request",
	sandbox: "workspace-write",
	reviewer: null,
	cwd: "",
	autoApprove: false,
};

/* ------------------------------------------------------------------ */
/* state                                                               */
/* ------------------------------------------------------------------ */

export interface CodexState {
	connection: ConnectionState;
	info: ServerInfo | null;
	status: CodexStatus | null;
	models: Model[];
	account: { account: unknown; requiresOpenaiAuth: boolean } | null;
	threads: Thread[];
	threadsCursor: string | null;
	threadsLoading: boolean;
	threadsError: string | null;
	/** Known workspaces, newest first; the server default sorts first. */
	projects: Project[];
	projectsLoading: boolean;
	archived: boolean;
	searchTerm: string;
	activeThread: Thread | null;
	turns: Turn[];
	turnDiffs: Record<string, string>;
	turnPlans: Record<string, TurnPlanState>;
	tokenUsage: ThreadTokenUsage | null;
	streamingTurnId: string | null;
	pendingRequests: PendingRequest[];
	errors: TranscriptError[];
	toasts: Toast[];
	settings: Settings;
}

/**
 * Project selection helpers.
 *
 * These are declared ABOVE `initialState` on purpose: `initialState` calls
 * `readStoredProject()` during module evaluation, and a `const` defined further
 * down the file would still be in its temporal dead zone at that point. The
 * resulting ReferenceError is swallowed by the try/catch below, which silently
 * disables persistence — exactly the kind of bug that looks like "it just
 * doesn't remember my project".
 */
const PROJECT_KEY = "cw-project";

function readStoredProject(): string {
	try {
		return localStorage.getItem(PROJECT_KEY) ?? "";
	} catch {
		return "";
	}
}

function storeProject(path: string): void {
	try {
		if (path) localStorage.setItem(PROJECT_KEY, path);
		else localStorage.removeItem(PROJECT_KEY);
	} catch {
		/* ignore */
	}
}

const initialState: CodexState = {
	connection: "connecting",
	info: null,
	status: null,
	models: [],
	account: null,
	threads: [],
	threadsCursor: null,
	threadsLoading: false,
	threadsError: null,
	projects: [],
	projectsLoading: false,
	archived: false,
	searchTerm: "",
	activeThread: null,
	turns: [],
	turnDiffs: {},
	turnPlans: {},
	tokenUsage: null,
	streamingTurnId: null,
	pendingRequests: [],
	errors: [],
	toasts: [],
	// A previously selected project wins over the server default, so the choice
	// survives a reload (the `welcome` handler only fills cwd when it is empty).
	settings: { ...DEFAULT_SETTINGS, cwd: readStoredProject() },
};

/* ------------------------------------------------------------------ */
/* reducer helpers                                                     */
/* ------------------------------------------------------------------ */

function makeTurn(id: string, patch: Partial<Turn> = {}): Turn {
	return {
		id,
		items: [],
		itemsView: "full",
		status: "inProgress",
		error: null,
		startedAt: null,
		completedAt: null,
		durationMs: null,
		...patch,
	};
}

function makePlaceholderItem(itemId: string, kind: string): ThreadItem | null {
	const base = { id: itemId };
	switch (kind) {
		case "agent":
			return { ...base, type: "agentMessage", text: "", phase: null, memoryCitation: null, delivery: null, questions: null } as ThreadItem;
		case "reasoning":
			return { ...base, type: "reasoning", summary: [], content: [] } as ThreadItem;
		case "plan":
			return { ...base, type: "plan", text: "" } as ThreadItem;
		case "command":
			return {
				...base,
				type: "commandExecution",
				pluginId: null,
				scriptPath: null,
				command: "",
				cwd: "",
				processId: null,
				source: "agent",
				status: "inProgress",
				commandActions: [],
				aggregatedOutput: "",
				exitCode: null,
				durationMs: null,
			} as ThreadItem;
		default:
			return null;
	}
}

/**
 * Does this payload already carry the item's *final, complete* content?
 *
 * codex streams incremental deltas first and then sends a final item in
 * `item/completed`; for the item types below the final payload is authoritative
 * and supersedes every buffered delta (see `purgeDeltas`). An empty final payload
 * (e.g. an agent message that never produced text) must NOT purge, otherwise the
 * deltas would be the only surviving content and would be thrown away.
 */
function hasAuthoritativeContent(item: Record<string, unknown>): boolean {
	switch (item.type) {
		case "agentMessage":
			return typeof item.text === "string" && item.text.length > 0;
		case "commandExecution":
			return typeof item.aggregatedOutput === "string" && item.aggregatedOutput.length > 0;
		case "reasoning": {
			const summary = Array.isArray(item.summary) ? item.summary : [];
			const content = Array.isArray(item.content) ? item.content : [];
			return summary.length > 0 || content.length > 0;
		}
		default:
			return false;
	}
}

/** Insert or replace an item, creating the turn if we haven't seen it yet. */
function upsertItem(turns: Turn[], turnId: string, item: ThreadItem): Turn[] {
	const turnIdx = turns.findIndex((t) => t.id === turnId);
	if (turnIdx === -1) {
		return [...turns, makeTurn(turnId, { items: [item] })];
	}
	const turn = turns[turnIdx];
	const items = Array.isArray(turn.items) ? turn.items : [];
	const itemIdx = items.findIndex((i) => i.id === item.id);
	const nextItems = itemIdx === -1 ? [...items, item] : items.map((i, k) => (k === itemIdx ? item : i));
	const nextTurns = turns.slice();
	nextTurns[turnIdx] = { ...turn, items: nextItems };
	return nextTurns;
}

/** Apply an updater to a single item, creating turn/item placeholders as needed. */
function mapItem(
	turns: Turn[],
	turnId: string,
	itemId: string,
	fn: (item: ThreadItem) => ThreadItem,
	placeholderKind?: string,
): Turn[] {
	const turnIdx = turns.findIndex((t) => t.id === turnId);
	if (turnIdx === -1) {
		const ph = placeholderKind ? makePlaceholderItem(itemId, placeholderKind) : null;
		const turn = makeTurn(turnId, { items: ph ? [fn(ph)] : [] });
		return [...turns, turn];
	}
	const turn = turns[turnIdx];
	const items = Array.isArray(turn.items) ? turn.items : [];
	const itemIdx = items.findIndex((i) => i.id === itemId);
	if (itemIdx === -1) {
		const ph = placeholderKind ? makePlaceholderItem(itemId, placeholderKind) : null;
		if (!ph) return turns;
		const nextTurns = turns.slice();
		nextTurns[turnIdx] = { ...turn, items: [...items, fn(ph)] };
		return nextTurns;
	}
	const nextItems = items.slice();
	nextItems[itemIdx] = fn(nextItems[itemIdx]);
	const nextTurns = turns.slice();
	nextTurns[turnIdx] = { ...turn, items: nextItems };
	return nextTurns;
}

function updateTurn(turns: Turn[], turnId: string, fn: (turn: Turn) => Turn): Turn[] {
	const idx = turns.findIndex((t) => t.id === turnId);
	if (idx === -1) return [...turns, fn(makeTurn(turnId))];
	const next = turns.slice();
	next[idx] = fn(next[idx]);
	return next;
}

function upsertThread(threads: Thread[], thread: Thread): Thread[] {
	const idx = threads.findIndex((t) => t.id === thread.id);
	if (idx === -1) return [thread, ...threads];
	const next = threads.slice();
	next[idx] = { ...next[idx], ...thread };
	return next;
}

/** Union items by id, preserving existing order and letting incoming win. */
function mergeItems(existing: ThreadItem[], incoming: ThreadItem[]): ThreadItem[] {
	if (incoming.length === 0) return existing;
	if (existing.length === 0) return incoming;
	const byId = new Map<string, ThreadItem>();
	for (const it of existing) byId.set(it.id, it);
	for (const it of incoming) byId.set(it.id, it);
	const result: ThreadItem[] = [];
	const seen = new Set<string>();
	for (const it of existing) {
		const merged = byId.get(it.id);
		if (merged) {
			result.push(merged);
			seen.add(it.id);
		}
	}
	for (const it of incoming) {
		if (!seen.has(it.id)) {
			result.push(it);
			seen.add(it.id);
		}
	}
	return result;
}

function sortThreads(threads: Thread[]): Thread[] {
	return threads.slice().sort((a, b) => {
		const ta = a.recencyAt ?? a.updatedAt ?? a.createdAt ?? 0;
		const tb = b.recencyAt ?? b.updatedAt ?? b.createdAt ?? 0;
		return tb - ta;
	});
}

/* ------------------------------------------------------------------ */
/* actions                                                             */
/* ------------------------------------------------------------------ */

export type DeltaKind = "agent" | "reasonSummary" | "reasonText" | "plan" | "commandOutput";

export interface DeltaEntry {
	kind: DeltaKind;
	threadId: string | null;
	turnId: string;
	itemId: string;
	text: string;
	index: number;
}

type Action =
	| { type: "connection"; value: ConnectionState }
	| { type: "welcome"; info: ServerInfo }
	| { type: "status"; status: CodexStatus }
	| { type: "models"; models: Model[] }
	| { type: "account"; account: { account: unknown; requiresOpenaiAuth: boolean } | null }
	| { type: "threads/loading"; value: boolean }
	| { type: "threads/error"; error: string | null }
	| { type: "threads/set"; threads: Thread[]; cursor: string | null; append: boolean; archived: boolean }
	| { type: "projects/set"; projects: Project[]; loading: boolean }
	| { type: "threads/upsert"; thread: Thread }
	| { type: "threads/remove"; threadId: string }
	| { type: "threads/patch"; threadId: string; patch: Partial<Thread> }
	| { type: "active"; thread: Thread | null; turns: Turn[]; tokenUsage?: ThreadTokenUsage | null }
	| { type: "turn/upsert"; threadId: string | null; turn: Turn }
	| { type: "turn/status"; threadId: string | null; turnId: string; status: Turn["status"]; error?: Turn["error"]; durationMs?: number | null; completedAt?: number | null }
	| { type: "turn/diff"; turnId: string; diff: string }
	| { type: "turn/plan"; turnId: string; plan: TurnPlanState }
	| { type: "item/upsert"; threadId: string | null; turnId: string; item: ThreadItem }
	| { type: "item/changes"; threadId: string | null; turnId: string; itemId: string; changes: FileUpdateChange[] }
	| { type: "delta"; entries: DeltaEntry[] }
	| { type: "tokenUsage"; threadId: string | null; usage: ThreadTokenUsage }
	| { type: "request/add"; request: PendingRequest }
	| { type: "request/remove"; id: RequestId }
	| { type: "error/add"; error: TranscriptError }
	| { type: "error/clear"; threadId?: string }
	| { type: "toast/add"; toast: Toast }
	| { type: "toast/remove"; id: string }
	| { type: "settings"; patch: Partial<Settings> }
	| { type: "streaming"; turnId: string | null }
	| { type: "search"; term: string }
	| { type: "archived"; value: boolean }
	| { type: "reset" };

function reducer(state: CodexState, action: Action): CodexState {
	switch (action.type) {
		case "connection":
			return { ...state, connection: action.value };
		case "welcome": {
			const cwd = state.settings.cwd || action.info.cwd || "";
			return { ...state, info: action.info, settings: { ...state.settings, cwd } };
		}
		case "status":
			return { ...state, status: action.status };
		case "models":
			return { ...state, models: action.models };
		case "account":
			return { ...state, account: action.account };
		case "threads/loading":
			return { ...state, threadsLoading: action.value };
		case "threads/error":
			return { ...state, threadsError: action.error };
		case "threads/set": {
			const merged = action.append ? [...state.threads, ...action.threads] : action.threads;
			// De-dup by id, keep newest metadata.
			const byId = new Map<string, Thread>();
			for (const t of merged) byId.set(t.id, t);
			return {
				...state,
				threads: sortThreads([...byId.values()]),
				threadsCursor: action.cursor,
				archived: action.archived,
				threadsLoading: false,
				threadsError: null,
			};
		}
		case "threads/upsert":
			return { ...state, threads: sortThreads(upsertThread(state.threads, action.thread)) };
		case "threads/remove":
			return {
				...state,
				threads: state.threads.filter((t) => t.id !== action.threadId),
				activeThread: state.activeThread?.id === action.threadId ? null : state.activeThread,
			};
		case "threads/patch":
			return {
				...state,
				threads: state.threads.map((t) => (t.id === action.threadId ? { ...t, ...action.patch } : t)),
				activeThread:
					state.activeThread?.id === action.threadId ? { ...state.activeThread, ...action.patch } : state.activeThread,
			};
		case "active":
			return {
				...state,
				activeThread: action.thread,
				turns: action.turns,
				turnDiffs: {},
				turnPlans: {},
				tokenUsage: action.tokenUsage ?? null,
				streamingTurnId: null,
				errors: action.thread ? state.errors.filter((e) => e.threadId === action.thread?.id) : [],
			};
		case "turn/upsert": {
			if (action.threadId && action.threadId !== state.activeThread?.id) return state;
			const idx = state.turns.findIndex((t) => t.id === action.turn.id);
			const turns =
				idx === -1
					? [...state.turns, action.turn]
					: state.turns.map((t) =>
							t.id === action.turn.id
								? {
										...t,
										...action.turn,
										items: mergeItems(Array.isArray(t.items) ? t.items : [], Array.isArray(action.turn.items) ? action.turn.items : []),
									}
								: t,
						);
			return { ...state, turns };
		}
		case "turn/status": {
			if (action.threadId && action.threadId !== state.activeThread?.id) return state;
			const turns = updateTurn(state.turns, action.turnId, (t) => ({
				...t,
				status: action.status,
				error: action.error !== undefined ? action.error : t.error,
				durationMs: action.durationMs !== undefined ? action.durationMs : t.durationMs,
				completedAt: action.completedAt !== undefined ? action.completedAt : t.completedAt,
			}));
			return { ...state, turns };
		}
		case "turn/diff":
			return { ...state, turnDiffs: { ...state.turnDiffs, [action.turnId]: action.diff } };
		case "turn/plan":
			return { ...state, turnPlans: { ...state.turnPlans, [action.turnId]: action.plan } };
		case "item/upsert": {
			if (action.threadId && action.threadId !== state.activeThread?.id) return state;
			return { ...state, turns: upsertItem(state.turns, action.turnId, action.item) };
		}
		case "item/changes": {
			if (action.threadId && action.threadId !== state.activeThread?.id) return state;
			const turns = mapItem(
				state.turns,
				action.turnId,
				action.itemId,
				(item) => (item.type === "fileChange" ? { ...item, changes: action.changes } : item),
				undefined,
			);
			return { ...state, turns };
		}
		case "delta": {
			if (action.entries.length === 0) return state;
			let turns = state.turns;
			for (const entry of action.entries) {
				if (entry.threadId && entry.threadId !== state.activeThread?.id) continue;
				switch (entry.kind) {
					case "agent":
						turns = mapItem(turns, entry.turnId, entry.itemId, (item) =>
							item.type === "agentMessage" ? { ...item, text: (item.text ?? "") + entry.text } : item,
							"agent",
						);
						break;
					case "plan":
						turns = mapItem(turns, entry.turnId, entry.itemId, (item) =>
							item.type === "plan" ? { ...item, text: (item.text ?? "") + entry.text } : item,
							"plan",
						);
						break;
					case "reasonSummary":
						turns = mapItem(turns, entry.turnId, entry.itemId, (item) => {
							if (item.type !== "reasoning") return item;
							const summary = (Array.isArray(item.summary) ? item.summary : []).slice();
							while (summary.length <= entry.index) summary.push("");
							summary[entry.index] = (summary[entry.index] ?? "") + entry.text;
							return { ...item, summary };
						}, "reasoning");
						break;
					case "reasonText":
						turns = mapItem(turns, entry.turnId, entry.itemId, (item) => {
							if (item.type !== "reasoning") return item;
							const content = (Array.isArray(item.content) ? item.content : []).slice();
							while (content.length <= entry.index) content.push("");
							content[entry.index] = (content[entry.index] ?? "") + entry.text;
							return { ...item, content };
						}, "reasoning");
						break;
					case "commandOutput":
						turns = mapItem(turns, entry.turnId, entry.itemId, (item) =>
							item.type === "commandExecution"
								? { ...item, aggregatedOutput: (item.aggregatedOutput ?? "") + entry.text }
								: item,
							"command",
						);
						break;
					default:
						break;
				}
			}
			return { ...state, turns };
		}
		case "tokenUsage":
			if (action.threadId && action.threadId !== state.activeThread?.id) return state;
			return { ...state, tokenUsage: action.usage };
		case "request/add": {
			if (state.pendingRequests.some((r) => r.id === action.request.id)) return state;
			return { ...state, pendingRequests: [...state.pendingRequests, action.request] };
		}
		case "request/remove":
			return { ...state, pendingRequests: state.pendingRequests.filter((r) => r.id !== action.id) };
		case "error/add":
			return { ...state, errors: [...state.errors, action.error].slice(-20) };
		case "error/clear":
			return { ...state, errors: action.threadId ? state.errors.filter((e) => e.threadId !== action.threadId) : [] };
		case "toast/add":
			return { ...state, toasts: [...state.toasts, action.toast].slice(-6) };
		case "toast/remove":
			return { ...state, toasts: state.toasts.filter((t) => t.id !== action.id) };
		case "settings":
			return { ...state, settings: { ...state.settings, ...action.patch } };
		case "streaming":
			return { ...state, streamingTurnId: action.turnId };
		case "search":
			return { ...state, searchTerm: action.term };
		case "archived":
			return { ...state, archived: action.value };
		case "projects/set":
			return { ...state, projects: action.projects, projectsLoading: action.loading };
		case "reset":
			return { ...state, activeThread: null, turns: [], turnDiffs: {}, turnPlans: {}, tokenUsage: null, streamingTurnId: null };
		default:
			return state;
	}
}

/* ------------------------------------------------------------------ */
/* projects                                                            */
/* ------------------------------------------------------------------ */

/** One workspace, derived from the `cwd` of known codex threads. */
export interface Project {
	path: string;
	/** Last path segment, for display. */
	name: string;
	/** Threads seen in this project. */
	threadCount: number;
	/** Most recent thread activity, unix seconds. */
	lastUsedAt: number;
	/** True for the app-server's own default cwd. */
	isDefault: boolean;
}

function baseName(path: string): string {
	const trimmed = path.replace(/[/\\]+$/, "");
	const idx = Math.max(trimmed.lastIndexOf("/"), trimmed.lastIndexOf("\\"));
	return idx >= 0 ? trimmed.slice(idx + 1) : trimmed;
}

/**
 * Build the project list from a page of threads plus the paths we always want
 * to offer (the server default and the currently selected project).
 *
 * Counts come from an *unscoped* `thread/list` on purpose: the visible thread
 * list is filtered by the selected project, so it cannot provide totals.
 */
function buildProjects(
	threads: Thread[],
	extraPaths: Array<string | null | undefined>,
	defaultCwd: string | null,
): Project[] {
	const byPath = new Map<string, Project>();
	const touch = (rawPath: unknown, updatedAt?: number): void => {
		if (typeof rawPath !== "string" || rawPath === "") return;
		const existing = byPath.get(rawPath);
		const ts = typeof updatedAt === "number" ? updatedAt : 0;
		if (existing) {
			if (updatedAt !== undefined) existing.threadCount += 1;
			if (ts > existing.lastUsedAt) existing.lastUsedAt = ts;
			return;
		}
		byPath.set(rawPath, {
			path: rawPath,
			name: baseName(rawPath),
			threadCount: updatedAt === undefined ? 0 : 1,
			lastUsedAt: ts,
			isDefault: !!defaultCwd && rawPath === defaultCwd,
		});
	};

	for (const t of threads) {
		if (!t || typeof t !== "object") continue;
		touch((t as { cwd?: unknown }).cwd, (t as { updatedAt?: number }).updatedAt);
	}
	for (const p of extraPaths) touch(p);

	return [...byPath.values()].sort((a, b) => {
		if (a.isDefault !== b.isDefault) return a.isDefault ? -1 : 1;
		if (b.lastUsedAt !== a.lastUsedAt) return b.lastUsedAt - a.lastUsedAt;
		return a.path.localeCompare(b.path);
	});
}

/* ------------------------------------------------------------------ */
/* context value                                                       */
/* ------------------------------------------------------------------ */

export interface CodexContextValue extends CodexState {
	/** True while a turn is running for the active thread. */
	streaming: boolean;
	// threads
	listThreads: (opts?: {
		append?: boolean;
		archived?: boolean;
		searchTerm?: string;
		cursor?: string | null;
		/** Override the project filter; `null` means "all projects". */
		cwd?: string | null;
	}) => Promise<void>;
	// projects
	/** Rebuild the project list from an unscoped `thread/list`. */
	refreshProjects: () => Promise<void>;
	/** Switch workspace: re-filter the thread list and start fresh. */
	selectProject: (path: string | null) => Promise<void>;
	loadThread: (threadId: string) => Promise<void>;
	resumeThread: (threadId: string) => Promise<Thread | undefined>;
	openThread: (threadId: string) => Promise<void>;
	startThread: (overrides?: Partial<Settings> & { cwd?: string }) => Promise<Thread | null>;
	renameThread: (threadId: string, name: string) => Promise<void>;
	archiveThread: (threadId: string, archived?: boolean) => Promise<void>;
	deleteThread: (threadId: string) => Promise<void>;
	forkThread: (threadId: string) => Promise<void>;
	/**
	 * Switch the thread list between active and archived threads.
	 *
	 * Kept on the context (the `archived` flag is still part of every
	 * `thread/list` call) but **not exposed in the UI** — the sidebar shows active
	 * threads only, and `Archive` in a thread's menu hides it.
	 */
	setArchivedView: (value: boolean) => void;
	setSearchTerm: (term: string) => void;
	// turns
	sendMessage: (text: string, options?: { model?: string | null; effort?: string | null; extra?: unknown[] }) => Promise<void>;
	interrupt: () => Promise<void>;
	respondApproval: (id: RequestId, decision: string, method?: string) => void;
	respondUserInput: (id: RequestId, answers: Record<string, string[]>) => void;
	rejectRequest: (id: RequestId) => void;
	dismissRequest: (id: RequestId) => void;
	// settings
	setModel: (model: string | null) => void;
	setEffort: (effort: string | null) => void;
	setApprovalPolicy: (policy: ApprovalPolicy) => void;
	setSandbox: (sandbox: SandboxMode) => void;
	setReviewer: (reviewer: ApprovalsReviewer | null) => void;
	setCwd: (cwd: string) => void;
	setAutoApprove: (value: boolean) => void;
	// server maintenance
	restartCodex: () => Promise<void>;
	fetchLogs: () => Promise<string[]>;
	fetchRequestLogs: (threadId: string) => Promise<RequestLogSummary[]>;
	fetchRequestLog: (id: string) => Promise<RequestLogDetail | null>;
	// filesystem
	readFile: (path: string) => Promise<{ path: string; text: string; truncated: boolean }>;
	listFiles: (path: string) => Promise<{ path: string; entries: FsEntry[] }>;
	paths: () => Promise<CwPaths>;
	searchFiles: (query: string) => Promise<Array<{ path: string; fileName: string; root: string }>>;
	// misc
	toast: (message: string, kind?: Toast["kind"]) => void;
	dismissToast: (id: string) => void;
	refreshStatus: () => void;
	reconnect: () => void;
	// file preview plumbing
	previewFile: string | null;
	openFilePreview: (path: string) => void;
	closeFilePreview: () => void;
}

const CodexContext = createContext<CodexContextValue | null>(null);

function uid(): string {
	try {
		if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") return crypto.randomUUID();
	} catch {
		/* ignore */
	}
	return `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
}

export function CodexProvider({ children }: { children: ReactNode }): ReactNode {
	const [state, dispatch] = useReducer(reducer, initialState);
	const stateRef = useRef(state);
	stateRef.current = state;

	const socketRef = useRef<CodexSocket | null>(null);
	const [, setReady] = useState(false);
	const autoApproveRef = useRef(state.settings.autoApprove);
	autoApproveRef.current = state.settings.autoApprove;	const previewRef = useRef<string | null>(null);
	const [previewFile, setPreviewFile] = useState<string | null>(null);

	// --- streaming delta buffer (flushed on rAF) ---------------------
	const deltaBuffer = useRef(new Map<string, DeltaEntry>());
	const flushHandle = useRef<number | null>(null);
	const flushDeltas = useCallback(() => {
		flushHandle.current = null;
		if (deltaBuffer.current.size === 0) return;
		const entries = [...deltaBuffer.current.values()];
		deltaBuffer.current.clear();
		dispatch({ type: "delta", entries });
	}, []);
	const queueDelta = useCallback(
		(entry: DeltaEntry) => {
			const key = `${entry.kind}|${entry.turnId}|${entry.itemId}|${entry.index}`;
			const existing = deltaBuffer.current.get(key);
			if (existing) existing.text += entry.text;
			else deltaBuffer.current.set(key, { ...entry });
			if (flushHandle.current == null) {
				flushHandle.current = requestAnimationFrame(flushDeltas);
			}
		},
		[flushDeltas],
	);

	/**
	 * 丢掉某个 item 尚未 flush 的增量。
	 *
	 * `item/completed` 携带的是「最终完整内容」（agentMessage.text / reasoning.summary /
	 * commandExecution.aggregatedOutput），而同一个 item 的增量可能还躺在 rAF 缓冲里没提交。
	 * 如果不清掉，reducer 会先被 upsert 成完整文本，再被缓冲的增量追加一遍，
	 * 表现为消息/命令输出重复。
	 */
	const purgeDeltas = useCallback((itemId: string) => {
		if (deltaBuffer.current.size === 0) return;
		for (const [key, entry] of deltaBuffer.current) {
			if (entry.itemId === itemId) deltaBuffer.current.delete(key);
		}
	}, []);

	// --- rpc helper ---------------------------------------------------
	const rpc = useCallback(<T,>(method: string, params?: unknown, timeoutMs?: number): Promise<T> => {
		const socket = socketRef.current;
		if (!socket) return Promise.reject(new Error("Not connected"));
		return socket.rpc<T>(method, params, timeoutMs ? { timeoutMs } : undefined);
	}, []);

	const toast = useCallback((message: string, kind: Toast["kind"] = "info") => {
		dispatch({ type: "toast/add", toast: { id: uid(), kind, message } });
	}, []);

	// --- event handling ----------------------------------------------
	useEffect(() => {
		const socket = new CodexSocket();
		socketRef.current = socket;

		const refreshThreads = async (opts: { archived?: boolean; searchTerm?: string } = {}) => {
			const s = stateRef.current;
			dispatch({ type: "threads/loading", value: true });
			try {
				const res = await socket.rpc<{ data?: unknown; nextCursor?: string | null }>(CODEX.threadList, {
					limit: 40,
					sortDirection: "desc",
					archived: opts.archived ?? s.archived,
					searchTerm: (opts.searchTerm ?? s.searchTerm) || null,
				});
				const data = Array.isArray(res?.data) ? (res.data as Thread[]) : [];
				dispatch({
					type: "threads/set",
					threads: data,
					cursor: asString(res?.nextCursor) ?? null,
					append: false,
					archived: opts.archived ?? s.archived,
				});
			} catch (err) {
				dispatch({ type: "threads/loading", value: false });
				dispatch({ type: "threads/error", error: errorMessage(err) });
			}
		};

		const handleEvent = (method: string, params: unknown) => {
			const route = routeParams(params);
			const { threadId, turnId, itemId, raw } = route;
			switch (method) {
				case CODEX_EVENTS.turnStarted: {
					const turn = raw.turn as Turn | undefined;
					if (turn && isRecord(turn)) {
						dispatch({ type: "turn/upsert", threadId, turn });
						if (!threadId || threadId === stateRef.current.activeThread?.id) {
							dispatch({ type: "streaming", turnId: turn.id ?? turnId });
						}
					}
					break;
				}
				case CODEX_EVENTS.turnCompleted: {
					const turn = raw.turn as Turn | undefined;
					if (turn && isRecord(turn)) dispatch({ type: "turn/upsert", threadId, turn });
					if (!threadId || threadId === stateRef.current.activeThread?.id) {
						dispatch({ type: "streaming", turnId: null });
					}
					break;
				}
				case CODEX_EVENTS.turnDiffUpdated: {
					const diff = asString(raw.diff);
					if (diff != null && turnId) dispatch({ type: "turn/diff", turnId, diff });
					break;
				}
				case CODEX_EVENTS.turnPlanUpdated: {
					if (!turnId) break;
					const plan = asArray(raw.plan).map((step) => {
						const r = isRecord(step) ? step : {};
						return { step: asString(r.step) ?? "", status: asString(r.status) ?? "pending" };
					});
					dispatch({
						type: "turn/plan",
						turnId,
						plan: { explanation: asString(raw.explanation) ?? null, plan },
					});
					break;
				}
				case CODEX_EVENTS.itemStarted:
				case CODEX_EVENTS.itemCompleted: {
					const item = raw.item;
					if (!turnId || !isRecord(item) || typeof item.type !== "string") break;
					// 事件带的 item 是权威版本；若它已携带最终内容，说明流式阶段结束，
					// 必须先丢掉该 item 未提交的增量，否则会重复追加（消息/输出翻倍）。
					if (typeof item.id === "string" && hasAuthoritativeContent(item)) purgeDeltas(item.id);
					dispatch({ type: "item/upsert", threadId, turnId, item: item as unknown as ThreadItem });
					break;
				}
				case "item/fileChange/patchUpdated": {
					if (!turnId || !itemId) break;
					const changes = asArray<FileUpdateChange>(raw.changes);
					dispatch({ type: "item/changes", threadId, turnId, itemId, changes });
					break;
				}
				case CODEX_EVENTS.agentMessageDelta: {
					const delta = asString(raw.delta) ?? "";
					if (turnId && itemId && delta) queueDelta({ kind: "agent", threadId, turnId, itemId, text: delta, index: 0 });
					break;
				}
				case CODEX_EVENTS.reasoningSummaryDelta: {
					const delta = asString(raw.delta) ?? "";
					const index = typeof raw.summaryIndex === "number" ? raw.summaryIndex : 0;
					if (turnId && itemId && delta) queueDelta({ kind: "reasonSummary", threadId, turnId, itemId, text: delta, index });
					break;
				}
				case CODEX_EVENTS.reasoningTextDelta: {
					const delta = asString(raw.delta) ?? "";
					const index = typeof raw.contentIndex === "number" ? raw.contentIndex : 0;
					if (turnId && itemId && delta) queueDelta({ kind: "reasonText", threadId, turnId, itemId, text: delta, index });
					break;
				}
				case CODEX_EVENTS.planDelta: {
					const delta = asString(raw.delta) ?? "";
					if (turnId && itemId && delta) queueDelta({ kind: "plan", threadId, turnId, itemId, text: delta, index: 0 });
					break;
				}
				case CODEX_EVENTS.commandOutputDelta: {
					const delta = asString(raw.delta) ?? "";
					if (turnId && itemId && delta) queueDelta({ kind: "commandOutput", threadId, turnId, itemId, text: delta, index: 0 });
					break;
				}
				case CODEX_EVENTS.tokenUsage: {
					const usage = raw.tokenUsage;
					if (isRecord(usage)) dispatch({ type: "tokenUsage", threadId, usage: usage as unknown as ThreadTokenUsage });
					break;
				}
				case CODEX_EVENTS.threadStarted: {
					const thread = raw.thread;
					if (isRecord(thread) && typeof thread.id === "string") {
						dispatch({ type: "threads/upsert", thread: thread as unknown as Thread });
					}
					break;
				}
				case CODEX_EVENTS.threadNameUpdated: {
					if (threadId) dispatch({ type: "threads/patch", threadId, patch: { name: asString(raw.threadName) ?? null } });
					break;
				}
				case CODEX_EVENTS.threadStatusChanged: {
					if (threadId && isRecord(raw.status)) {
						dispatch({ type: "threads/patch", threadId, patch: { status: raw.status as Thread["status"] } });
					}
					break;
				}
				case "thread/archived":
					if (threadId) {
						dispatch({ type: "threads/remove", threadId });
						if (stateRef.current.activeThread?.id === threadId) dispatch({ type: "reset" });
					}
					break;
				case "thread/deleted":
					if (threadId) {
						dispatch({ type: "threads/remove", threadId });
						if (stateRef.current.activeThread?.id === threadId) dispatch({ type: "reset" });
					}
					break;
				case "thread/unarchived":
					if (threadId) void refreshThreads();
					break;
				case CODEX_EVENTS.error: {
					const err = isRecord(raw.error) ? raw.error : {};
					const message = asString(err.message) ?? "Codex reported an error";
					dispatch({
						type: "error/add",
						error: { id: uid(), threadId, turnId, message, willRetry: raw.willRetry === true, at: Date.now() },
					});
					toast(message, "error");
					break;
				}
				case "serverRequest/resolved": {
					const requestId = raw.requestId;
					if (typeof requestId === "string" || typeof requestId === "number") {
						dispatch({ type: "request/remove", id: requestId });
					}
					break;
				}
				default:
					break;
			}
		};

		socket.setHandlers({
			onState: (value) => dispatch({ type: "connection", value }),
			onOpen: () => {
				setReady(true);
				void socket.rpc(LOCAL_METHODS.codexStatus).then(
					(res) => {
						if (isRecord(res) && isRecord(res.status)) dispatch({ type: "status", status: res.status as unknown as CodexStatus });
					},
					() => {
						/* mock/older server may not implement */
					},
				);
				// `owa/paths` needs no codex, so it is the one call we make immediately —
				// it tells us which project to scope the thread list to. Everything that
				// depends on the app-server goes through `bootstrapCodex`, which the
				// server-side ready-wait makes safe even while codex is still booting.
				void socket.rpc(LOCAL_METHODS.paths).then(
					(res) => {
						const defaultCwd = isRecord(res) && typeof res.cwd === "string" ? res.cwd : null;
						const stored = stateRef.current.settings.cwd;
						if (defaultCwd && !stored) dispatch({ type: "settings", patch: { cwd: defaultCwd } });
						// A project chosen in a previous session wins over the server default.
						void bootstrapCodexRef.current?.(stored || defaultCwd || null);
					},
					() => {
						void bootstrapCodexRef.current?.();
					},
				);
			},
			onClose: () => {
				/* state is driven by onState */
			},
			onWelcome: (info) => dispatch({ type: "welcome", info }),
			onStatus: (status) => dispatch({ type: "status", status }),
			onEvent: handleEvent,
			onServerRequest: (id, method, params) => {
				const route = routeParams(params);
				const isApproval = method === CODEX_REQUESTS.commandApproval || method === CODEX_REQUESTS.fileChangeApproval;
				if (isApproval && autoApproveRef.current) {
					socket.reply(id, { decision: "accept" });
					toast(`Auto-approved ${method.split("/").slice(-1)[0]}`, "info");
					return;
				}
				dispatch({
					type: "request/add",
					request: { id, method, params, receivedAt: Date.now() },
				});
				void route;
			},
			onProtocolError: (message) => toast(message, "error"),
		});

		socket.connect();
		return () => {
			if (flushHandle.current != null) cancelAnimationFrame(flushHandle.current);
			flushHandle.current = null;
			deltaBuffer.current.clear();
			socket.dispose();
			socketRef.current = null;
		};
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	/* ------------------------------------------------------------------ */
	/* actions                                                             */
	/* ------------------------------------------------------------------ */
	const listThreads = useCallback<CodexContextValue["listThreads"]>(
		async (opts = {}) => {
			const s = stateRef.current;
			const archived = opts.archived ?? s.archived;
			const term = opts.searchTerm ?? s.searchTerm;
			const append = opts.append ?? false;
			const cursor = append ? (opts.cursor ?? s.threadsCursor) : null;
			// Threads are scoped to the selected project — that is the whole point of
			// the project switcher. `undefined` opts.cwd means "use current project".
			const cwdFilter = opts.cwd !== undefined ? opts.cwd : s.settings.cwd || null;
			dispatch({ type: "threads/loading", value: true });
			try {
				const res = await rpc<{ data?: unknown; nextCursor?: string | null }>(CODEX.threadList, {
					limit: 40,
					sortDirection: "desc",
					archived,
					searchTerm: term || null,
					cwd: cwdFilter ? [cwdFilter] : null,
					cursor,
				});
				const data = Array.isArray(res?.data) ? (res.data as Thread[]) : [];
				dispatch({ type: "threads/set", threads: data, cursor: asString(res?.nextCursor) ?? null, append, archived });
			} catch (err) {
				dispatch({ type: "threads/loading", value: false });
				dispatch({ type: "threads/error", error: errorMessage(err) });
				// "app-server not connected" is a startup/reconnect race, not something
				// the user can act on — the StatusPill already shows it, and we re-list
				// automatically once codex comes up. Don't spam a toast for it.
				if (!isTransientConnectionError(err)) toast(errorMessage(err), "error");
			}
		},
		[rpc, toast],
	);

	/** Set once `refreshProjects` exists; the connect effect (empty deps) calls it. */
	const refreshProjectsRef = useRef<(() => Promise<void>) | null>(null);
	/** Same trick for `listThreads`, needed to defer the initial project-scoped listing. */
	const listThreadsRef = useRef<CodexContextValue["listThreads"] | null>(null);
	/** Codex-dependent boot (models / account / threads); re-run on every (re)connect. */
	const bootstrapCodexRef = useRef<((cwdOverride?: string | null) => Promise<void>) | null>(null);
	const bootstrapInFlightRef = useRef<Promise<void> | null>(null);
	listThreadsRef.current = listThreads;

	const applyThreadResult = useCallback((thread: Thread) => {
		const turns = Array.isArray(thread.turns) ? thread.turns : [];
		dispatch({ type: "active", thread, turns });
		dispatch({ type: "threads/upsert", thread: { ...thread, turns: [] } });
	}, []);

	/**
	 * Re-sync whenever the app-server becomes reachable.
	 *
	 * Covers two cases the initial attach cannot: an app-server that took longer
	 * than the server's proxy wait (so the first requests still failed), and a
	 * crash-restart of the child process. Without this the model list, account
	 * badge and thread list would stay empty until a manual reload.
	 */
	const codexConnected = state.status?.connected === true;
	const wasCodexConnectedRef = useRef(false);
	useEffect(() => {
		const was = wasCodexConnectedRef.current;
		wasCodexConnectedRef.current = codexConnected;
		if (!codexConnected || was) return;
		// Concurrent with `onOpen`'s own bootstrap on a cold start; the in-flight
		// guard inside `bootstrapCodex` collapses the duplicate.
		void bootstrapCodexRef.current?.();
	}, [codexConnected]);


	/**
	 * Rebuild the project list.
	 *
	 * Deliberately **unscoped** (no `cwd` filter) and with a large limit: this is
	 * the only call that sees every workspace, which is what lets the picker show
	 * a thread count per project while the visible list stays scoped.
	 */
	const refreshProjects = useCallback<CodexContextValue["refreshProjects"]>(async () => {
		const s = stateRef.current;
		dispatch({ type: "projects/set", projects: s.projects, loading: true });
		try {
			const res = await rpc<{ data?: unknown }>(CODEX.threadList, {
				limit: 400,
				sortDirection: "desc",
				archived: false,
			});
			const data = Array.isArray(res?.data) ? (res.data as Thread[]) : [];
			const defaultCwd = stateRef.current.info?.cwd ?? null;
			const projects = buildProjects(data, [stateRef.current.settings.cwd], defaultCwd);
			dispatch({ type: "projects/set", projects, loading: false });
		} catch (err) {
			// A missing project list must never break the app — keep what we have.
			dispatch({ type: "projects/set", projects: stateRef.current.projects, loading: false });
			void err;
		}
	}, [rpc]);
	refreshProjectsRef.current = refreshProjects;

	/**
	 * Everything that cannot work until the app-server is up: models, account and
	 * the thread list. Safe to call repeatedly.
	 *
	 * `cwdOverride` exists because on the very first attach the project may not be
	 * in React state yet (the `owa/paths` reply dispatches it) — see the connect
	 * effect. On a reconnect `stateRef` is already settled and it can be omitted.
	 */
	const bootstrapCodex = useCallback(
		async (cwdOverride?: string | null) => {
			// Collapse concurrent calls (cold start fires this from both `onOpen` and
			// the "codex became connected" effect) into a single round of requests.
			if (bootstrapInFlightRef.current) return bootstrapInFlightRef.current;
			const run = (async () => {
				void rpc<{ data?: unknown }>(CODEX.modelList, { limit: 100, includeHidden: false }).then(
					(res) => {
						const data = isRecord(res) ? asArray<Model>(res.data) : [];
						dispatch({ type: "models", models: data });
					},
					() => {
						/* tolerate: the model list is cosmetic and retried on reconnect */
					},
				);
				void rpc<{ account?: unknown; requiresOpenaiAuth?: boolean }>(CODEX.accountRead, {}).then(
					(res) => {
						if (!isRecord(res)) return;
						dispatch({
							type: "account",
							account: { account: res.account ?? null, requiresOpenaiAuth: res.requiresOpenaiAuth === true },
						});
					},
					() => dispatch({ type: "account", account: null }),
				);
				void refreshProjects();
				await listThreads(cwdOverride === undefined ? { append: false } : { append: false, cwd: cwdOverride });
			})();
			bootstrapInFlightRef.current = run;
			void run.finally(() => {
				if (bootstrapInFlightRef.current === run) bootstrapInFlightRef.current = null;
			});
			return run;
		},
		[rpc, refreshProjects, listThreads],
	);
	bootstrapCodexRef.current = bootstrapCodex;

	/**
	 * Switch workspace. `null` reverts to the app-server's default cwd.
	 *
	 * The thread list is filtered by cwd, so switching must reload it; the active
	 * thread + transcript are dropped because they belong to the old project.
	 */
	const selectProject = useCallback<CodexContextValue["selectProject"]>(
		async (path) => {
			const s = stateRef.current;
			const next = path ?? s.info?.cwd ?? "";
			if (next === s.settings.cwd) return;
			storeProject(next);
			dispatch({ type: "settings", patch: { cwd: next } });
			dispatch({ type: "reset" });
			dispatch({ type: "search", term: "" });
			await listThreads({ append: false, cwd: next || null, searchTerm: "" });
		},
		[listThreads],
	);

	const loadThread = useCallback<CodexContextValue["loadThread"]>(
		async (threadId) => {
			try {
				const res = await rpc<{ thread?: Thread }>(CODEX.threadRead, { threadId, includeTurns: true });
				const thread = res?.thread;
				if (!thread || typeof thread !== "object") throw new Error("thread/read returned no thread");
				applyThreadResult(thread as Thread);
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, applyThreadResult, toast],
	);

	const resumeThread = useCallback(
		async (threadId: string) => {
			const s = stateRef.current;
			const res = await rpc<{ thread?: Thread }>(CODEX.threadResume, {
				threadId,
				model: s.settings.model,
				approvalPolicy: s.settings.approvalPolicy,
				sandbox: s.settings.sandbox,
				cwd: s.settings.cwd || null,
			});
			const thread = res?.thread;
			if (thread && typeof thread === "object") applyThreadResult(thread as Thread);
			return thread as Thread | undefined;
		},
		[rpc, applyThreadResult],
	);

	const openThread = useCallback<CodexContextValue["openThread"]>(
		async (threadId) => {
			dispatch({ type: "error/clear", threadId });
			try {
				await resumeThread(threadId);
			} catch {
				await loadThread(threadId);
			}
		},
		[resumeThread, loadThread],
	);

	const startThread = useCallback<CodexContextValue["startThread"]>(
		async (overrides = {}) => {
			const s = stateRef.current;
			const cwd = overrides.cwd ?? s.settings.cwd ?? s.info?.cwd ?? null;
			const model = overrides.model !== undefined ? overrides.model : s.settings.model;
			try {
				const res = await rpc<{ thread?: Thread }>(CODEX.threadStart, {
					cwd,
					model,
					approvalPolicy: overrides.approvalPolicy ?? s.settings.approvalPolicy,
					sandbox: overrides.sandbox ?? s.settings.sandbox,
					// Only send when the user picked one: `null`/absent inherits codex's config.
					...(s.settings.reviewer ? { approvalsReviewer: s.settings.reviewer } : {}),
				});
				const thread = res?.thread;
				if (!thread || typeof thread !== "object") throw new Error("thread/start returned no thread");
				applyThreadResult(thread as Thread);
				void listThreads({ append: false });
				// The new thread may have created a brand-new project (custom cwd).
				void refreshProjectsRef.current?.();
				return thread as Thread;
			} catch (err) {
				toast(errorMessage(err), "error");
				return null;
			}
		},
		[rpc, applyThreadResult, listThreads, toast],
	);

	const sandboxPolicy = useCallback((mode: SandboxMode): unknown => {
		switch (mode) {
			case "read-only":
				return { type: "readOnly", networkAccess: false };
			case "danger-full-access":
				return { type: "dangerFullAccess" };
			case "workspace-write":
			default:
				return {
					type: "workspaceWrite",
					writableRoots: [],
					networkAccess: false,
					excludeTmpdirEnvVar: false,
					excludeSlashTmp: false,
				};
		}
	}, []);

	const sendMessage = useCallback<CodexContextValue["sendMessage"]>(
		async (text, options = {}) => {
			const s = stateRef.current;
			let threadId = s.activeThread?.id ?? null;
			if (!threadId) {
				const created = await startThread();
				threadId = created?.id ?? null;
				if (!threadId) return;
			}
			const model = options.model !== undefined ? options.model : s.settings.model;
			const effort = options.effort !== undefined ? options.effort : s.settings.effort;
			const input: unknown[] = [{ type: "text", text, text_elements: [] }];
			if (Array.isArray(options.extra)) input.push(...options.extra);
			const params: Record<string, unknown> = {
				threadId,
				input,
				model,
				effort,
				approvalPolicy: s.settings.approvalPolicy,
				sandboxPolicy: sandboxPolicy(s.settings.sandbox),
			};
			if (s.settings.reviewer) params.approvalsReviewer = s.settings.reviewer;
			try {
				const res = await rpc<{ turn?: Turn }>(CODEX.turnStart, params, 120_000);
				const turn = res?.turn;
				if (turn && typeof turn === "object") {
					dispatch({ type: "turn/upsert", threadId, turn: turn as Turn });
					dispatch({ type: "streaming", turnId: (turn as Turn).id ?? null });
				}
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, startThread, sandboxPolicy, toast],
	);

	const interrupt = useCallback<CodexContextValue["interrupt"]>(async () => {
		const s = stateRef.current;
		const threadId = s.activeThread?.id;
		if (!threadId) return;
		const inProgress = s.turns.find((t) => t.status === "inProgress");
		const turnId = s.streamingTurnId ?? inProgress?.id;
		if (!turnId) {
			toast("No running turn to interrupt", "info");
			return;
		}
		try {
			await rpc(CODEX.turnInterrupt, { threadId, turnId });
		} catch (err) {
			toast(errorMessage(err), "error");
		}
	}, [rpc, toast]);

	const respondApproval = useCallback<CodexContextValue["respondApproval"]>(
		(id, decision, method) => {
			const socket = socketRef.current;
			if (!socket) return;
			// The v2 approval decisions use "accept"/"acceptForSession"/"decline"/"cancel".
			socket.reply(id, { decision });
			dispatch({ type: "request/remove", id });
			void method;
		},
		[],
	);

	const respondUserInput = useCallback<CodexContextValue["respondUserInput"]>((id, answers) => {
		const socket = socketRef.current;
		if (!socket) return;
		const payload: Record<string, { answers: string[] }> = {};
		for (const [key, value] of Object.entries(answers)) payload[key] = { answers: value };
		socket.reply(id, { answers: payload });
		dispatch({ type: "request/remove", id });
	}, []);

	const dismissRequest = useCallback((id: RequestId) => dispatch({ type: "request/remove", id }), []);

	const rejectRequest = useCallback((id: RequestId) => {
		const socket = socketRef.current;
		if (!socket) return;
		socket.replyError(id, { code: -32601, message: "Not supported by this client" });
		dispatch({ type: "request/remove", id });
	}, []);

	const renameThread = useCallback<CodexContextValue["renameThread"]>(
		async (threadId, name) => {
			try {
				await rpc(CODEX.threadSetName, { threadId, name });
				dispatch({ type: "threads/patch", threadId, patch: { name } });
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, toast],
	);

	const archiveThread = useCallback<CodexContextValue["archiveThread"]>(
		async (threadId, archived = true) => {
			try {
				await rpc(archived ? CODEX.threadArchive : CODEX.threadUnarchive, { threadId });
				dispatch({ type: "threads/remove", threadId });
				if (stateRef.current.activeThread?.id === threadId) dispatch({ type: "reset" });
				toast(archived ? "Thread archived" : "Thread restored", "success");
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, toast],
	);

	const deleteThread = useCallback<CodexContextValue["deleteThread"]>(
		async (threadId) => {
			try {
				await rpc(CODEX.threadDelete, { threadId });
				dispatch({ type: "threads/remove", threadId });
				if (stateRef.current.activeThread?.id === threadId) dispatch({ type: "reset" });
				toast("Thread deleted", "success");
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, toast],
	);

	const forkThread = useCallback<CodexContextValue["forkThread"]>(
		async (threadId) => {
			try {
				const res = await rpc<{ thread?: Thread }>(CODEX.threadFork, { threadId });
				const thread = res?.thread;
				if (thread && typeof thread === "object") {
					applyThreadResult(thread as Thread);
					void listThreads({ append: false });
					toast("Thread forked", "success");
				}
			} catch (err) {
				toast(errorMessage(err), "error");
			}
		},
		[rpc, applyThreadResult, listThreads, toast],
	);

	const restartCodex = useCallback<CodexContextValue["restartCodex"]>(async () => {
		try {
			await rpc(LOCAL_METHODS.codexRestart, undefined, 30_000);
			toast("Restarting codex…", "info");
		} catch (err) {
			toast(errorMessage(err), "error");
		}
	}, [rpc, toast]);

	const fetchLogs = useCallback<CodexContextValue["fetchLogs"]>(async () => {
		try {
			const res = await rpc<{ lines?: unknown }>(LOCAL_METHODS.codexLog);
			return Array.isArray(res?.lines) ? res.lines.map((l) => String(l)) : [];
		} catch (err) {
			toast(errorMessage(err), "error");
			return [];
		}
	}, [rpc, toast]);

	const fetchRequestLogs = useCallback<CodexContextValue["fetchRequestLogs"]>(
		async (threadId) => {
			try {
				const res = await rpc<unknown>(LOCAL_METHODS.requestLogsList, { threadId, limit: 400 });
				return asArray<RequestLogSummary>(res);
			} catch (err) {
				toast(errorMessage(err), "error");
				return [];
			}
		},
		[rpc, toast],
	);

	const fetchRequestLog = useCallback<CodexContextValue["fetchRequestLog"]>(
		async (id) => {
			try {
				return await rpc<RequestLogDetail | null>(LOCAL_METHODS.requestLogsDetail, { id });
			} catch (err) {
				toast(errorMessage(err), "error");
				return null;
			}
		},
		[rpc, toast],
	);

	const readFile = useCallback<CodexContextValue["readFile"]>(
		async (path) => {
			const res = await rpc<{ path?: string; text?: string; truncated?: boolean }>(LOCAL_METHODS.fsRead, { path });
			return { path: asString(res?.path) ?? path, text: asString(res?.text) ?? "", truncated: res?.truncated === true };
		},
		[rpc],
	);

	const listFiles = useCallback<CodexContextValue["listFiles"]>(
		async (path) => {
			const res = await rpc<{ path?: string; entries?: unknown }>(LOCAL_METHODS.fsList, { path });
			return { path: asString(res?.path) ?? path, entries: asArray<FsEntry>(res?.entries) };
		},
		[rpc],
	);

	const paths = useCallback<CodexContextValue["paths"]>(() => rpc<CwPaths>(LOCAL_METHODS.paths), [rpc]);

	const searchFiles = useCallback<CodexContextValue["searchFiles"]>(
		async (query) => {
			const s = stateRef.current;
			const roots = s.settings.cwd ? [s.settings.cwd] : s.info?.cwd ? [s.info.cwd] : [];
			const res = await rpc<{ files?: unknown }>(CODEX.fuzzyFileSearch, {
				query,
				roots,
				cancellationToken: null,
			});
			const files = asArray<Record<string, unknown>>(res?.files);
			return files
				.map((f) => ({
					path: asString(f.path) ?? "",
					fileName: asString(f.file_name) ?? asString(f.fileName) ?? basename(asString(f.path)),
					root: asString(f.root) ?? "",
				}))
				.filter((f) => f.path.length > 0);
		},
		[rpc],
	);

	const refreshStatus = useCallback(() => {
		void rpc(LOCAL_METHODS.codexStatus).then(
			(res) => {
				if (isRecord(res) && isRecord(res.status)) dispatch({ type: "status", status: res.status as unknown as CodexStatus });
			},
			() => undefined,
		);
	}, [rpc]);

	const reconnect = useCallback(() => {
		const socket = socketRef.current;
		if (!socket) return;
		socket.connect();
	}, []);

	const setModel = useCallback((model: string | null) => dispatch({ type: "settings", patch: { model } }), []);
	const setEffort = useCallback((effort: string | null) => dispatch({ type: "settings", patch: { effort } }), []);
	const setApprovalPolicy = useCallback(
		(policy: ApprovalPolicy) => dispatch({ type: "settings", patch: { approvalPolicy: policy } }),
		[],
	);
	const setSandbox = useCallback((sandbox: SandboxMode) => dispatch({ type: "settings", patch: { sandbox } }), []);
	const setReviewer = useCallback(
		(reviewer: ApprovalsReviewer | null) => dispatch({ type: "settings", patch: { reviewer } }),
		[],
	);
	const setCwd = useCallback((cwd: string) => {
		storeProject(cwd);
		dispatch({ type: "settings", patch: { cwd } });
	}, []);
	const setAutoApprove = useCallback((value: boolean) => dispatch({ type: "settings", patch: { autoApprove: value } }), []);
	const setArchivedView = useCallback((value: boolean) => {
		// ThreadList observes `archived` and re-fetches; no direct call needed here.
		dispatch({ type: "archived", value });
	}, []);
	const setSearchTerm = useCallback((term: string) => dispatch({ type: "search", term }), []);

	const openFilePreview = useCallback((path: string) => {
		previewRef.current = path;
		setPreviewFile(path);
	}, []);
	const closeFilePreview = useCallback(() => {
		previewRef.current = null;
		setPreviewFile(null);
	}, []);

	const dismissToast = useCallback((id: string) => dispatch({ type: "toast/remove", id }), []);

	const value = useMemo<CodexContextValue>(
		() => ({
			...state,
			streaming: state.streamingTurnId != null,
			listThreads,
			refreshProjects,
			selectProject,
			loadThread,
			resumeThread,
			openThread,
			startThread,
			renameThread,
			archiveThread,
			deleteThread,
			forkThread,
			setArchivedView,
			setSearchTerm,
			sendMessage,
			interrupt,
			respondApproval,
			respondUserInput,
			dismissRequest,
			rejectRequest,
			setModel,
			setEffort,
			setApprovalPolicy,
			setSandbox,
			setReviewer,
			setCwd,
			setAutoApprove,
			restartCodex,
			fetchLogs,
			fetchRequestLogs,
			fetchRequestLog,
			readFile,
			listFiles,
			paths,
			searchFiles,
			toast,
			dismissToast,
			refreshStatus,
			reconnect,
			previewFile,
			openFilePreview,
			closeFilePreview,
		}),
		[
			state,
			listThreads,
			refreshProjects,
			selectProject,
			loadThread,
			resumeThread,
			openThread,
			startThread,
			renameThread,
			archiveThread,
			deleteThread,
			forkThread,
			setArchivedView,
			setSearchTerm,
			sendMessage,
			interrupt,
			respondApproval,
			respondUserInput,
			dismissRequest,
			rejectRequest,
			setModel,
			setEffort,
			setApprovalPolicy,
			setSandbox,
			setReviewer,
			setCwd,
			setAutoApprove,
			restartCodex,
			fetchLogs,
			fetchRequestLogs,
			fetchRequestLog,
			readFile,
			listFiles,
			paths,
			searchFiles,
			toast,
			dismissToast,
			refreshStatus,
			reconnect,
			previewFile,
			openFilePreview,
			closeFilePreview,
		],
	);

	return <CodexContext.Provider value={value}>{children}</CodexContext.Provider>;
}

export function useCodex(): CodexContextValue {
	const ctx = useContext(CodexContext);
	if (!ctx) throw new Error("useCodex must be used inside <CodexProvider>");
	return ctx;
}
