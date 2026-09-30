#!/usr/bin/env node
/**
 * oh-my-agent-web CLI — plain ESM (no build step).
 *
 * 加载已编译的 dist/server/index.js，解析参数 / 环境变量，启动服务并在需要时打开浏览器。
 * 使用 `--help` 查看全部参数。
 */
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { spawn } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = dirname(fileURLToPath(import.meta.url));
const SERVER_ENTRY = resolve(__dirname, "..", "dist", "server", "index.js");
/** Shared with `npm run stop` / `npm run restart`; it owns the "who owns this port" logic. */
const MANAGE_SCRIPT = resolve(__dirname, "..", "scripts", "manage-server.mjs");

const HELP = `oh-my-agent-web — browser UI for the Codex CLI app-server

Usage:
  oh-my-agent-web [options]
  oh-my-agent-web ws [options] ["message" ...]   Connect to the app-server over WebSocket
  oh-my-agent-web ps [--json]                    Show running processes and their ports
  oh-my-agent-web stop [--port <n>]              Stop the service listening on the UI port
  oh-my-agent-web restart [options]              Stop the service, then serve again

Commands:
  ws                  WebSocket client for the codex app-server (run 'oh-my-agent-web ws --help')
  ps                  Show running oh-my-agent-web / app-server processes and their ports
  stop                Gracefully stop the service on the UI port (OMAW_PORT, default 25257)
  restart             Stop, then start again in the foreground

Note: unknown subcommands are rejected — only [options] starts a server.

Options:
  --port <n>          Port for the web UI (env OMAW_PORT, default 25257)
  --host <h>          Host to bind (env OMAW_HOST, default 127.0.0.1)
  --cwd <path>        Working directory for codex (env OMAW_CWD, default cwd)
  --codex-port <n>    app-server port (env OMAW_CODEX_PORT, default 25258)
  --codex-bin <name>  codex executable (env OMAW_CODEX_BIN, default "codex")
  --no-browser        Do not open the browser (env OMAW_OPEN=0)
  --help, -h          Show this help
  --version, -v       Show version

Environment:
  OMAW_ALLOW_ORIGINS    Comma separated extra allowed WS origins
`;

/** 支持 `--flag value` 与 `--flag=value` 两种写法。 */
function parseArgs(argv) {
	const opts = { open: true, positionals: [] };
	const take = (i, inline) => {
		if (inline !== undefined) return { value: inline, next: i };
		const value = argv[i + 1];
		if (value === undefined || value.startsWith("--")) {
			throw new Error(`missing value for ${argv[i]}`);
		}
		return { value, next: i + 1 };
	};
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (!token.startsWith("-")) {
			// Not a flag and not a value of one (values are consumed below), so it is a
			// stray word. Collect it instead of ignoring it: silently ignoring a mistyped
			// subcommand used to mean `stop` *started* a server.
			opts.positionals.push(token);
			continue;
		}
		const eq = token.indexOf("=");
		const flag = eq === -1 ? token : token.slice(0, eq);
		const inline = eq === -1 ? undefined : token.slice(eq + 1);
		switch (flag) {
			case "--help":
			case "-h":
				opts.help = true;
				break;
			case "--version":
			case "-v":
				opts.version = true;
				break;
			case "--no-browser":
				opts.open = false;
				break;
			case "--port": {
				const r = take(i, inline);
				opts.port = r.value;
				i = r.next;
				break;
			}
			case "--host": {
				const r = take(i, inline);
				opts.host = r.value;
				i = r.next;
				break;
			}
			case "--cwd": {
				const r = take(i, inline);
				opts.cwd = r.value;
				i = r.next;
				break;
			}
			case "--codex-port": {
				const r = take(i, inline);
				opts.codexPort = r.value;
				i = r.next;
				break;
			}
			case "--codex-bin": {
				const r = take(i, inline);
				opts.codexBin = r.value;
				i = r.next;
				break;
			}
			default:
				throw new Error(`unknown option: ${flag}`);
		}
	}
	return opts;
}

function readVersion() {
	try {
		const pkgPath = resolve(__dirname, "..", "package.json");
		return JSON.parse(readFileSync(pkgPath, "utf8")).version ?? "0.0.0";
	} catch {
		return "0.0.0";
	}
}

/** Open a URL in the OS default browser; best-effort, failures swallowed. */
function openBrowser(url) {
	const platform = process.platform;
	const cmd = platform === "darwin" ? "open" : platform === "win32" ? "cmd" : "xdg-open";
	const args = platform === "win32" ? ["/c", "start", "", url] : [url];
	try {
		const child = spawn(cmd, args, { detached: true, stdio: "ignore" });
		child.on("error", (err) => {
			console.warn(`[browser] failed to open ${url}: ${err.message}`);
		});
		child.unref();
	} catch (err) {
		console.warn(`[browser] failed to open ${url}: ${err instanceof Error ? err.message : String(err)}`);
	}
}

function parsePort(value, fallback) {
	if (value === undefined || value === null || value === "") return fallback;
	const n = Number(value);
	if (!Number.isFinite(n) || n < 0 || n > 65535) throw new Error(`invalid port: ${value}`);
	return n;
}

/** Pull `--port <n>` / `--port=<n>` out of a subcommand's argv (used by stop/restart). */
function portFlag(argv) {
	for (let i = 0; i < argv.length; i += 1) {
		const token = argv[i];
		if (token === "--port" || token === "-p") return argv[i + 1];
		if (token.startsWith("--port=")) return token.slice("--port=".length);
	}
	return undefined;
}

/**
 * Run `scripts/manage-server.mjs <cmd>` in the foreground and resolve with its exit code.
 *
 * Delegating instead of reimplementing keeps one definition of “who owns this port”
 * (including the safety check that refuses to kill a foreign process).
 */
function runManageServer(cmd, argv = []) {
	const port = portFlag(argv);
	const env = port === undefined ? process.env : { ...process.env, OMAW_PORT: String(port) };
	return new Promise((resolvePromise) => {
		let child;
		try {
			child = spawn(process.execPath, [MANAGE_SCRIPT, cmd], { stdio: "inherit", env });
		} catch (err) {
			console.error(`✖ 无法启动 ${MANAGE_SCRIPT}: ${err instanceof Error ? err.message : String(err)}`);
			return resolvePromise(1);
		}
		child.on("error", (err) => {
			console.error(`✖ 无法启动 ${MANAGE_SCRIPT}: ${err.message}`);
			resolvePromise(1);
		});
		child.on("exit", (code) => resolvePromise(code ?? 0));
	});
}

async function main() {
	const argv = process.argv.slice(2);

	// Best-effort update notice (cached; skipped for help/version/json output).
	// Never let this delay or break normal operation.
	const skipUpdateCheck =
		argv.includes("--json") ||
		argv.includes("-h") ||
		argv.includes("--help") ||
		argv.includes("-v") ||
		argv.includes("--version");
	if (!skipUpdateCheck) {
		try {
			const { notifyUpdate } = await import("./update-check.mjs");
			await notifyUpdate(readVersion());
		} catch {
			/* ignore */
		}
	}

	// Subcommand: `oh-my-agent-web ws [...]` — WebSocket client for the app-server.
	if (argv[0] === "ws") {
		const { runWsClient } = await import("./oh-my-agent-web-ws.mjs");
		await runWsClient(argv.slice(1));
		return;
	}

	// Subcommand: `oh-my-agent-web ps [...]` (aliases: status, ports) — running processes/ports.
	if (argv[0] === "ps" || argv[0] === "status" || argv[0] === "ports") {
		const { runPs } = await import("./oh-my-agent-web-ps.mjs");
		await runPs(argv.slice(1));
		return;
	}

	// Subcommand: `oh-my-agent-web stop [--port <n>]` — stop the service on the UI port.
	if (argv[0] === "stop") {
		process.exitCode = await runManageServer("stop", argv.slice(1));
		return;
	}

	// Subcommand: `oh-my-agent-web restart [options]` — stop, then fall through and serve.
	if (argv[0] === "restart") {
		const code = await runManageServer("stop", argv.slice(1));
		if (code !== 0) {
			process.exitCode = code;
			return;
		}
		argv.shift();
	}

	const opts = parseArgs(argv);

	if (opts.help) {
		process.stdout.write(HELP);
		return;
	}
	if (opts.version) {
		process.stdout.write(`${readVersion()}\n`);
		return;
	}

	if (opts.positionals.length > 0) {
		console.error(
			`✖ 未知的命令或参数：${opts.positionals.join(" ")}\n` +
				"  子命令：ws / ps / stop / restart。查看全部选项：--help",
		);
		process.exit(1);
	}

	if (!existsSync(SERVER_ENTRY)) {
		console.error(
			`✖ 找不到编译产物：${SERVER_ENTRY}\n  请先运行 npm run build（或 npm run build:server）再启动。`,
		);
		process.exit(1);
	}

	const port = parsePort(opts.port ?? process.env.OMAW_PORT, 25257);
	const host = opts.host ?? process.env.OMAW_HOST ?? "127.0.0.1";
	const cwd = opts.cwd ? resolve(opts.cwd) : process.env.OMAW_CWD ? resolve(process.env.OMAW_CWD) : process.cwd();
	const codexPort = parsePort(opts.codexPort ?? process.env.OMAW_CODEX_PORT, 25258);
	const codexBin = opts.codexBin ?? process.env.OMAW_CODEX_BIN ?? "codex";

	// 用户显式给的 --cwd 往往还不存在；create 出来而不是让 codex 子进程
	// 以一个看不懂的 `spawn codex ENOENT` 失败。
	try {
		mkdirSync(cwd, { recursive: true });
	} catch (err) {
		console.error(`无法创建 cwd ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	// 同步进 env，dist 内的 startServer 也会读取（参数优先）。
	process.env.OMAW_PORT = String(port);
	process.env.OMAW_HOST = host;
	process.env.OMAW_CWD = cwd;
	process.env.OMAW_CODEX_PORT = String(codexPort);
	process.env.OMAW_CODEX_BIN = codexBin;

	const { startServer } = await import(SERVER_ENTRY);
	const handle = await startServer({ port, host, cwd, codexPort, codexBin });

	const displayUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${handle.port}`;
	console.log("");
	console.log("  ┌──────────────────────────────────────────────────┐");
	console.log("  │  oh-my-agent-web" + " ".repeat(36) + "│");
	console.log("  └──────────────────────────────────────────────────┘");
	console.log(`  ➜  Web UI:  ${displayUrl}`);
	console.log(`  ➜  Codex:   ${handle.supervisor.url}  (${handle.supervisor.isExternal() ? "external" : "managed"})`);
	console.log(`  ➜  cwd:     ${handle.cwd}`);
	console.log("");

	const noBrowser = !opts.open || process.env.OMAW_OPEN === "0" || !process.stdout.isTTY;
	if (!noBrowser) openBrowser(displayUrl);
	else if (!process.env.OMAW_OPEN && !process.stdout.isTTY) console.log("  (非交互终端，跳过自动打开浏览器；--no-browser 可显式关闭)");

	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\n[oh-my-agent-web] received ${signal}, shutting down…`);
		try {
			await handle.close();
		} finally {
			process.exit(0);
		}
	};
	process.on("SIGINT", () => void shutdown("SIGINT"));
	process.on("SIGTERM", () => void shutdown("SIGTERM"));
}

main().catch((err) => {
	console.error(`[oh-my-agent-web] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
