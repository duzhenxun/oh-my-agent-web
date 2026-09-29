#!/usr/bin/env node
/**
 * open-web-app ws — 连接 codex app-server WebSocket 的命令行客户端。
 *
 * 参考 /Users/dds/data/ai/work/codex-ws-client.mjs，整理为 open-web-app 的子命令：
 *   open-web-app ws                          # 交互模式（Ctrl-D 退出）
 *   open-web-app ws "帮我看看这个目录"        # 单次提问后退出
 *   echo "写个 hello world" | open-web-app ws # 从管道读
 *   open-web-app ws --port 25259             # 指定端口
 *   open-web-app ws --url ws://host:port     # 指定完整地址
 *
 * 仅用 Node 内置能力（WebSocket 需要 Node >= 22），无额外依赖。
 */
import readline from "node:readline";
import { pathToFileURL } from "node:url";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 25258;

const HELP = `open-web-app ws — connect to the codex app-server over WebSocket

Usage:
  open-web-app ws [options] ["message" ...]

Connection:
  --url <ws://host:port>   Full address (also accepts bare host:port). Default ws://${DEFAULT_HOST}:${DEFAULT_PORT}
  --addr <host:port>       Address + port (same as --host + --port)
  --host <host>            Host, default ${DEFAULT_HOST}
  -p, --port <n>           Port, default ${DEFAULT_PORT}
  Env: CODEX_WS_URL / CODEX_WS_HOST / CODEX_WS_PORT

Session:
  --cwd <dir>              Working directory (default: current dir)
  -t, --thread <id>        Resume an existing thread
  --model <name>           Model id
  --sandbox <mode>         read-only | workspace-write | danger-full-access
  --approval <mode>        untrusted | on-request | on-failure | never
  -y, --auto-approve       Auto-accept approvals (acceptForSession)
  --decline                Auto-decline approvals
  -v, --verbose            Print reasoning deltas
  --json                   Print raw event JSON only
  --timeout <sec>          Max wait for a turn, default 1800
  -h, --help               Show this help
`;

/** Parse `open-web-app ws [ ... ]` arguments. */
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
		console.error(`[open-web-app ws] ${e.message}`);
		process.exitCode = 2;
		return;
	}

	const client = new CodexClient(url);
	try {
		await client.connect();
	} catch (e) {
		console.error(`[open-web-app ws] failed to connect ${url} — ${e.message}`);
		console.error("  make sure the app-server is running, e.g. `open-web-app` (default ws://127.0.0.1:25258)");
		process.exitCode = 1;
		return;
	}

	const init = await client.request("initialize", {
		clientInfo: { name: "open-web-app-ws", title: "Open Web App WS Client", version: "1.0.0" },
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
	log(
		`[thread] ${threadId}  model=${threadResp.model}  cwd=${threadResp.cwd}  sandbox=${JSON.stringify(threadResp.sandbox)}`,
	);

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

	async function ask(text) {
		const done = new Promise((resolve) => client.on("turnDone", resolve, { once: true }));
		await client.request("turn/start", {
			threadId,
			input: [{ type: "text", text, text_elements: [] }],
		});
		const timer = setTimeout(() => {
			log(`\x1b[31m[timeout] turn did not finish within ${opts.timeout}s\x1b[0m`);
			client.emit("turnDone", { status: "timeout" });
		}, opts.timeout * 1000);
		await done;
		clearTimeout(timer);
	}

	function setupRepl() {
		rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: process.stdin.isTTY });
		rl.on("line", async (line) => {
			const text = line.trim();
			if (!text) {
				if (process.stdin.isTTY) rl.prompt();
				return;
			}
			if (pendingApproval) {
				if (/^(y|yes)$/i.test(text)) decide(pendingApproval.id, "accept");
				else if (/^(a|all)$/i.test(text)) decide(pendingApproval.id, "acceptForSession");
				else decide(pendingApproval.id, "decline");
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
		rl.on("close", () => {
			client.close();
			process.exit(0);
		});
		if (process.stdin.isTTY) {
			log("\ntype a message and press Enter (Ctrl-D to exit). approvals: y=once / a=session / n=decline\n");
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
		client.close();
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
	client.close();
}

// Allow running this file directly: `node bin/open-web-app-ws.mjs ...`
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
	runWsClient(process.argv.slice(2)).catch((err) => {
		console.error(`[open-web-app ws] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
