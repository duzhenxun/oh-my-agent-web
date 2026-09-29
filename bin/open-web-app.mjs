#!/usr/bin/env node
/**
 * open-web-app CLI — plain ESM (no build step).
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

const HELP = `open-web-app — browser UI for the Codex CLI app-server

Usage:
  open-web-app [options]
  open-web-app ws [options] ["message" ...]   Connect to the app-server over WebSocket
  open-web-app ps [--json]                    Show running processes and their ports

Commands:
  ws                  WebSocket client for the codex app-server (run 'open-web-app ws --help')
  ps                  Show running open-web-app / app-server processes and their ports

Options:
  --port <n>          Port for the web UI (env OWA_PORT, default 25257)
  --host <h>          Host to bind (env OWA_HOST, default 127.0.0.1)
  --cwd <path>        Working directory for codex (env OWA_CWD, default cwd)
  --codex-port <n>    app-server port (env OWA_CODEX_PORT, default 25258)
  --codex-bin <name>  codex executable (env OWA_CODEX_BIN, default "codex")
  --no-browser        Do not open the browser (env OWA_OPEN=0)
  --help, -h          Show this help
  --version, -v       Show version

Environment:
  OWA_ALLOW_ORIGINS    Comma separated extra allowed WS origins
`;

/** 支持 `--flag value` 与 `--flag=value` 两种写法。 */
function parseArgs(argv) {
	const opts = { open: true };
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
		if (!token.startsWith("-")) continue;
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

	// Subcommand: `open-web-app ws [...]` — WebSocket client for the app-server.
	if (argv[0] === "ws") {
		const { runWsClient } = await import("./open-web-app-ws.mjs");
		await runWsClient(argv.slice(1));
		return;
	}

	// Subcommand: `open-web-app ps [...]` (aliases: status, ports) — running processes/ports.
	if (argv[0] === "ps" || argv[0] === "status" || argv[0] === "ports") {
		const { runPs } = await import("./open-web-app-ps.mjs");
		await runPs(argv.slice(1));
		return;
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

	if (!existsSync(SERVER_ENTRY)) {
		console.error(
			`✖ 找不到编译产物：${SERVER_ENTRY}\n  请先运行 npm run build（或 npm run build:server）再启动。`,
		);
		process.exit(1);
	}

	const port = parsePort(opts.port ?? process.env.OWA_PORT, 25257);
	const host = opts.host ?? process.env.OWA_HOST ?? "127.0.0.1";
	const cwd = opts.cwd ? resolve(opts.cwd) : process.env.OWA_CWD ? resolve(process.env.OWA_CWD) : process.cwd();
	const codexPort = parsePort(opts.codexPort ?? process.env.OWA_CODEX_PORT, 25258);
	const codexBin = opts.codexBin ?? process.env.OWA_CODEX_BIN ?? "codex";

	// 用户显式给的 --cwd 往往还不存在；create 出来而不是让 codex 子进程
	// 以一个看不懂的 `spawn codex ENOENT` 失败。
	try {
		mkdirSync(cwd, { recursive: true });
	} catch (err) {
		console.error(`无法创建 cwd ${cwd}: ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	}

	// 同步进 env，dist 内的 startServer 也会读取（参数优先）。
	process.env.OWA_PORT = String(port);
	process.env.OWA_HOST = host;
	process.env.OWA_CWD = cwd;
	process.env.OWA_CODEX_PORT = String(codexPort);
	process.env.OWA_CODEX_BIN = codexBin;

	const { startServer } = await import(SERVER_ENTRY);
	const handle = await startServer({ port, host, cwd, codexPort, codexBin });

	const displayUrl = `http://${host === "0.0.0.0" || host === "::" ? "127.0.0.1" : host}:${handle.port}`;
	console.log("");
	console.log("  ┌──────────────────────────────────────────────────┐");
	console.log("  │  open-web-app" + " ".repeat(36) + "│");
	console.log("  └──────────────────────────────────────────────────┘");
	console.log(`  ➜  Web UI:  ${displayUrl}`);
	console.log(`  ➜  Codex:   ${handle.supervisor.url}  (${handle.supervisor.isExternal() ? "external" : "managed"})`);
	console.log(`  ➜  cwd:     ${handle.cwd}`);
	console.log("");

	const noBrowser = !opts.open || process.env.OWA_OPEN === "0" || !process.stdout.isTTY;
	if (!noBrowser) openBrowser(displayUrl);
	else if (!process.env.OWA_OPEN && !process.stdout.isTTY) console.log("  (非交互终端，跳过自动打开浏览器；--no-browser 可显式关闭)");

	let shuttingDown = false;
	const shutdown = async (signal) => {
		if (shuttingDown) return;
		shuttingDown = true;
		console.log(`\n[open-web-app] received ${signal}, shutting down…`);
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
	console.error(`[open-web-app] ${err instanceof Error ? err.message : String(err)}`);
	process.exit(1);
});
