/**
 * CodexSupervisor — manages the `codex app-server` child process.
 *
 * 职责：
 *  - 启动时优先探测端口上是否已有健康的 app-server；有则复用（external attach），
 *    绝不重复 spawn（用户自己起的 / 上一次遗留的 daemon 都能被复用）。
 *  - 否则 spawn `codex app-server --listen ws://127.0.0.1:<port>`。
 *  - readiness：同时看 stdout 里的 `listening on:` 与轮询 `/readyz`（措辞可能变）。
 *  - stdout/stderr 进环形缓冲（最近 500 行），供 `omaw/codex/log` 读取。
 *  - 意外退出时指数退避重启（上限 10s），并累加 restarts。主动 stop 不重启。
 *  - 只 kill 我们自己 spawn 的子进程。
 *
 * 状态里 `pid === null && phase === "ready"` 表示复用了外部已有的 app-server。
 */
import { execFileSync, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { EventEmitter } from "node:events";
import { existsSync, readdirSync, statSync } from "node:fs";
import { get as httpGet } from "node:http";
import { delimiter, isAbsolute, join } from "node:path";
import { homedir } from "node:os";

import type { CodexStatus } from "../shared/protocol.js";

const LOG_CAP = 500;
const READY_TIMEOUT_MS = 20_000;
const PROBE_TIMEOUT_MS = 1_000;
const PROBE_INTERVAL_MS = 250;
const RESTART_BASE_MS = 500;
const RESTART_MAX_MS = 10_000;
const STOP_GRACE_MS = 5_000;

export interface SupervisorOptions {
	/** 固定 127.0.0.1 上的端口（OMAW_CODEX_PORT，默认 25258）。 */
	port: number;
	/** 可执行文件名/路径（OMAW_CODEX_BIN，默认 `codex`）。 */
	bin: string;
	/** 子进程工作目录（一般等于服务端 cwd）。 */
	cwd: string;
	/** Optional local Responses API proxy used to capture request/response logs. */
	codexBaseUrl?: string;
	env?: NodeJS.ProcessEnv;
}

type StatusListener = (status: CodexStatus) => void;
type LogListener = (line: string) => void;

function probeReadyz(port: number, timeoutMs = PROBE_TIMEOUT_MS): Promise<boolean> {
	return new Promise((resolve) => {
		let settled = false;
		const done = (ok: boolean): void => {
			if (settled) return;
			settled = true;
			resolve(ok);
		};
		const req = httpGet({ host: "127.0.0.1", port, path: "/readyz", timeout: timeoutMs }, (res) => {
			res.resume();
			done(res.statusCode === 200);
		});
		req.on("timeout", () => {
			req.destroy();
			done(false);
		});
		req.on("error", () => done(false));
	});
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

function isDir(p: string): boolean {
	try {
		return statSync(p).isDirectory();
	} catch {
		return false;
	}
}

/**
 * 解析 codex 可执行文件。
 *
 * 为什么要这么麻烦：spawn 一个 PATH 里找不到的命令只会抛一个没有任何上下文的
 * `spawn codex ENOENT` —— 从 launchd / 桌面图标启动时 PATH 往往是极简的，
 * 用户会看到“找不到 codex”却不知道原因。所以显式地：
 *  1. 先尊重 `OMAW_CODEX_BIN`（含 `/` 就直接用）；
 *  2. 再 `which`；
 *  3. 最后扫常见安装位置（nvm / homebrew / local / bun / volta）。
 * 全部失败时回退到原名，让 spawn 自己报错，但日志里已给出可诊断信息。
 */
function resolveBin(bin: string): { bin: string; note: string | null } {
	if (isAbsolute(bin) || bin.includes("/")) return { bin, note: null };

	const which = (): string | null => {
		try {
			const out = execFileSync(process.platform === "win32" ? "where" : "which", [bin], {
				encoding: "utf8",
				stdio: ["ignore", "pipe", "ignore"],
			});
			const first = out.split(/\r?\n/).find((line) => line.trim());
			return first ? first.trim() : null;
		} catch {
			return null;
		}
	};

	const found = which();
	if (found) return { bin: found, note: null };

	const home = homedir();
	const candidates: string[] = [
		join(home, ".local", "bin", bin),
		"/opt/homebrew/bin/" + bin,
		"/usr/local/bin/" + bin,
		join(home, ".bun", "bin", bin),
		join(home, ".volta", "bin", bin),
	];
	try {
		const nvmDir = join(home, ".nvm", "versions", "node");
		for (const version of readdirSync(nvmDir) as string[]) {
			candidates.push(join(nvmDir, version, "bin", bin));
		}
	} catch {
		/* no nvm — fine */
	}

	for (const candidate of candidates) {
		if (existsSync(candidate)) {
			return { bin: candidate, note: `PATH 中未找到 \`${bin}\`，改用 ${candidate}` };
		}
	}

	return {
		bin,
		note: `PATH 中未找到 \`${bin}\`（PATH=${(process.env.PATH ?? "").split(delimiter).join(":")}）；可用 OMAW_CODEX_BIN 指定绝对路径`,
	};
}

export class CodexSupervisor extends EventEmitter {
	readonly url: string;
	readonly port: number;

	private readonly opts: SupervisorOptions;
	private child: ChildProcessWithoutNullStreams | null = null;
	/** true 表示 child 是本进程 spawn 的（只有此时才允许 kill）。 */
	private managed = false;
	private stopping = false;
	private restartTimer: NodeJS.Timeout | null = null;
	private readyDone = false;
	private stdoutSawListening = false;
	private restarts = 0;
	private logs: string[] = [];
	private _status: CodexStatus;

	constructor(opts: SupervisorOptions) {
		super();
		this.opts = opts;
		this.port = opts.port;
		this.url = `ws://127.0.0.1:${opts.port}`;
		this._status = {
			phase: "starting",
			url: this.url,
			pid: null,
			connected: false,
			error: null,
			since: null,
			restarts: 0,
		};
	}

	status(): CodexStatus {
		return { ...this._status };
	}

	/** pid 为空但 ready —— 说明复用了外部进程，我们不拥有它。 */
	isExternal(): boolean {
		return this.managed === false && this._status.phase === "ready" && this.child === null;
	}

	onStatus(cb: StatusListener): () => void {
		this.on("status", cb);
		return () => this.off("status", cb);
	}

	onLog(cb: LogListener): () => void {
		this.on("log", cb);
		return () => this.off("log", cb);
	}

	logLines(): string[] {
		return [...this.logs];
	}

	private setStatus(patch: Partial<CodexStatus>): void {
		this._status = { ...this._status, ...patch, restarts: this.restarts };
		this.emit("status", this.status());
	}

	private log(line: string): void {
		for (const raw of line.split(/\r?\n/)) {
			const entry = raw.trimEnd();
			if (!entry) continue;
			this.logs.push(entry);
			if (this.logs.length > LOG_CAP) this.logs.splice(0, this.logs.length - LOG_CAP);
			this.emit("log", entry);
		}
	}

	/** 启动或复用 app-server。重复调用是幂等的。 */
	async start(): Promise<void> {
		if (this.stopping) return;
		if (this.child) return;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		// 先复用：端口已有健康的 app-server 就不 spawn（用户自己起的 / 遗留 daemon）。
		if (await probeReadyz(this.port)) {
			this.managed = false;
			this.log(`检测到已有健康的 app-server，复用外部进程 (external): ${this.url}`);
			this.setStatus({ phase: "ready", pid: null, error: null, since: Date.now() });
			return;
		}
		this.spawnChild();
	}

	private spawnChild(): void {
		if (this.stopping || this.child) return;
		this.readyDone = false;
		this.stdoutSawListening = false;
		this.setStatus({ phase: "starting", pid: null, error: null, connected: false });

		const args = ["app-server", "--listen", this.url];
		if (this.opts.codexBaseUrl) {
			// Keep the override process-local: the user's ~/.codex/config.toml is
			// never modified. JSON quoting makes the URL a valid TOML string.
			args.push("-c", `chatgpt_base_url=${JSON.stringify(this.opts.codexBaseUrl)}`);
			// Some installations use a custom Responses provider (the request
			// inspector reference project uses `model_provider = "capture"`).
			// Override that provider too, otherwise its configured :8898 endpoint
			// bypasses this inspector and the session drawer stays empty.
			args.push("-c", `model_providers.capture.base_url=${JSON.stringify(this.opts.codexBaseUrl)}`);
		}

		// cwd 不存在时 Node 的 spawn 会抛一个误导性的 `spawn <bin> ENOENT`，
		// 看起来像“找不到可执行文件”。这里显式校验并回退，日志说明原因。
		let cwd = this.opts.cwd;
		if (!isDir(cwd)) {
			this.log(`⚠ 工作目录不存在: ${cwd}，改用 ${process.cwd()}`);
			cwd = process.cwd();
		}

		this.log(`$ ${this.opts.bin} ${args.join(" ")} (cwd=${cwd})`);

		const resolved = resolveBin(this.opts.bin);
		if (resolved.note) this.log(`⚠ ${resolved.note}`);

		let child: ChildProcessWithoutNullStreams;
		try {
			child = spawn(resolved.bin, args, {
				cwd,
				env: this.opts.env ?? process.env,
				stdio: "pipe",
				// Own process group: `codex app-server` re-execs, so we must be able to
				// signal the whole tree (see `signalGroup`).
				detached: true,
			});
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			this.log(`spawn 失败: ${message}`);
			this.setStatus({ phase: "error", error: message });
			this.scheduleRestart();
			return;
		}

		this.child = child;
		this.managed = true;
		this.setStatus({ pid: child.pid ?? null });

		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => this.onOutput(chunk));
		child.stderr.on("data", (chunk: string) => this.onOutput(chunk));

		child.on("error", (err) => {
			this.log(`子进程错误: ${err.message}`);
			this.setStatus({ error: err.message });
			// spawn 本身失败（ENOENT / EACCES）时不会有 exit 事件，必须在这里兜底重启；
			// 运行中管道的偶发错误则保留 child 引用，交给 exit 处理。
			if (child.pid === undefined) {
				this.child = null;
				this.managed = false;
				this.scheduleRestart();
			}
		});

		child.on("exit", (code, signal) => {
			const detail = signal ? `signal=${signal}` : `code=${code}`;
			this.log(`app-server 退出 (${detail})`);
			// Reap any re-exec'd grandchild in our group. Without this an orphan keeps
			// the port and later starts would attach to it instead of spawning fresh.
			if (this.managed) this.signalGroup("SIGKILL");
			this.child = null;
			this.managed = false;
			if (this.stopping) {
				this.setStatus({ phase: "stopped", pid: null, connected: false });
				return;
			}
			this.setStatus({
				phase: "error",
				pid: null,
				connected: false,
				error: `app-server exited (${detail})`,
			});
			this.scheduleRestart();
		});

		void this.waitForReady(child);
	}

	/** stdout 既用于日志，也可能直接告诉我们已经 listening。 */
	private onOutput(chunk: string): void {
		for (const line of chunk.split(/\r?\n/)) {
			if (line.includes("listening on:")) this.stdoutSawListening = true;
		}
		this.log(chunk);
	}

	/**
	 * Poll `/readyz` 直到 200；stdout 已报 listening 时即使 readyz 一直失败，
	 * 也会在超时后进入 ready（不同版本 app-server 探测路径可能不同）。
	 */
	private async waitForReady(child: ChildProcessWithoutNullStreams): Promise<void> {
		const deadline = Date.now() + READY_TIMEOUT_MS;
		while (!this.stopping && this.child === child && !this.readyDone) {
			if (await probeReadyz(this.port)) {
				if (this.child !== child || this.stopping) return;
				this.readyDone = true;
				this.log(`app-server ready: ${this.url}`);
				this.setStatus({ phase: "ready", error: null, since: Date.now() });
				return;
			}
			if (this.stdoutSawListening && Date.now() > deadline) {
				if (this.child !== child || this.stopping) return;
				this.readyDone = true;
				this.log(`app-server stdout 报告 listening，但 /readyz 未响应；按 ready 处理`);
				this.setStatus({ phase: "ready", error: null, since: Date.now() });
				return;
			}
			if (Date.now() > deadline) {
				if (this.child !== child || this.stopping) return;
				this.log(`等待 app-server ready 超时 (${READY_TIMEOUT_MS}ms)`);
				this.setStatus({ phase: "error", error: "app-server readiness timeout" });
				return;
			}
			await delay(PROBE_INTERVAL_MS);
		}
	}

	private scheduleRestart(): void {
		if (this.stopping || this.restartTimer) return;
		this.restarts += 1;
		const exp = Math.min(RESTART_BASE_MS * 2 ** Math.max(0, this.restarts - 1), RESTART_MAX_MS);
		this.log(`将在 ${exp}ms 后重启 app-server (第 ${this.restarts} 次)`);
		this.setStatus({ phase: "starting", pid: null, connected: false });
		this.restartTimer = setTimeout(() => {
			this.restartTimer = null;
			void this.start();
		}, exp);
	}

	/**
	 * Signal the whole process **group** we created for the child.
	 *
	 * `codex app-server` re-execs: the process we spawn forks the real listener and
	 * exits. Signalling only `child.pid` therefore orphans the listener, which then
	 * keeps holding the port — the next start would "attach" to that stale process
	 * and `restart()` would silently be a no-op. Because we spawn with
	 * `detached: true` the child is a group leader, so `-pid` reaches every member.
	 */
	private signalGroup(signal: NodeJS.Signals): void {
		const pid = this.child?.pid;
		if (!pid) return;
		try {
			process.kill(-pid, signal);
		} catch {
			/* group already gone, or spawned externally — fall back per-process */
			try {
				this.child?.kill(signal);
			} catch {
				/* already gone */
			}
		}
	}

	/** 优雅 + 强制 kill 当前子进程（整组）；仅对 managed child 生效。 */
	private async killChild(): Promise<void> {
		const child = this.child;
		if (!child || !this.managed) return;
		await new Promise<void>((resolve) => {
			let settled = false;
			const done = (): void => {
				if (settled) return;
				settled = true;
				resolve();
			};
			child.once("exit", done);
			try {
				this.signalGroup("SIGTERM");
			} catch {
				done();
				return;
			}
			setTimeout(() => {
				if (settled) return;
				this.log("SIGTERM 未在宽限期内退出，改用 SIGKILL");
				this.signalGroup("SIGKILL");
				// SIGKILL 后 exit 事件很快到来；再兜底一次。
				setTimeout(done, 500);
			}, STOP_GRACE_MS);
		});
		this.child = null;
		this.managed = false;
	}

	/** 主动重启（`omaw/codex/restart`）：杀掉我们的子进程后重新 spawn。 */
	async restart(): Promise<void> {
		if (this.stopping) return;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.log("收到重启请求");
		if (this.isExternal() || (!this.managed && !this.child)) {
			// 外部进程不归我们管；只能重新探测。端口仍健康就继续复用。
			const healthy = await probeReadyz(this.port);
			this.log(healthy ? "外部 app-server 仍然健康，继续复用" : "外部 app-server 已不可用，尝试自行 spawn");
			if (healthy) {
				this.setStatus({ phase: "ready", error: null, since: Date.now() });
				return;
			}
			await this.start();
			return;
		}
		this.restarts += 1;
		this.setStatus({ phase: "starting", connected: false, error: null });
		await this.killChild();
		this.readyDone = false;
		await this.start();
	}

	/** 服务端优雅退出：只 kill 我们 spawn 的子进程。 */
	async stop(): Promise<void> {
		if (this.stopping) return;
		this.stopping = true;
		if (this.restartTimer) {
			clearTimeout(this.restartTimer);
			this.restartTimer = null;
		}
		this.log("正在停止 app-server 管理…");
		await this.killChild();
		this.stopping = false;
		this._status = { ...this._status, phase: "stopped", pid: null, connected: false };
		this.emit("status", this.status());
	}

	/** 由 codex-client 的连接状态回调；同步进 CodexStatus。 */
	setConnected(connected: boolean, error: string | null = null): void {
		this.setStatus({
			connected,
			// 连接成功后必须清掉上次的 ECONNREFUSED 之类的陈旧错误。
			error: connected ? null : (error ?? this._status.error),
			since: connected ? Date.now() : this._status.since,
		});
	}
}
