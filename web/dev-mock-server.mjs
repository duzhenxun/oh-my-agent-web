// web/.mock — DEV-ONLY mock of the open-web-app server. It is NOT imported by
// the app bundle; run it manually:
//
//   node web/dev-mock-server.mjs
//
// It listens on ws://127.0.0.1:25257/ws (the same port Vite proxies to in dev)
// and speaks the frozen envelope from shared/protocol.ts. It replays a
// realistic recorded session: welcome + status, a thread list, history with
// lots of item types, plus a live turn with streaming reasoning / agent text /
// command output, a diff, token usage and a command-approval serverRequest.

import { WebSocketServer } from "ws";

const PORT = Number(process.env.CW_MOCK_PORT || 25257);
const CWD = process.env.CW_MOCK_CWD || "/Users/dev/projects/demo-app";
const NOW = Math.floor(Date.now() / 1000);

/* ------------------------------------------------------------------ */
/* helpers                                                             */
/* ------------------------------------------------------------------ */

let seq = 0;
const rid = (p) => `${p}-${++seq}`;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(ws, msg) {
	if (ws.readyState !== ws.OPEN) return;
	ws.send(JSON.stringify(msg));
}
const event = (ws, method, params) => send(ws, { type: "event", method, params });
const rpcResult = (ws, requestId, result) => send(ws, { type: "rpcResult", requestId, ok: true, result });
const rpcError = (ws, requestId, message) =>
	send(ws, { type: "rpcResult", requestId, ok: false, error: { code: -32000, message } });

const status = {
	phase: "ready",
	url: "ws://127.0.0.1:25258",
	pid: 4242,
	connected: true,
	error: null,
	since: Date.now(),
	restarts: 0,
};

/* ------------------------------------------------------------------ */
/* threads                                                             */
/* ------------------------------------------------------------------ */

function baseThread(over) {
	return {
		id: rid("thread"),
		sessionId: rid("session"),
		forkedFromId: null,
		parentThreadId: null,
		preview: "",
		ephemeral: false,
		section: null,
		sectionEnteredAt: null,
		projectId: null,
		historyMode: "default",
		modelProvider: "openai",
		model: "gpt-5-codex",
		reasoningEffort: "medium",
		createdAt: NOW,
		updatedAt: NOW,
		recencyAt: NOW,
		status: { type: "idle" },
		path: null,
		cwd: CWD,
		cliVersion: "0.0.0-mock",
		originator: "open-web-app",
		source: "cli",
		threadSource: null,
		agentNickname: null,
		agentRole: null,
		gitInfo: null,
		name: null,
		turns: [],
		...over,
	};
}

const T_HIST = "thread-hist-0001";
const T_IDLE = "thread-idle-0002";

const reasoningItem = (id, summary, content) => ({ type: "reasoning", id, summary, content });
const agentItem = (id, text) => ({
	type: "agentMessage",
	id,
	text,
	phase: null,
	memoryCitation: null,
	delivery: null,
	questions: null,
});
const userItem = (id, text, mentions = []) => ({
	type: "userMessage",
	id,
	clientId: null,
	content: [{ type: "text", text, text_elements: [] }, ...mentions],
});

const DIFF_ONE = `diff --git a/src/server.ts b/src/server.ts
index 1111111..2222222 100644
--- a/src/server.ts
+++ b/src/server.ts
@@ -1,6 +1,9 @@
 import express from "express";
 
-const app = express();
+const app = express();
+app.use(express.json());
+
+app.get("/health", (_req, res) => res.json({ ok: true }));
 
 export default app;
`;

function seedHistory() {
	const t1 = {
		id: "turn-hist-1",
		items: [
			userItem("u1", "Add a /health endpoint and wire JSON parsing.", [
				{ type: "mention", name: "server.ts", path: `${CWD}/src/server.ts` },
			]),
			reasoningItem(
				"r1",
				["Need to inspect the express setup before adding a route."],
				["The file appears to create an express app and export it. I'll add express.json() and a health route."],
			),
			agentItem(
				"a1",
				[
					"Adding a `/health` route and JSON body parsing.",
					"",
					"```ts",
					'app.get("/health", (_req, res) => res.json({ ok: true }));',
					"```",
					"",
					"See [server.ts](/Users/dev/projects/demo-app/src/server.ts) for the change.",
					"",
					"| route | method |",
					"| --- | --- |",
					"| /health | GET |",
				].join("\n"),
			),
			{
				type: "commandExecution",
				id: "c1",
				pluginId: null,
				scriptPath: null,
				command: "npm test -- --runInBand",
				cwd: CWD,
				processId: null,
				source: "unknown",
				status: "completed",
				commandActions: [{ type: "unknown", command: "npm test" }],
				aggregatedOutput: "PASS src/server.test.ts\n  ✓ health returns ok (12 ms)\n\nTests: 1 passed, 1 total\n",
				exitCode: 0,
				durationMs: 1840,
			},
			{
				type: "fileChange",
				id: "f1",
				status: "completed",
				changes: [{ path: "src/server.ts", kind: { type: "update", move_path: null }, diff: DIFF_ONE }],
			},
			{
				type: "plan",
				id: "p1",
				text: "1. Inspect server.ts\n2. Add JSON middleware\n3. Add /health\n4. Run tests",
			},
			{
				type: "mcpToolCall",
				id: "m1",
				server: "linear",
				tool: "search_issues",
				status: "completed",
				arguments: { query: "health endpoint" },
				appContext: null,
				mcpAppUi: null,
				pluginId: null,
				readOnlyHint: true,
				result: { issues: [{ id: "LIN-12", title: "Add health check" }] },
				error: null,
				durationMs: 240,
			},
			{
				type: "webSearch",
				id: "w1",
				query: "express json body parser",
				action: { type: "search", query: "express json body parser", queries: ["express.json"] },
				results: [{ title: "Express docs", url: "https://expressjs.com" }],
			},
			{
				type: "functionCallOutput",
				id: "fo1",
				name: "read_file",
				namespace: null,
				output: "1  import express from \"express\";\n2  \n3  const app = express();",
			},
			{
				type: "imageGeneration",
				id: "img1",
				status: "completed",
				revisedPrompt: "A minimal health-check diagram",
				result: "data:image/svg+xml;utf8," + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40"><rect width="120" height="40" rx="8" fill="#8b7bff"/><text x="60" y="25" fill="white" font-size="12" text-anchor="middle">healthy</text></svg>'),
				transparentBackground: false,
				failure: null,
				savedPath: `${CWD}/artifacts/health.svg`,
			},
			{ type: "subAgentActivity", id: "sa1", kind: "spawned", agentThreadId: "sub-1", agentPath: "agents/reviewer" },
			{ type: "contextCompaction", id: "cc1" },
			{ type: "enteredReviewMode", id: "rv1", review: "Reviewing the diff for safety." },
			{ type: "exitedReviewMode", id: "rv2", review: "No issues found." },
			{ type: "sleep", id: "sl1", durationMs: 500 },
			{
				type: "collabAgentToolCall",
				id: "ca1",
				tool: "spawn_agent",
				status: "completed",
				senderThreadId: T_HIST,
				receiverThreadIds: ["sub-1"],
				prompt: "review the patch",
				model: "gpt-5-codex",
				reasoningEffort: "low",
				agentsStates: {},
			},
		],
		itemsView: "full",
		status: "completed",
		error: null,
		startedAt: NOW - 600,
		completedAt: NOW - 580,
		durationMs: 20000,
	};
	const t2 = {
		id: "turn-hist-2",
		items: [
			userItem("u2", "Great, now document it in the README."),
			reasoningItem("r2", ["A short section is enough."], ["Add a small Health section."]),
			agentItem("a2", "Done — added a **Health** section to `README.md`."),
		],
		itemsView: "full",
		status: "completed",
		error: null,
		startedAt: NOW - 400,
		completedAt: NOW - 390,
		durationMs: 10000,
	};
	return [t1, t2];
}

const threads = new Map();
threads.set(
	T_HIST,
	baseThread({
		id: T_HIST,
		name: "Add /health endpoint",
		preview: "Add a /health endpoint and wire JSON parsing.",
		updatedAt: NOW - 390,
		recencyAt: NOW - 390,
		status: { type: "idle" },
		turns: seedHistory(),
	}),
);
threads.set(
	T_IDLE,
	baseThread({
		id: T_IDLE,
		name: null,
		preview: "Refactor the auth middleware to support refresh tokens.",
		updatedAt: NOW - 60 * 60 * 20,
		recencyAt: NOW - 60 * 60 * 20,
		status: { type: "active", activeFlags: ["waitingOnApproval"] },
	}),
);
threads.set(
	"thread-arch-0003",
	baseThread({
		id: "thread-arch-0003",
		name: "Old experiment",
		preview: "Try the streaming API",
		updatedAt: NOW - 60 * 60 * 24 * 40,
		recencyAt: NOW - 60 * 60 * 24 * 40,
		status: { type: "idle" },
	}),
);

const archived = new Set(["thread-arch-0003"]);

/* ------------------------------------------------------------------ */
/* models / files                                                      */
/* ------------------------------------------------------------------ */

const MODELS = [
	{
		id: "gpt-5-codex",
		model: "gpt-5-codex",
		displayName: "GPT-5 Codex",
		description: "Best for agentic coding",
		isDefault: true,
		hidden: false,
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: [
			{ reasoningEffort: "low", description: "Fast" },
			{ reasoningEffort: "medium", description: "Balanced" },
			{ reasoningEffort: "high", description: "Most thorough" },
		],
	},
	{
		id: "gpt-5",
		model: "gpt-5",
		displayName: "GPT-5",
		description: "General purpose",
		isDefault: false,
		hidden: false,
		defaultReasoningEffort: "medium",
		supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "Balanced" }],
	},
];

function fsEntries(path) {
	const base = path.replace(/\/$/, "");
	return [
		{ name: "src", path: `${base}/src`, kind: "directory", size: 0, mtime: Date.now() },
		{ name: "README.md", path: `${base}/README.md`, kind: "file", size: 2200, mtime: Date.now() },
		{ name: "package.json", path: `${base}/package.json`, kind: "file", size: 900, mtime: Date.now() },
	];
}

function fsText(path) {
	if (path.endsWith("package.json")) {
		return `{\n  "name": "demo-app",\n  "version": "1.0.0",\n  "type": "module"\n}\n`;
	}
	if (path.endsWith("README.md")) {
		return `# Demo App\n\n## Health\n\nGET /health returns \`{ ok: true }\`.\n`;
	}
	return `// ${path}\nimport express from "express";\n\nconst app = express();\napp.use(express.json());\n\napp.get("/health", (_req, res) => res.json({ ok: true }));\n\nexport default app;\n`;
}

/* ------------------------------------------------------------------ */
/* live turn streaming                                                 */
/* ------------------------------------------------------------------ */

async function streamTurn(ws, threadId, turnId, prompt, initialItems = []) {
	const items = initialItems.slice();
	const add = async (item, completed) => {
		const idx = items.findIndex((i) => i.id === item.id);
		if (idx === -1) items.push(item);
		else items[idx] = item;
		if (!completed) event(ws, "item/started", { item, threadId, turnId, startedAtMs: Date.now() });
	};
	const finish = (item) => {
		const idx = items.findIndex((i) => i.id === item.id);
		if (idx === -1) items.push(item);
		else items[idx] = item;
		event(ws, "item/completed", { item, threadId, turnId, completedAtMs: Date.now() });
	};
	const turn = (status) => ({
		id: turnId,
		items: items.slice(),
		itemsView: "full",
		status,
		error: null,
		startedAt: Math.floor(Date.now() / 1000),
		completedAt: status === "inProgress" ? null : Math.floor(Date.now() / 1000),
		durationMs: null,
	});

	event(ws, "turn/started", { threadId, turn: turn("inProgress") });
	await sleep(250);

	// --- reasoning (streamed) ---
	const rItem = reasoningItem("r-live", [], []);
	const rc = { ...rItem, summary: [""] };
	await add(rItem, false);
	for (const chunk of ["Looking at the request. ", "I'll inspect the code, ", "run the tests, ", "then summarize."]) {
		rc.summary[0] += chunk;
		event(ws, "item/reasoning/summaryTextDelta", { threadId, turnId, itemId: rItem.id, delta: chunk, summaryIndex: 0 });
		await sleep(120);
	}
	for (const chunk of ["The repository uses express. ", "A focused change is enough."]) {
		rc.content = [(rc.content[0] ?? "") + chunk];
		event(ws, "item/reasoning/textDelta", { threadId, turnId, itemId: rItem.id, delta: chunk, contentIndex: 0 });
		await sleep(120);
	}
	finish(rc);

	// --- agent message (streamed markdown) ---
	const aItem = agentItem("a-live", "");
	await add(aItem, false);
	const md = [
		"I'll add a health check.\n\n",
		"First, let me look at the project:\n\n",
		"```bash\nls src\n```\n\n",
		"Then I'll add the route and run the tests.\n",
	];
	let acc = "";
	for (const chunk of md) {
		acc += chunk;
		const item = { ...aItem, text: acc };
		const idx = items.findIndex((i) => i.id === aItem.id);
		items[idx] = item;
		event(ws, "item/agentMessage/delta", { threadId, turnId, itemId: aItem.id, delta: chunk });
		await sleep(180);
	}
	finish({ ...aItem, text: acc });

	// --- command execution with approval + streamed output ---
	const cmdItem = {
		type: "commandExecution",
		id: "c-live",
		pluginId: null,
		scriptPath: null,
		command: "npm test -- --runInBand",
		cwd: CWD,
		processId: "pty-1",
		source: "unknown",
		status: "inProgress",
		commandActions: [{ type: "unknown", command: "npm test" }],
		aggregatedOutput: "",
		exitCode: null,
		durationMs: null,
	};
	await add(cmdItem, false);
	await sleep(200);

	const approvalId = rid("approval");
	const approved = await requestApproval(ws, {
		id: approvalId,
		method: "item/commandExecution/requestApproval",
		params: {
			kind: "command",
			threadId,
			turnId,
			itemId: cmdItem.id,
			startedAtMs: Date.now(),
			approvalId: null,
			environmentId: null,
			reason: "The command runs the full test suite.",
			command: "npm test -- --runInBand",
			cwd: CWD,
			commandActions: [{ type: "unknown", command: "npm test" }],
		},
	});
	event(ws, "serverRequest/resolved", { threadId, requestId: approvalId });

	let output = "";
	if (approved === "accept" || approved === "acceptForSession") {
		for (const chunk of ["RUNS  src/server.test.ts\n", "PASS  src/server.test.ts\n", "  ✓ health returns ok (11 ms)\n", "\nTests: 1 passed, 1 total\n"]) {
			output += chunk;
			const idx = items.findIndex((i) => i.id === cmdItem.id);
			items[idx] = { ...cmdItem, aggregatedOutput: output };
			event(ws, "item/commandExecution/outputDelta", { threadId, turnId, itemId: cmdItem.id, delta: chunk });
			await sleep(150);
		}
		finish({ ...cmdItem, status: "completed", aggregatedOutput: output, exitCode: 0, durationMs: 1500 });
	} else {
		finish({ ...cmdItem, status: "declined", aggregatedOutput: "Command declined by user.\n", exitCode: null, durationMs: 0 });
	}

	// --- plan ---
	event(ws, "turn/plan/updated", {
		threadId,
		turnId,
		explanation: "Small, safe change.",
		plan: [
			{ step: "Inspect project", status: "completed" },
			{ step: "Run tests", status: "completed" },
			{ step: "Summarize", status: "inProgress" },
		],
	});

	// --- file change + aggregated diff ---
	const fileItem = {
		type: "fileChange",
		id: "f-live",
		status: "completed",
		changes: [{ path: "src/server.ts", kind: { type: "update", move_path: null }, diff: DIFF_ONE }],
	};
	await add(fileItem, false);
	finish(fileItem);
	event(ws, "turn/diff/updated", { threadId, turnId, diff: DIFF_ONE });

	// --- token usage ---
	event(ws, "thread/tokenUsage/updated", {
		threadId,
		turnId,
		tokenUsage: {
			total: { totalTokens: 15234, inputTokens: 12000, cachedInputTokens: 4000, cacheWriteInputTokens: 0, outputTokens: 3234, reasoningOutputTokens: 1200 },
			last: { totalTokens: 6120, inputTokens: 5000, cachedInputTokens: 2000, cacheWriteInputTokens: 0, outputTokens: 1120, reasoningOutputTokens: 400 },
			modelContextWindow: 272000,
		},
	});
	await sleep(120);

	// --- final assistant message ---
	const a2 = { ...agentItem("a-live-2", "All set. The `/health` route is in place and the tests pass.") };
	await add(a2, false);
	finish(a2);

	event(ws, "turn/completed", { threadId, turn: turn("completed") });
}

let approvalSeq = 0;
const pendingApprovals = new Map();

function requestApproval(ws, { id, method, params }) {
	return new Promise((resolve) => {
		pendingApprovals.set(String(id), resolve);
		send(ws, { type: "serverRequest", id, method, params });
		// Safety net: don't hang a demo forever.
		setTimeout(() => {
			if (pendingApprovals.has(String(id))) {
				pendingApprovals.delete(String(id));
				resolve("cancel");
			}
		}, 60000);
	});
}

/* ------------------------------------------------------------------ */
/* connection handling                                                 */
/* ------------------------------------------------------------------ */

const wss = new WebSocketServer({ port: PORT, path: "/ws" });

wss.on("connection", (ws) => {
	send(ws, {
		type: "welcome",
		info: {
			version: "0.1.0-mock",
			protocolVersion: 1,
			cwd: CWD,
			codexUrl: "ws://127.0.0.1:25258",
			codexVersion: "0.0.0-mock",
			platform: process.platform,
		},
	});
	send(ws, { type: "status", codex: { ...status, since: Date.now() } });

	ws.on("message", (raw) => {
		let msg;
		try {
			msg = JSON.parse(String(raw));
		} catch {
			return;
		}
		handleMessage(ws, msg).catch((err) => {
			console.error("[mock] handler error", err);
		});
	});
});

async function handleMessage(ws, msg) {
	if (msg.type === "ping") {
		send(ws, { type: "pong" });
		return;
	}
	if (msg.type === "reply") {
		const key = String(msg.id);
		const resolve = pendingApprovals.get(key);
		if (resolve) {
			pendingApprovals.delete(key);
			const result = msg.result;
			const decision = result && typeof result === "object" ? result.decision ?? result.action : undefined;
			resolve(decision ?? "accept");
		}
		return;
	}
	if (msg.type !== "rpc") return;

	const { requestId, method, params = {} } = msg;
	switch (method) {
		case "initialize":
			rpcResult(ws, requestId, { userAgent: "mock" });
			return;
		case "model/list":
			rpcResult(ws, requestId, { data: MODELS, nextCursor: null });
			return;
		case "account/read":
			rpcResult(ws, requestId, { account: { type: "chatgpt", email: "dev@example.com", planType: "plus" }, requiresOpenaiAuth: false });
			return;
		case "cw/paths":
			rpcResult(ws, requestId, { cwd: CWD, home: "/Users/dev", codexHome: "/Users/dev/.codex" });
			return;
		case "cw/codex/status":
			rpcResult(ws, requestId, { status });
			return;
		case "cw/codex/restart":
			status.restarts += 1;
			rpcResult(ws, requestId, { ok: true });
			setTimeout(() => send(ws, { type: "status", codex: { ...status, phase: "ready", since: Date.now() } }), 800);
			return;
		case "cw/codex/log":
			rpcResult(ws, requestId, {
				lines: [
					"[mock] app-server listening on ws://127.0.0.1:25258",
					"[mock] initialize ok",
					"[mock] thread/hist loaded",
				],
			});
			return;
		case "cw/fs/list": {
			const path = typeof params.path === "string" && params.path ? params.path : CWD;
			rpcResult(ws, requestId, { path, entries: fsEntries(path) });
			return;
		}
		case "cw/fs/read": {
			const path = typeof params.path === "string" ? params.path : "";
			rpcResult(ws, requestId, { path, text: fsText(path), truncated: false });
			return;
		}
		case "fuzzyFileSearch": {
			const query = String(params.query ?? "").toLowerCase();
			const all = [
				{ root: CWD, path: `${CWD}/src/server.ts`, match_type: "file", file_name: "server.ts", score: 1, indices: null },
				{ root: CWD, path: `${CWD}/src/app.tsx`, match_type: "file", file_name: "app.tsx", score: 0.8, indices: null },
				{ root: CWD, path: `${CWD}/README.md`, match_type: "file", file_name: "README.md", score: 0.5, indices: null },
				{ root: CWD, path: `${CWD}/package.json`, match_type: "file", file_name: "package.json", score: 0.4, indices: null },
			];
			rpcResult(ws, requestId, { files: all.filter((f) => !query || f.path.toLowerCase().includes(query) || f.file_name.toLowerCase().includes(query)) });
			return;
		}
		case "thread/list": {
			const wantArchived = params.archived === true;
			const term = String(params.searchTerm ?? "").toLowerCase();
			const all = [...threads.values()].filter((t) => archived.has(t.id) === wantArchived);
			const filtered = term
				? all.filter((t) => `${t.name ?? ""} ${t.preview}`.toLowerCase().includes(term))
				: all;
			const withTurns = filtered.map((t) => ({ ...t, turns: [] }));
			rpcResult(ws, requestId, { data: withTurns, nextCursor: null, backwardsCursor: null });
			return;
		}
		case "thread/read": {
			const t = threads.get(params.threadId);
			if (!t) return rpcError(ws, requestId, `no such thread ${params.threadId}`);
			rpcResult(ws, requestId, { thread: { ...t, turns: params.includeTurns ? t.turns : [] } });
			return;
		}
		case "thread/resume": {
			const t = threads.get(params.threadId);
			if (!t) return rpcError(ws, requestId, `no such thread ${params.threadId}`);
			t.status = { type: "active", activeFlags: [] };
			rpcResult(ws, requestId, {
				thread: { ...t, turns: t.turns },
				model: t.model,
				modelProvider: "openai",
				serviceTier: null,
				disabledPluginIds: [],
				cwd: t.cwd,
				instructionSources: [],
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
				reasoningEffort: t.reasoningEffort,
				collaborationMode: null,
				turnsBackwardsCursor: null,
				itemsBackwardsCursor: null,
			});
			return;
		}
		case "thread/start": {
			const t = baseThread({
				name: null,
				preview: "",
				cwd: typeof params.cwd === "string" && params.cwd ? params.cwd : CWD,
				model: typeof params.model === "string" && params.model ? params.model : "gpt-5-codex",
				createdAt: Math.floor(Date.now() / 1000),
				updatedAt: Math.floor(Date.now() / 1000),
				recencyAt: Math.floor(Date.now() / 1000),
				status: { type: "active", activeFlags: [] },
				turns: [],
			});
			threads.set(t.id, t);
			rpcResult(ws, requestId, {
				thread: t,
				model: t.model,
				modelProvider: "openai",
				serviceTier: null,
				disabledPluginIds: [],
				cwd: t.cwd,
				instructionSources: [],
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
				reasoningEffort: t.reasoningEffort,
			});
			event(ws, "thread/started", { thread: { ...t, turns: [] } });
			return;
		}
		case "thread/name/set": {
			const t = threads.get(params.threadId);
			if (t) {
				t.name = String(params.name ?? "");
				event(ws, "thread/name/updated", { threadId: t.id, threadName: t.name });
			}
			rpcResult(ws, requestId, { ok: true });
			return;
		}
		case "thread/archive": {
			archived.add(params.threadId);
			event(ws, "thread/archived", { threadId: params.threadId });
			rpcResult(ws, requestId, { ok: true });
			return;
		}
		case "thread/unarchive": {
			archived.delete(params.threadId);
			event(ws, "thread/unarchived", { threadId: params.threadId });
			rpcResult(ws, requestId, { ok: true });
			return;
		}
		case "thread/delete": {
			threads.delete(params.threadId);
			archived.delete(params.threadId);
			event(ws, "thread/deleted", { threadId: params.threadId });
			rpcResult(ws, requestId, { ok: true });
			return;
		}
		case "thread/fork": {
			const src = threads.get(params.threadId);
			if (!src) return rpcError(ws, requestId, "no such thread");
			const t = { ...baseThread(), name: src.name ? `${src.name} (fork)` : "Fork", preview: src.preview, turns: src.turns, forkedFromId: src.id };
			threads.set(t.id, t);
			rpcResult(ws, requestId, {
				thread: t,
				model: t.model,
				modelProvider: "openai",
				serviceTier: null,
				disabledPluginIds: [],
				cwd: t.cwd,
				instructionSources: [],
				approvalPolicy: "on-request",
				approvalsReviewer: "user",
				sandbox: { type: "workspaceWrite", writableRoots: [], networkAccess: false, excludeTmpdirEnvVar: false, excludeSlashTmp: false },
				reasoningEffort: t.reasoningEffort,
			});
			return;
		}
		case "turn/start": {
			const threadId = params.threadId;
			const t = threads.get(threadId);
			if (!t) return rpcError(ws, requestId, "no such thread");
			const turnId = rid("turn");
			const input = Array.isArray(params.input) ? params.input : [];
			const text = input.find((i) => i && i.type === "text")?.text ?? "";
			const userMsg = {
				type: "userMessage",
				id: rid("u"),
				clientId: null,
				content: input.length ? input : [{ type: "text", text, text_elements: [] }],
			};
			const turn = {
				id: turnId,
				items: [userMsg],
				itemsView: "full",
				status: "inProgress",
				error: null,
				startedAt: Math.floor(Date.now() / 1000),
				completedAt: null,
				durationMs: null,
			};
			t.turns = [...t.turns, turn];
			t.updatedAt = Math.floor(Date.now() / 1000);
			t.recencyAt = t.updatedAt;
			rpcResult(ws, requestId, { turn });
			// Replace the seeded user message items with the streaming sequence.
			streamTurn(ws, threadId, turnId, text, [userMsg]).catch((err) => console.error("[mock] stream error", err));
			return;
		}
		case "turn/interrupt": {
			rpcResult(ws, requestId, { ok: true });
			event(ws, "turn/completed", {
				threadId: params.threadId,
				turn: {
					id: params.turnId,
					items: [],
					itemsView: "summary",
					status: "interrupted",
					error: null,
					startedAt: null,
					completedAt: Math.floor(Date.now() / 1000),
					durationMs: 0,
				},
			});
			return;
		}
		default:
			rpcError(ws, requestId, `mock does not implement ${method}`);
	}
}

console.log(`[mock] open-web-app mock server on ws://127.0.0.1:${PORT}/ws`);
console.log(`[mock] cwd = ${CWD}`);
void approvalSeq;
