#!/usr/bin/env node
/**
 * oh-my-agent-web ws — 连接 codex app-server WebSocket 的命令行客户端。
 *
 * 参考 /Users/dds/data/ai/work/codex-ws-client.mjs，整理为 oh-my-agent-web 的子命令：
 *   oh-my-agent-web ws                          # 交互模式（Ctrl-C 中断当前 turn / Ctrl-D 退出）
 *   oh-my-agent-web ws "帮我看看这个目录"        # 单次提问后退出
 *   echo "写个 hello world" | oh-my-agent-web ws # 从管道读
 *   oh-my-agent-web ws --port 25259             # 指定端口
 *   oh-my-agent-web ws --url ws://host:port     # 指定完整地址
 *
 * 退出语义：turn 跑在 app-server 上而不在本进程里，所以直接掉线会留下一个没人看的
 * 生成过程（继续烧 token）。因此所有退出路径都走 shutdown()：先 `turn/interrupt`，
 * 再关连接。Ctrl-C 第一次 = 中断+关闭，第二次 = 立即退出。
 *
 * 仅用 Node 内置能力（WebSocket 需要 Node >= 22），无额外依赖。
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 25258;

const HELP = `oh-my-agent-web ws — connect to the codex app-server over WebSocket

Usage:
  oh-my-agent-web ws [options] ["message" ...]

Connection:
  --url <ws://host:port>   Full address (also accepts bare host:port). Default ws://${DEFAULT_HOST}:${DEFAULT_PORT}
  --addr <host:port>       Address + port (same as --host + --port)
  --host <host>            Host, default ${DEFAULT_HOST}
  -p, --port <n>           Port, default ${DEFAULT_PORT}
  Env: CODEX_WS_URL / CODEX_WS_HOST / CODEX_WS_PORT

Session:
  --cwd <dir>              Working directory (default: current dir)
  -t, --thread <id>        Resume an existing thread
  --model <name>           Model id (use /model interactively to list/switch)
  --sandbox <mode>         read-only | workspace-write | danger-full-access
  --approval <mode>        untrusted | on-request | on-failure | never
  -y, --auto-approve       Auto-accept approvals (acceptForSession)
  --decline                Auto-decline approvals
  -v, --verbose            Print reasoning deltas
  --json                   Print raw event JSON only
  --timeout <sec>          Max wait for a turn, default 1800
  --retry <n>              Retry a flagged/transient turn up to n times, default 1 (0 = off)
  --retry-delay <ms>       Base delay between retries, default 1000 (grows per attempt)
  -h, --help               Show this help

Interactive commands (type at the prompt):
  /model                   Pick a model (↑/↓ + Enter), or list available ones
  /model <name>            Switch the model for subsequent turns
  /help                    Print this help
  /quit                    Exit
`;

/** Parse `oh-my-agent-web ws [ ... ]` arguments. */
export function parseWsArgs(argv) {
	const opts = {
		url: null,
		host: process.env.CODEX_WS_HOST || DEFAULT_HOST,
		port: Number(process.env.CODEX_WS_PORT) || DEFAULT_PORT,
		hostExplicit: false,
		portExplicit: false,
		cwd: process.cwd(),
		thread: null,
		model: null,
		sandbox: null,
		approval: null,
		autoApprove: false,
		autoDecline: false,
		verbose: false,
		json: false,
		timeout: 1800,
		retry: 1,
		retryDelayMs: 1000,
		messages: [],
		help: false,
	};
	for (let i = 0; i < argv.length; i++) {
		const a = argv[i];
		const next = () => argv[++i];
		switch (a) {
			case "--url":
				opts.url = next();
				break;
			case "--host":
			case "--addr": {
				const v = String(next() ?? "").trim().replace(/^\[|\]$/g, "");
				const m = v.match(/^(\[?[^\]]+\]?):(\d+)$/);
				if (m) {
					opts.host = m[1].replace(/^\[|\]$/g, "");
					opts.port = Number(m[2]);
					opts.hostExplicit = true;
					opts.portExplicit = true;
				} else if (/^\d+$/.test(v)) {
					opts.port = Number(v);
					opts.portExplicit = true;
				} else {
					opts.host = v;
					opts.hostExplicit = true;
				}
				break;
			}
			case "-p":
			case "--port":
				opts.port = Number(next());
				opts.portExplicit = true;
				break;
			case "--cwd":
				opts.cwd = next();
				break;
			case "-t":
			case "--thread":
				opts.thread = next();
				break;
			case "--model":
				opts.model = next();
				break;
			case "--sandbox":
				opts.sandbox = next();
				break;
			case "--approval":
				opts.approval = next();
				break;
			case "--auto-approve":
			case "-y":
				opts.autoApprove = true;
				break;
			case "--decline":
				opts.autoDecline = true;
				break;
			case "--verbose":
			case "-v":
				opts.verbose = true;
				break;
			case "--json":
				opts.json = true;
				break;
			case "--timeout":
				opts.timeout = Number(next());
				break;
			case "--retry":
				opts.retry = Number(next());
				break;
			case "--no-retry":
				opts.retry = 0;
				break;
			case "--retry-delay":
				opts.retryDelayMs = Number(next());
				break;
			case "-h":
			case "--help":
				opts.help = true;
				break;
			default:
				opts.messages.push(a);
		}
	}
	return opts;
}

/** Normalise a raw address into a ws:// URL (accepts ws/wss/http/https/bare host:port). */
function normalizeWsUrl(raw) {
	if (/^wss?:\/\//i.test(raw)) return raw;
	if (/^https?:\/\//i.test(raw)) return raw.replace(/^http/i, "ws");
	return "ws://" + raw;
}

/** Combine --url / --host / --port / env into a single ws:// URL.
 *
 * Priority: --url > --host/--port > env (CODEX_WS_URL / CODEX_WS_HOST / CODEX_WS_PORT) > defaults.
 */
export function resolveWsUrl(o) {
	const flagUrl = String(o.url ?? "").trim().replace(/^["']|["']$/g, "");
	if (flagUrl) return normalizeWsUrl(flagUrl);

	// An explicit --host/--port (or --addr) must beat an env URL.
	const explicitHostPort = Boolean(o.hostExplicit || o.portExplicit);
	if (!explicitHostPort) {
		const envUrl = String(process.env.CODEX_WS_URL ?? "").trim().replace(/^["']|["']$/g, "");
		if (envUrl) return normalizeWsUrl(envUrl);
	}

	if (!Number.isInteger(o.port) || o.port < 1 || o.port > 65535) {
		throw new Error(`invalid port: ${o.port} (expected 1-65535)`);
	}
	const host = o.host.includes(":") && !o.host.startsWith("[") ? `[${o.host}]` : o.host;
	return `ws://${host}:${o.port}`;
}

class CodexClient {
	#listeners = new Map();

	constructor(url) {
		this.url = url;
		this.ws = null;
		this.nextId = 1;
		this.pending = new Map();
	}

	on(name, fn, { once = false } = {}) {
		const list = this.#listeners.get(name) ?? [];
		list.push({ fn, once });
		this.#listeners.set(name, list);
		return () => this.off(name, fn);
	}

	off(name, fn) {
		const list = this.#listeners.get(name) ?? [];
		this.#listeners.set(name, list.filter((l) => l.fn !== fn));
	}

	emit(name, detail) {
		for (const l of [...(this.#listeners.get(name) ?? [])]) {
			if (l.once) this.off(name, l.fn);
			try {
				l.fn({ detail });
			} catch (e) {
				log(`[listener error] ${e.stack}`);
			}
		}
	}

	connect() {
		return new Promise((resolve, reject) => {
			const ws = new WebSocket(this.url);
			this.ws = ws;
			ws.onopen = () => {
				log(`[connected] ${this.url}`);
				resolve();
			};
			ws.onerror = (e) => reject(new Error(`WebSocket connect failed: ${e.message ?? e.type}`));
			ws.onclose = (e) => {
				this.emit("closed", { code: e.code, reason: e.reason });
				for (const { reject: rj } of this.pending.values()) rj(new Error("connection closed"));
				this.pending.clear();
			};
			ws.onmessage = (e) => this.#onMessage(String(e.data));
		});
	}

	#onMessage(raw) {
		let msg;
		try {
			msg = JSON.parse(raw);
		} catch {
			return this.emit("raw", raw);
		}
		// 1) response to one of our requests
		if (msg.id !== undefined && msg.method === undefined) {
			const p = this.pending.get(msg.id);
			if (p) {
				this.pending.delete(msg.id);
				msg.error ? p.reject(new Error(JSON.stringify(msg.error))) : p.resolve(msg.result);
				return;
			}
		}
		// 2) server -> client request (needs a reply)
		if (msg.id !== undefined && msg.method) return this.emit("serverRequest", msg);
		// 3) notification
		this.emit("notification", msg);
	}

	send(msg) {
		this.ws.send(JSON.stringify(msg));
	}

	request(method, params) {
		const id = this.nextId++;
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve, reject });
			this.send({ method, id, params });
		});
	}

	respond(id, result) {
		this.send({ id, result });
	}

	close() {
		try {
			this.ws?.close();
		} catch {
			/* ignore */
		}
	}
}

const log = (...a) => process.stderr.write(a.join(" ") + "\n");

/** Run the ws client. Resolves when the session ends. */
export async function runWsClient(argv) {
	const opts = parseWsArgs(argv);

	if (opts.help) {
		process.stdout.write(HELP);
		return;
	}

	let url;
	try {
		url = resolveWsUrl(opts);
	} catch (e) {
		console.error(`[oh-my-agent-web ws] ${e.message}`);
		process.exitCode = 2;
		return;
	}

	const client = new CodexClient(url);

	/* -------- exit / Ctrl-C --------
	 * A turn lives on the app-server, not in this process: dropping the socket
	 * mid-turn would leave the agent generating (and billing) with nobody
	 * watching — and it stays that way, since nothing tells codex to stop. So
	 * every exit path funnels through `shutdown()`: interrupt the in-flight turn
	 * first, then close the socket. A second Ctrl-C stops waiting for the
	 * interrupt round-trip and exits immediately.
	 */
	let activeTurn = null; // { threadId, turnId } while a turn is in flight
	let socketClosed = false;
	let shuttingDown = false;
	let interrupts = 0;

	const waitForSocketClose = (timeoutMs = 500) =>
		new Promise((resolve) => {
			if (socketClosed) return resolve();
			const done = () => {
				clearTimeout(timer);
				resolve();
			};
			const timer = setTimeout(done, timeoutMs);
			client.on("closed", done, { once: true });
		});

	client.on("closed", (ev) => {
		socketClosed = true;
		if (shuttingDown) return;
		const { code, reason } = ev.detail ?? {};
		const detail = code ? ` (code=${code})` : "";
		log(`\x1b[31m[closed] connection closed${detail}${reason ? ` ${reason}` : ""}\x1b[0m`);
		void shutdown(1);
	});

	/** Interrupt whatever is running, close the socket, exit. Idempotent. */
	async function shutdown(code, reason) {
		if (shuttingDown) return;
		shuttingDown = true;
		if (reason) log(reason);
		const turn = activeTurn;
		if (turn?.turnId && !socketClosed) {
			try {
				await client.request("turn/interrupt", { threadId: turn.threadId, turnId: turn.turnId });
				log(`\x1b[2m[interrupt] turn ${turn.turnId} interrupted\x1b[0m`);
			} catch (e) {
				log(`\x1b[31m[interrupt] failed: ${e.message}\x1b[0m`);
			}
		}
		activeTurn = null;
		client.close();
		await waitForSocketClose();
		process.exit(code);
	}

	function handleInterrupt(signal) {
		interrupts += 1;
		if (interrupts > 1) {
			log(`\n\x1b[31m[${signal}] again — exiting now\x1b[0m`);
			client.close();
			process.exit(130);
		}
		void shutdown(130, `\n\x1b[2m[${signal}] interrupting current turn and closing…\x1b[0m`);
	}

	// readline 在 TTY 下会自己接管 Ctrl-C（raw mode 下不会产生进程级 SIGINT），
	// 所以进程级和 rl 级都要挂，靠 shuttingDown / interrupts 去重。
	process.on("SIGINT", () => handleInterrupt("SIGINT"));
	process.on("SIGTERM", () => handleInterrupt("SIGTERM"));
	try {
		await client.connect();
	} catch (e) {
		console.error(`[oh-my-agent-web ws] failed to connect ${url} — ${e.message}`);
		console.error("  make sure the app-server is running, e.g. `oh-my-agent-web` (default ws://127.0.0.1:25258)");
		process.exitCode = 1;
		return;
	}

	const init = await client.request("initialize", {
		clientInfo: { name: "oh-my-agent-web-ws", title: "Oh My Agent Web WS Client", version: "1.0.0" },
		capabilities: { experimentalApi: true, requestAttestation: false },
	});
	log(`[server] ${init.userAgent}  codexHome=${init.codexHome}`);

	const threadParams = {
		...(opts.model ? { model: opts.model } : {}),
		...(opts.cwd ? { cwd: opts.cwd } : {}),
		...(opts.approval ? { approvalPolicy: opts.approval } : {}),
		...(opts.sandbox ? { sandbox: opts.sandbox } : {}),
	};
	const threadResp = opts.thread
		? await client.request("thread/resume", { threadId: opts.thread, ...threadParams })
		: await client.request("thread/start", threadParams);

	const threadId = threadResp.thread.id;
	let currentModel = threadResp.model ?? opts.model ?? null;
	log(
		`[thread] ${threadId}  cwd=${threadResp.cwd}  sandbox=${JSON.stringify(threadResp.sandbox)}`,
	);
	log(`[model]  ${currentModel ?? "(server default)"}  \x1b[2m(/model to list or switch)\x1b[0m`);

	/** Lazily fetch the server's model catalog (id / model / displayName / …). */
	let modelsCache = null;
	async function loadModels() {
		if (modelsCache) return modelsCache;
		try {
			const resp = await client.request("model/list", {});
			modelsCache = Array.isArray(resp?.data) ? resp.data : [];
		} catch {
			modelsCache = [];
		}
		return modelsCache;
	}

	/* -------- event rendering -------- */
	let inAgentMessage = false;
	let inReasoning = false;
	let pendingApproval = null;
	let rl = null;

	client.on("notification", (ev) => {
		const { method, params } = ev.detail;
		if (opts.json) return void process.stdout.write(JSON.stringify(ev.detail) + "\n");

		switch (method) {
			case "item/agentMessage/delta":
				if (!inAgentMessage) {
					process.stdout.write("\n");
					inAgentMessage = true;
				}
				process.stdout.write(params.delta);
				break;

			case "item/reasoning/summaryTextDelta":
			case "item/reasoning/textDelta":
				if (!opts.verbose) break;
				if (inAgentMessage) {
					process.stdout.write("\n");
					inAgentMessage = false;
				}
				if (!inReasoning) {
					process.stdout.write("\x1b[2m💭 ");
					inReasoning = true;
				}
				process.stdout.write(params.delta);
				break;

			case "item/started": {
				const it = params.item ?? {};
				if (inAgentMessage) {
					process.stdout.write("\n");
					inAgentMessage = false;
				}
				if (inReasoning) {
					process.stdout.write("\x1b[0m\n");
					inReasoning = false;
				}
				if (it.type === "commandExecution") log(`\x1b[36m▶ exec\x1b[0m ${it.command ?? ""}`);
				else if (it.type === "fileChange") log(`\x1b[33m✎ patch\x1b[0m ${(it.changes ?? []).length} file(s)`);
				else if (it.type === "mcpToolCall" || it.type === "dynamicToolCall") log(`\x1b[35m⚙ tool\x1b[0m ${it.tool ?? it.name ?? ""}`);
				break;
			}

			case "item/completed": {
				const it = params.item ?? {};
				if (inReasoning) {
					process.stdout.write("\x1b[0m");
					inReasoning = false;
				}
				if (it.type === "commandExecution") log(`\x1b[36m◀ exec done\x1b[0m exit=${it.exitCode ?? "?"}`);
				break;
			}

			case "turn/completed": {
				if (inAgentMessage) {
					process.stdout.write("\n");
					inAgentMessage = false;
				}
				if (inReasoning) {
					process.stdout.write("\x1b[0m\n");
					inReasoning = false;
				}
				const t = params.turn ?? {};
				const err = t.error ? ` error=${JSON.stringify(t.error)}` : "";
				log(`\x1b[2m── turn ${t.status ?? "done"}${err} ──\x1b[0m`);
				client.emit("turnDone", t);
				break;
			}

			case "error":
				log(`\x1b[31m[error] ${JSON.stringify(params)}\x1b[0m`);
				break;

			default:
				break;
		}
	});

	function decide(id, decision) {
		pendingApproval = null;
		client.respond(id, { decision });
		log(`  → ${decision}`);
	}

	client.on("serverRequest", async (ev) => {
		const { id, method, params } = ev.detail;
		if (opts.json) process.stdout.write(JSON.stringify(ev.detail) + "\n");

		if (opts.autoApprove) return decide(id, "acceptForSession");
		if (opts.autoDecline) return decide(id, "decline");

		if (method === "item/commandExecution/requestApproval") {
			log(`\x1b[33m⚠ approval needed:\x1b[0m ${params.command ?? ""} (cwd=${params.cwd ?? ""})${params.reason ? " reason: " + params.reason : ""}`);
		} else if (method === "item/fileChange/requestApproval") {
			log(`\x1b[33m⚠ file change approval\x1b[0m${params.reason ? " reason: " + params.reason : ""}`);
		} else {
			log(`\x1b[33m⚠ server request ${method}:\x1b[0m ${JSON.stringify(params).slice(0, 400)}`);
		}

		if (process.stdin.isTTY && rl) {
			pendingApproval = { id, method };
			rl.setPrompt("approve? [y=once / a=session / n=decline] > ");
			rl.prompt();
			return;
		}
		log("  non-interactive, declining by default (use --auto-approve / --decline)");
		decide(id, "decline");
	});

	/** Run one turn to completion and return its final state. */
	async function runTurn(text) {
		const done = new Promise((resolve) => client.on("turnDone", (ev) => resolve(ev.detail), { once: true }));
		const started = await client.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
			...(currentModel ? { model: currentModel } : {}),
		});
		activeTurn = { threadId, turnId: started?.turn?.id ?? null };
		const timer = setTimeout(() => {
			log(`\x1b[31m[timeout] turn did not finish within ${opts.timeout}s\x1b[0m`);
			client.emit("turnDone", { status: "timeout" });
		}, opts.timeout * 1000);
		const turn = await done;
		activeTurn = null;
		clearTimeout(timer);
		return turn;
	}

	/**
	 * A failed turn worth retrying. The upstream moderation layer sometimes flags
	 * a perfectly innocent prompt ("Invalid prompt … potentially violating our
	 * usage policy") and codex reports willRetry:false, so without this the turn is
	 * simply lost. Re-sending the same input almost always succeeds.
	 */
	function isRetryableTurn(turn) {
		if (!turn || turn.status !== "failed") return false;
		const msg = String(turn.error?.message ?? "");
		return /flagged as potentially violating|Invalid prompt/i.test(msg);
	}

	async function ask(text) {
		const maxRetries = Math.max(0, Math.floor(Number(opts.retry)) || 0);
		const baseDelay = Math.max(0, Number(opts.retryDelayMs) || 0);
		for (let attempt = 0; ; attempt++) {
			const turn = await runTurn(text);
			if (attempt >= maxRetries || !isRetryableTurn(turn)) return;
			const wait = baseDelay * (attempt + 1);
			log(
				`\x1b[33m[retry] retryable failure — retrying in ${wait}ms (attempt ${attempt + 2}/${maxRetries + 1})\x1b[0m`,
			);
			await new Promise((r) => setTimeout(r, wait));
		}
	}

	/** Arrow-key model chooser used by `/model`. Returns a chosen id, or null. */
	async function pickModel(models, activeId) {
		const rows = models.map((m) => {
			const id = m.id ?? m.model;
			const label = m.displayName && m.displayName !== id ? `  \x1b[2m${m.displayName}\x1b[0m` : "";
			return { id, text: `${id}${label}` };
		});
		if (!process.stdin.isTTY) {
			log("  available:");
			for (const r of rows) log(`    ${r.text}`);
			log("  pick one with `/model <name>`");
			return null;
		}
		let index = Math.max(0, rows.findIndex((r) => r.id === activeId));
		const total = rows.length;
		const draw = (initial) => {
			if (!initial) process.stderr.write(`\x1b[${total + 1}A`);
			for (let i = 0; i < total; i++) {
				const pointer = i === index ? "\x1b[36m›\x1b[0m" : " ";
				const star = rows[i].id === activeId ? " \x1b[32m*\x1b[0m" : "";
				process.stderr.write(`\x1b[2K${pointer} ${rows[i].text}${star}\n`);
			}
			process.stderr.write("\x1b[2K\x1b[2m  ↑/↓ move · Enter select · Esc cancel\x1b[0m\n");
		};
		log("[model] select a model:");
		draw(true);
		return await new Promise((resolve) => {
			const stdin = process.stdin;
			const wasRaw = Boolean(stdin.isRaw);
			rl?.pause();
			if (typeof stdin.setRawMode === "function") stdin.setRawMode(true);
			stdin.resume();
			const finish = (value) => {
				stdin.removeListener("data", onData);
				if (typeof stdin.setRawMode === "function") stdin.setRawMode(wasRaw);
				stdin.pause();
				rl?.resume();
				resolve(value);
			};
			const onData = (buf) => {
				const s = buf.toString("utf8");
				if (s === "\u0003") {
					finish(null);
					process.kill(process.pid, "SIGINT");
				} else if (s === "\u001b[A" || s === "k") {
					index = (index - 1 + total) % total;
					draw();
				} else if (s === "\u001b[B" || s === "j") {
					index = (index + 1) % total;
					draw();
				} else if (s === "\r" || s === "\n") {
					finish(rows[index].id);
				} else if (s === "\u001b" || s === "q") {
					finish(null);
				} else if (/^[1-9]$/.test(s)) {
					const n = Number(s) - 1;
					if (n < total) {
						index = n;
						draw();
					}
				}
			};
			stdin.on("data", onData);
		});
	}

	/** Interactive slash commands (/model, /help, /quit). */
	async function handleCommand(line) {
		const [cmd, ...rest] = line.slice(1).trim().split(/\s+/);
		switch (cmd) {
			case "help":
				process.stdout.write(HELP);
				return true;
			case "quit":
			case "exit":
				await shutdown(0);
				return true;
			case "model":
			case "models": {
				const models = await loadModels();
				if (!rest.length) {
					log(`[model] current: ${currentModel ?? "(server default)"}`);
					if (!models.length) {
						log("  (this server exposes no model list)");
						return true;
					}
					const picked = await pickModel(models, currentModel);
					if (picked && picked !== currentModel) {
						currentModel = picked;
						log(`[model] switched to ${currentModel} \x1b[2m(applies from the next turn)\x1b[0m`);
						updatePrompt();
					}
					return true;
				}
				const wanted = rest[0];
				const hit = models.find((m) => m.id === wanted || m.model === wanted || m.displayName === wanted);
				if (models.length && !hit) {
					log(`\x1b[31m[model] unknown model "${wanted}" — run /model to list\x1b[0m`);
					return true;
				}
				currentModel = hit ? (hit.id ?? hit.model) : wanted;
				log(`[model] switched to ${currentModel} \x1b[2m(applies from the next turn)\x1b[0m`);
				updatePrompt();
				return true;
			}
			default:
				log(`unknown command: /${cmd} — try /help`);
				return true;
		}
	}

	function updatePrompt() {
		if (rl && process.stdin.isTTY) rl.setPrompt(`\x1b[2m${currentModel ?? "model?"}\x1b[0m \x1b[36m›\x1b[0m `);
	}

	function setupRepl() {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
		rl.on("line", async (line) => {
			const text = line.trim();
			if (!text) {
				if (process.stdin.isTTY) rl.prompt();
				return;
			}
			if (text.startsWith("/")) {
				try {
					await handleCommand(text);
				} catch (e) {
					log(`\x1b[31m[error] ${e.message}\x1b[0m`);
				}
				if (process.stdin.isTTY) rl.prompt();
				return;
			}
			if (pendingApproval) {
				if (/^(y|yes)$/i.test(text)) decide(pendingApproval.id, "accept");
				else if (/^(a|all)$/i.test(text)) decide(pendingApproval.id, "acceptForSession");
				else decide(pendingApproval.id, "decline");
				updatePrompt();
				if (process.stdin.isTTY) rl.prompt();
				return;
			}
			rl.pause();
			try {
				await ask(text);
			} catch (e) {
				log(`\x1b[31m[error] ${e.message}\x1b[0m`);
			}
			rl.resume();
			if (process.stdin.isTTY) rl.prompt();
		});
		rl.on("SIGINT", () => handleInterrupt("SIGINT"));
		rl.on("close", () => {
			void shutdown(0);
		});
		if (process.stdin.isTTY) {
			updatePrompt();
			log("\ntype a message and press Enter (Ctrl-C: interrupt & close / Ctrl-D: exit). approvals: y=once / a=session / n=decline\n  /model to list or switch models · /help for all commands\n");
			rl.prompt();
		}
	}

	if (opts.messages.length) {
		for (const msg of opts.messages) {
			try {
				await ask(msg);
			} catch (e) {
				log(`\x1b[31m[error] ${e.message}\x1b[0m`);
			}
		}
		await shutdown(0);
		return;
	}
	if (process.stdin.isTTY) {
		setupRepl();
		return;
	}
	// piped stdin: the whole input is one message
	let buf = "";
	process.stdin.setEncoding("utf8");
	for await (const chunk of process.stdin) buf += chunk;
	const text = buf.trim();
	if (text) {
		try {
			await ask(text);
		} catch (e) {
			log(`\x1b[31m[error] ${e.message}\x1b[0m`);
		}
	}
	await shutdown(0);
}

// Allow running this file directly: `node bin/oh-my-agent-web-ws.mjs ...`
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
	runWsClient(process.argv.slice(2)).catch((err) => {
		console.error(`[oh-my-agent-web ws] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
