#!/usr/bin/env node
/**
 * oh-my-agent-web ps — 列出正在运行的 oh-my-agent-web / codex app-server 进程及其监听端口。
 *
 *   oh-my-agent-web ps             # 表格
 *   oh-my-agent-web ps --json      # 机器可读
 *
 * 仅用 Node 内置能力（必要时调用 lsof / ps），无第三方依赖。
 */
import { execFileSync } from "node:child_process";

const DEFAULT_UI_PORT = 25257;
const DEFAULT_CODEX_PORT = 25258;

const HELP = `oh-my-agent-web ps — show running oh-my-agent-web / app-server processes and their ports

Usage:
  oh-my-agent-web ps [--json] [--help]

Options:
  --json      Print machine-readable JSON
  -h, --help  Show this help
`;

function sh(cmd, args) {
	try {
		return execFileSync(cmd, args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
	} catch {
		return "";
	}
}

/** All processes as { pid, ppid, command }. */
function listProcesses() {
	const out = sh("ps", ["-eo", "pid=,ppid=,command="]);
	const rows = [];
	for (const line of out.split("\n")) {
		const m = line.match(/^\s*(\d+)\s+(\d+)\s+(.*)$/);
		if (!m) continue;
		rows.push({ pid: Number(m[1]), ppid: Number(m[2]), command: m[3].trim() });
	}
	return rows;
}

/**
 * The CLI answers to a long name and a short alias, and which one shows up in
 * `ps` depends on how it was invoked: the npm bin symlink puts the alias in the
 * process command line (`.../bin/omaw`), while a direct `node bin/…mjs` puts the
 * file name there instead. Both must classify the same, or `omaw ps` would fail
 * to see its own server and mislabel its managed app-server as "external".
 */
const CLI_NAMES = ["oh-my-agent-web", "omaw"];
const CLI = CLI_NAMES.map((n) => n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

/** Classify a command line: "oh-my-agent-web" | "app-server" | "ws-client" | null. */
function classify(command) {
	// skip our own `... ps` invocation lines
	if (new RegExp(`\\b(?:${CLI})(?:\\.mjs)?\\s+(?:ps|status|ports)\\b`).test(command)) return null;
	// the ws client is a short-lived client, not a server
	if (new RegExp(`\\b(?:${CLI})(?:\\.mjs)?\\s+ws\\b`).test(command)) return "ws-client";
	if (new RegExp(`\\b(?:${CLI})(?:\\.mjs)?\\b`).test(command)) return "oh-my-agent-web";
	if (/\bapp-server\b/.test(command) && /\bcodex\b/.test(command)) return "app-server";
	return null;
}

/** TCP ports this pid is LISTENing on (via lsof), best-effort. */
function listenPorts(pid) {
	const out = sh("lsof", ["-nP", "-a", "-p", String(pid), "-iTCP", "-sTCP:LISTEN"]);
	const ports = new Set();
	for (const line of out.split("\n").slice(1)) {
		const m = line.match(/:(\d+)\s+\(LISTEN\)/);
		if (m) ports.add(Number(m[1]));
	}
	return ports;
}

/** Ports guessed from the command line (fallback when lsof is unavailable).
 * Only app-servers declare a listen port; the ws client's `--port` is a remote
 * target, so it must NOT be reported as a local listening port. */
function portsFromCmd(command, kind) {
	const ports = new Set();
	if (kind !== "app-server") return ports;
	const listen = command.match(/--listen[= ]+ws:\/\/[^:\s]+:(\d+)/);
	if (listen) ports.add(Number(listen[1]));
	return ports;
}

function pidsListeningOn(port) {
	const out = sh("lsof", ["-nP", `-iTCP:${port}`, "-sTCP:LISTEN", "-t"]);
	return [...new Set(out.split(/\s+/).filter(Boolean).map(Number))];
}

function truncate(s, n) {
	return s.length > n ? s.slice(0, n - 1) + "…" : s;
}

export function collect() {
	const self = process.pid;
	const all = listProcesses();
	const ppidOf = new Map(all.map((p) => [p.pid, p.ppid]));
	const matched = [];
	for (const p of all) {
		if (p.pid === self) continue;
		const kind = classify(p.command);
		if (kind) matched.push({ ...p, kind });
	}
	const codexWebPids = new Set(matched.filter((p) => p.kind === "oh-my-agent-web").map((p) => p.pid));
	// Walk up the ancestor chain (the app-server re-execs, so the listener's
	// parent is the shim, not oh-my-agent-web directly).
	const isManaged = (pid) => {
		let cur = pid;
		for (let hops = 0; hops < 12; hops += 1) {
			const parent = ppidOf.get(cur);
			if (parent === undefined || parent <= 1) return false;
			if (codexWebPids.has(parent)) return true;
			cur = parent;
		}
		return false;
	};

	const procs = matched.map((p) => {
		const ports = listenPorts(p.pid);
		for (const extra of portsFromCmd(p.command, p.kind)) ports.add(extra);
		const scope = p.kind === "app-server" ? (isManaged(p.pid) ? "managed" : "external") : "";
		return {
			kind: p.kind,
			pid: p.pid,
			ppid: p.ppid,
			scope,
			ports: [...ports].sort((a, b) => a - b),
			command: p.command,
		};
	});
	procs.sort((a, b) => (a.kind === b.kind ? a.pid - b.pid : a.kind.localeCompare(b.kind)));

	const uiPort = Number(process.env.OMAW_PORT) || DEFAULT_UI_PORT;
	const codexPort = Number(process.env.OMAW_CODEX_PORT) || DEFAULT_CODEX_PORT;
	const portOwners = {};
	for (const port of new Set([uiPort, codexPort])) {
		portOwners[port] = pidsListeningOn(port);
	}

	return { processes: procs, uiPort, codexPort, portOwners };
}

function render(data) {
	const { processes, uiPort, codexPort, portOwners } = data;
	if (processes.length === 0) {
		console.log("no oh-my-agent-web / app-server process found.");
	} else {
		const rows = [
			["TYPE", "PID", "PPID", "SCOPE", "PORTS", "COMMAND"],
			...processes.map((p) => [
				p.kind,
				String(p.pid),
				String(p.ppid),
				p.scope || "-",
				p.ports.length ? p.ports.join(",") : "-",
				truncate(p.command, 60),
			]),
		];
		const widths = rows[0].map((_, i) => Math.max(...rows.map((r) => r[i].length)));
		for (const r of rows) {
			console.log(r.map((c, i) => c.padEnd(widths[i])).join("  ").trimEnd());
		}
	}

	console.log("");
	console.log(`ports: ui=${uiPort}${process.env.OMAW_PORT ? " (OMAW_PORT)" : ""}  app-server=${codexPort}${process.env.OMAW_CODEX_PORT ? " (OMAW_CODEX_PORT)" : ""}`);
	for (const [port, pids] of Object.entries(portOwners)) {
		const who = pids.length ? pids.join(",") : "—";
		console.log(`  ${String(port).padEnd(6)} listening: ${pids.length ? "yes" : "no "}  pid: ${who}`);
	}
	if (processes.some((p) => p.kind === "app-server")) {
		const ws =
			processes.find((p) => p.kind === "app-server" && p.scope === "managed" && p.ports.length) ??
			processes.find((p) => p.kind === "app-server" && p.ports.length);
		if (ws) console.log(`\ntip: oh-my-agent-web ws --port ${ws.ports[0]}`);
	}
}

export async function runPs(argv) {
	if (argv.includes("-h") || argv.includes("--help")) {
		process.stdout.write(HELP);
		return;
	}
	const data = collect();
	if (argv.includes("--json")) {
		process.stdout.write(JSON.stringify(data, null, 2) + "\n");
		return;
	}
	render(data);
}

// Allow running this file directly: `node bin/oh-my-agent-web-ps.mjs`
import { pathToFileURL } from "node:url";
const invoked = process.argv[1] ? pathToFileURL(process.argv[1]).href : "";
if (invoked === import.meta.url) {
	runPs(process.argv.slice(2)).catch((err) => {
		console.error(`[oh-my-agent-web ps] ${err instanceof Error ? err.message : String(err)}`);
		process.exit(1);
	});
}
