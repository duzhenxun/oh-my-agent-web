/**
 * Smoke test — boots a real open-web-app server against a real `codex app-server`.
 *
 * 运行： npm run smoke
 *
 * 覆盖：
 *  1. 程序化启动（临时端口 + 临时 cwd），等到 supervisor ready 且 client 已 initialize。
 *  2. 浏览器 WS 握手（welcome / status）。
 *  3. owa/paths、thread/start、turn/start（真实模型调用，可能因未登录而 SKIP 模型部分）。
 *  4. thread/list、thread/read（非模型，必须通过）。
 *  5. 干净关闭；任何硬断言失败以非 0 退出。
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import { WebSocket } from "ws";

import { startServer, type ServerHandle } from "../server/index.js";
import type { ServerMessage } from "../shared/protocol.js";

const SMOKE_CWD = "/tmp/open-web-app-smoke";
const CODEX_READY_TIMEOUT_MS = 40_000;
const INIT_TIMEOUT_MS = 30_000;
const TURN_TIMEOUT_MS = 180_000;

let passCount = 0;
let skipCount = 0;
let failCount = 0;

function pass(label: string): void {
	passCount += 1;
	console.log(`  ✅ PASS  ${label}`);
}
function skip(label: string, reason: string): void {
	skipCount += 1;
	console.log(`  ⏭️  SKIP  ${label}\n           reason: ${reason}`);
}
function fail(label: string, reason: string): void {
	failCount += 1;
	console.error(`  ❌ FAIL  ${label}\n           reason: ${reason}`);
}

function assert(cond: unknown, label: string, detail = ""): boolean {
	if (cond) pass(label);
	else fail(label, detail || "assertion failed");
	return Boolean(cond);
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function delay(ms: number): Promise<void> {
	return new Promise((r) => setTimeout(r, ms));
}

function freePort(): Promise<number> {
	return new Promise((resolveP, rejectP) => {
		const srv = createServer();
		srv.on("error", rejectP);
		srv.listen(0, "127.0.0.1", () => {
			const addr = srv.address();
			const port = typeof addr === "object" && addr ? addr.port : 0;
			srv.close(() => resolveP(port));
		});
	});
}

type Predicate = (m: ServerMessage) => boolean;

class BrowserClient {
	messages: ServerMessage[] = [];
	private waiters: Array<{ pred: Predicate; resolve: (m: ServerMessage) => void; timer: NodeJS.Timeout }> = [];
	private constructor(private readonly ws: WebSocket) {}

	static connect(url: string): Promise<BrowserClient> {
		return new Promise((resolveP, rejectP) => {
			const ws = new WebSocket(url);
			ws.on("error", (err) => rejectP(err));
			ws.on("open", () => {
				const client = new BrowserClient(ws);
				client.attach();
				resolveP(client);
			});
		});
	}

	private attach(): void {
		this.ws.on("message", (data) => {
			let msg: ServerMessage;
			try {
				msg = JSON.parse(data.toString("utf8")) as ServerMessage;
			} catch {
				return;
			}
			this.messages.push(msg);
			for (const w of [...this.waiters]) {
				if (!w.pred(msg)) continue;
				clearTimeout(w.timer);
				this.waiters.splice(this.waiters.indexOf(w), 1);
				w.resolve(msg);
			}
		});
	}

	send(msg: unknown): void {
		this.ws.send(JSON.stringify(msg));
	}

	waitFor(pred: Predicate, timeoutMs: number, label: string): Promise<ServerMessage> {
		for (const m of this.messages) if (pred(m)) return Promise.resolve(m);
		return new Promise((resolveP, rejectP) => {
			const timer = setTimeout(() => {
				const idx = this.waiters.findIndex((w) => w.timer === timer);
				if (idx >= 0) this.waiters.splice(idx, 1);
				rejectP(new Error(`timeout after ${timeoutMs}ms waiting for ${label}`));
			}, timeoutMs);
			this.waiters.push({ pred, resolve: resolveP, timer });
		});
	}

	close(): void {
		try {
			this.ws.close();
		} catch {
			/* ignore */
		}
	}
}

async function waitForCodexReady(handle: ServerHandle): Promise<void> {
	const deadline = Date.now() + CODEX_READY_TIMEOUT_MS;
	while (Date.now() < deadline) {
		const status = handle.supervisor.status();
		if (status.phase === "ready" && handle.client.isReady()) return;
		await delay(200);
	}
	const status = handle.supervisor.status();
	throw new Error(
		`codex not ready within ${CODEX_READY_TIMEOUT_MS}ms (phase=${status.phase}, connected=${status.connected}, error=${status.error})`,
	);
}

async function main(): Promise<void> {
	await mkdir(SMOKE_CWD, { recursive: true });
	const owaPort = await freePort();
	const codexPort = await freePort();
	console.log(`\n=== open-web-app smoke test ===`);
	console.log(`cwd=${SMOKE_CWD}  owaPort=${owaPort}  codexPort=${codexPort}\n`);

	let handle: ServerHandle | null = null;
	let browser: BrowserClient | null = null;
	try {
		handle = await startServer({ port: owaPort, host: "127.0.0.1", cwd: SMOKE_CWD, codexPort, quiet: true });

		// --- 1. supervisor / client readiness ---
		try {
			await waitForCodexReady(handle);
			const st = handle.supervisor.status();
			assert(st.phase === "ready", "supervisor phase ready");
			assert(handle.client.isReady(), "codex client initialized");
			console.log(`           mode=${handle.supervisor.isExternal() ? "external" : "managed"} pid=${st.pid ?? "null"}`);
		} catch (err) {
			fail("codex app-server ready", err instanceof Error ? err.message : String(err));
			throw err;
		}

		// --- 2. browser WS handshake ---
		browser = await BrowserClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
		const welcome = await browser.waitFor((m) => m.type === "welcome", INIT_TIMEOUT_MS, "welcome");
		assert(welcome.type === "welcome" && typeof welcome.info.version === "string", "browser receives welcome");
		const statusMsg = await browser.waitFor((m) => m.type === "status", INIT_TIMEOUT_MS, "status");
		assert(statusMsg.type === "status" && statusMsg.codex.phase === "ready", "browser receives ready status");

		let requestSeq = 0;
		const rpc = async (method: string, params?: unknown): Promise<unknown> => {
			const requestId = `smoke-${++requestSeq}`;
			const waiting = browser!.waitFor(
				(m) => m.type === "rpcResult" && m.requestId === requestId,
				INIT_TIMEOUT_MS,
				`rpcResult ${method}`,
			);
			browser!.send({ type: "rpc", requestId, method, params });
			const res = await waiting;
			if (res.type !== "rpcResult") throw new Error("unexpected message type");
			if (!res.ok) throw new Error(`${method} -> ${res.error.code} ${res.error.message}`);
			return res.result;
		};

		// --- 3. owa/paths (local method) ---
		try {
			const paths = await rpc("owa/paths");
			const ok = isRecord(paths) && typeof paths.cwd === "string" && typeof paths.home === "string";
			assert(ok, "owa/paths returns cwd/home/codexHome", JSON.stringify(paths));
			console.log(`           cwd=${(paths as Record<string, unknown>).cwd} codexHome=${(paths as Record<string, unknown>).codexHome}`);
		} catch (err) {
			fail("owa/paths", err instanceof Error ? err.message : String(err));
		}

		// --- 4. owa/fs/list + owa/fs/read (local methods) ---
		try {
			const listed = await rpc("owa/fs/list", { path: SMOKE_CWD });
			const entries = isRecord(listed) && Array.isArray(listed.entries) ? listed.entries : null;
			assert(entries !== null, "owa/fs/list returns entries");
		} catch (err) {
			fail("owa/fs/list", err instanceof Error ? err.message : String(err));
		}

		try {
			const textPath = `${SMOKE_CWD}/hello.txt`;
			await writeFile(textPath, "hello codex\n");
			const caught = await rpc("owa/fs/read", { path: textPath });
			assert(isRecord(caught) && caught.text === "hello codex\n", "owa/fs/read returns text");

			const binPath = `${SMOKE_CWD}/blob.bin`;
			await writeFile(binPath, Buffer.from([0x00, 0x01, 0x02, 0x00]));
			let refused = false;
			try {
				await rpc("owa/fs/read", { path: binPath });
			} catch {
				refused = true;
			}
			assert(refused, "owa/fs/read refuses binary files");
		} catch (err) {
			fail("owa/fs/read", err instanceof Error ? err.message : String(err));
		}

		// --- 5. thread/start ---
		let threadId: string | null = null;
		try {
			const started = await rpc("thread/start", {
				cwd: SMOKE_CWD,
				approvalPolicy: "never",
				sandbox: "workspace-write",
			});
			threadId = isRecord(started) && isRecord(started.thread) && typeof started.thread.id === "string" ? started.thread.id : null;
			assert(threadId !== null, "thread/start returns a thread id", JSON.stringify(started));
			if (threadId) console.log(`           threadId=${threadId}`);
		} catch (err) {
			fail("thread/start", err instanceof Error ? err.message : String(err));
		}

		if (threadId) {
			// --- 6. turn/start (real model call) ---
			const turnCompleted = browser.waitFor(
				(m) =>
					m.type === "event" &&
					(m.method === "turn/completed" || m.method === "error") &&
					isRecord(m.params) &&
					m.params.threadId === threadId,
				TURN_TIMEOUT_MS,
				"turn/completed or error",
			);

			let turnSkippedReason: string | null = null;
			try {
				const turnStarted = await rpc("turn/start", {
					threadId,
					input: [{ type: "text", text: "create a file smoke.txt containing ok then cat it", text_elements: [] }],
				});
				assert(isRecord(turnStarted) && isRecord(turnStarted.turn), "turn/start accepted");
			} catch (err) {
				turnSkippedReason = err instanceof Error ? err.message : String(err);
			}

			if (!turnSkippedReason) {
				try {
					const outcome = await turnCompleted;
					if (outcome.type === "event" && outcome.method === "error") {
						turnSkippedReason = `codex error event: ${JSON.stringify(outcome.params)}`;
					} else {
						pass("turn/completed received");
					}
				} catch (err) {
					turnSkippedReason = err instanceof Error ? err.message : String(err);
				}
			}

			if (turnSkippedReason) {
				skip("agentMessage deltas", turnSkippedReason);
				skip("tool item/started (commandExecution|fileChange)", turnSkippedReason);
			} else {
				const deltas = browser.messages.filter(
					(m) => m.type === "event" && m.method === "item/agentMessage/delta" && isRecord(m.params) && m.params.threadId === threadId,
				);
				assert(deltas.length > 0, "at least one item/agentMessage/delta event");

				const toolStarts = browser.messages.filter((m) => {
					if (m.type !== "event" || m.method !== "item/started" || !isRecord(m.params)) return false;
					const item = m.params.item;
					return isRecord(item) && (item.type === "commandExecution" || item.type === "fileChange");
				});
				assert(
					toolStarts.length > 0,
					"at least one item/started for commandExecution or fileChange",
					`found ${toolStarts.length}`,
				);
			}
		} else {
			skip("turn/start + model assertions", "thread/start did not yield a thread id");
		}

		// --- 7. thread/list (non-model) ---
		try {
			const listed = await rpc("thread/list", { cwd: SMOKE_CWD, limit: 50 });
			const data = isRecord(listed) && Array.isArray(listed.data) ? listed.data : null;
			const found = data?.some((t) => isRecord(t) && t.id === threadId) ?? false;
			assert(found, "thread/list contains the created thread");
		} catch (err) {
			fail("thread/list", err instanceof Error ? err.message : String(err));
		}

		// --- 8. thread/read (non-model) ---
		if (threadId) {
			try {
				const read = await rpc("thread/read", { threadId, includeTurns: true });
				const thread = isRecord(read) && isRecord(read.thread) ? read.thread : null;
				const turns = thread && Array.isArray(thread.turns) ? thread.turns : null;
				assert(turns !== null && turns.length > 0, "thread/read returns turns", JSON.stringify(read).slice(0, 200));
				const hasItems =
					turns?.some((t) => isRecord(t) && Array.isArray(t.items) && t.items.length > 0) ?? false;
				assert(hasItems, "thread/read turns contain items", JSON.stringify(turns).slice(0, 200));
			} catch (err) {
				fail("thread/read", err instanceof Error ? err.message : String(err));
			}
		}
		// --- 9. serverRequest broadcast + dedupe (synthetic; no model needed) ---
		if (handle) {
			try {
				const browser2 = await BrowserClient.connect(`ws://127.0.0.1:${handle.port}/ws`);
				try {
					await browser2.waitFor((m) => m.type === "welcome", INIT_TIMEOUT_MS, "welcome (tab 2)");
					const syntheticId = 424242;
					// 直接把一个假的审批请求塞进 client 事件流，验证广播 + 去重，不依赖真实审批。
					handle.client.emit("serverRequest", {
						id: syntheticId,
						method: "item/commandExecution/requestApproval",
						params: { threadId: "smoke-thread", command: "echo hi", cwd: SMOKE_CWD },
					});
					const reqPred: Predicate = (m) => m.type === "serverRequest" && m.id === syntheticId;
					const resolvedPred: Predicate = (m) =>
						m.type === "event" &&
						m.method === "serverRequest/resolved" &&
						isRecord(m.params) &&
						m.params.requestId === syntheticId;

					await browser.waitFor(reqPred, INIT_TIMEOUT_MS, "serverRequest on tab 1");
					await browser2.waitFor(reqPred, INIT_TIMEOUT_MS, "serverRequest on tab 2");
					assert(true, "serverRequest broadcast to all tabs");

					// tab 1 先答复。
					browser.send({ type: "reply", id: syntheticId, result: { decision: "accept" } });
					await browser.waitFor(resolvedPred, INIT_TIMEOUT_MS, "serverRequest/resolved on tab 1");
					await browser2.waitFor(resolvedPred, INIT_TIMEOUT_MS, "serverRequest/resolved on tab 2");
					assert(true, "serverRequest/resolved broadcast to all tabs");

					// tab 2 迟到的答复必须被忽略（不再重复广播 resolved）。
					const before = browser2.messages.filter(resolvedPred).length;
					browser2.send({ type: "reply", id: syntheticId, result: { decision: "decline" } });
					await delay(400);
					const after = browser2.messages.filter(resolvedPred).length;
					assert(after === before, "late duplicate reply is ignored (dedupe)");
				} finally {
					browser2.close();
				}
			} catch (err) {
				fail("serverRequest broadcast/dedupe", err instanceof Error ? err.message : String(err));
			}
		}
	} finally {
		browser?.close();
		if (handle) {
			await handle.close().catch(() => undefined);
		}
		await rm(SMOKE_CWD, { recursive: true, force: true }).catch(() => undefined);
	}

	console.log(`\n=== summary: ${passCount} passed, ${skipCount} skipped, ${failCount} failed ===\n`);
	if (failCount > 0) process.exit(1);
}

main().catch((err) => {
	console.error("\nsmoke test crashed:", err);
	process.exit(1);
});
