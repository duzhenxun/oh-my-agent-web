/**
 * 通用「子进程 + stdio JSON-RPC」客户端（codex / dsh 共用）。
 *
 * 为什么需要它：codex 的 `app-server` 和 dsh 的 `--profile acp` 是**同一种东西**——
 * 每行一个 JSON-RPC 帧、stdout 只走协议、服务端会反过来向我们发请求（审批/权限）。
 * 差异只有三处，全部参数化：
 *   1. 启动命令（`codex app-server` / `dsh --profile acp`）；
 *   2. 握手方法（都是 `initialize`，但参数/返回值不同）；
 *   3. 帧里带不带 `"jsonrpc":"2.0"`（ACP 要求；codex 不带）。
 *
 * 生命周期纪律（两个引擎一致）：
 *   - **懒启动**：第一次 request 才 spawn —— 机器上没装某个 CLI 不该让工作台起不来；
 *   - **挂了就重来**：子进程退出 → 拒掉所有在飞请求 → 下次请求重新拉起；
 *   - **退出即收**：`close()` 杀掉子进程（codex 由此释放它持有的全部 thread 写锁）。
 *
 * 帧格式：
 *   请求   → `{"id":1,"method":"…","params":{…}}\n`
 *   响应   → `{"id":1,"result":{…}}` / `{"id":1,"error":{"code":-32602,"message":"…"}}`
 *   通知   → `{"method":"…","params":{…}}`（无 id）
 *   服务端请求 → `{"id":9,"method":"…","params":{…}}`（有 id + method，**必须回包**否则对端一直等）
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { killTree, resolveCli } from "../util/spawn-cli.js";

export type JsonRpcNotification = { method: string; params: Record<string, unknown> };
export type JsonRpcServerRequest = { id: number; method: string; params: Record<string, unknown> };

type Pending = {
	method: string;
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: ReturnType<typeof setTimeout>;
};

type JsonRpcStdioOptions = {
	/** 可执行文件（PATH 里的名字或绝对路径） */
	bin: string;
	/** 启动参数（如 ["app-server"] / ["--profile","acp"]） */
	args: string[];
	/** 额外环境变量（codex 的 CODEX_HOME / dsh 的 DSH_HOME） */
	env?: Record<string, string | undefined>;
	/**
	 * 子进程的工作目录。不传 = 继承宿主进程的 cwd。
	 *
	 * 这个不是摆设：opencode 按「cwd 所属项目」过滤 `session/list`，继承宿主目录会让
	 * 侧栏只看到宿主启动目录那一个项目的历史（详见 opencode-sessions.ts 文件头）。
	 */
	cwd?: string;
	/** 日志前缀（例如 "codex" / "dsh"） */
	name: string;
	log?: (text: string) => void;
	/** 单次请求默认超时 */
	timeoutMs?: number;
	/** 帧里是否带 `jsonrpc: "2.0"`（ACP 要求） */
	jsonrpc?: boolean;
	/**
	 * 握手：拿到一个「不经过 ensureStarted 的 request」。
	 * 返回值里的 version 会作为 `version()` 的内容（拿不到给 null）。
	 */
	handshake: (call: (method: string, params?: unknown) => Promise<unknown>) => Promise<{ version?: string | null }>;
};

type JsonRpcStdioClient = {
	request: <T>(method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<T>;
	/**
	 * 发一条**通知**（不带 id、不等响应）。
	 * ACP 的 `session/cancel` 就是通知：发成请求会被对端当成「没注册的方法」直接丢掉。
	 */
	notify: (method: string, params?: unknown) => void;
	/** 回复服务端请求（审批 / 权限） */
	respond: (id: number, result: unknown) => void;
	respondError: (id: number, code: number, message: string) => void;
	onNotification: (listener: (notification: JsonRpcNotification) => void) => () => void;
	onServerRequest: (listener: (request: JsonRpcServerRequest) => void) => () => void;
	onExit: (listener: (error: Error) => void) => () => void;
	ensureStarted: () => Promise<void>;
	/** 握手时解析出来的版本号；没连上时为 null */
	version: () => string | null;
	isReady: () => boolean;
	/** 杀掉子进程并拒掉在飞请求 */
	close: () => void;
};

export function createJsonRpcStdioClient(options: JsonRpcStdioOptions): JsonRpcStdioClient {
	const baseTimeout = options.timeoutMs ?? 30_000;
	const prefix = options.name;
	let child: ChildProcessWithoutNullStreams | null = null;
	let starting: Promise<void> | null = null;
	let initialized = false;
	let seq = 0;
	let version: string | null = null;
	let buffer = "";
	const pending = new Map<number, Pending>();
	const notificationListeners = new Set<(notification: JsonRpcNotification) => void>();
	const serverRequestListeners = new Set<(request: JsonRpcServerRequest) => void>();
	const exitListeners = new Set<(error: Error) => void>();

	const rejectAll = (error: Error): void => {
		for (const [id, entry] of pending) {
			clearTimeout(entry.timer);
			entry.reject(error);
			pending.delete(id);
		}
	};

	const send = (payload: Record<string, unknown>): void => {
		if (!child) throw new Error(`${prefix} 未连接`);
		// 子进程刚死、或已经被 close() 掉的时候这里还在写 → 会抛 EPIPE。
		// 先自己拦一道，给调用方一个能看懂的错，而不是趟进 EPIPE 的未捕获异常（见 wire 里的 stdin 监听）
		if (child.stdin.destroyed || !child.stdin.writable) throw new Error(`${prefix} 管道已关闭`);
		child.stdin.write(`${JSON.stringify(options.jsonrpc ? { jsonrpc: "2.0", ...payload } : payload)}\n`);
	};

	const respond = (id: number, result: unknown): void => {
		try {
			send({ id, result });
		} catch (error) {
			options.log?.(`${prefix}: 回包失败（${id}）：${error instanceof Error ? error.message : String(error)}`);
		}
	};

	const handleLine = (line: string): void => {
		if (line.trim() === "") return;
		let message: Record<string, unknown>;
		try {
			message = JSON.parse(line) as Record<string, unknown>;
		} catch {
			options.log?.(`${prefix}: 收到非 JSON 帧（已忽略）：${line.slice(0, 120)}`);
			return;
		}
		const id = typeof message.id === "number" ? message.id : null;
		const method = typeof message.method === "string" ? message.method : null;

		if (method && id !== null) {
			const request = { id, method, params: (message.params ?? {}) as Record<string, unknown> };
			if (serverRequestListeners.size === 0) {
				// 没人接也得回一个：不回包对端会一直等下去
				respond(id, { decision: "decline" });
				return;
			}
			for (const listener of serverRequestListeners) listener(request);
			return;
		}
		if (method) {
			const notification = { method, params: (message.params ?? {}) as Record<string, unknown> };
			for (const listener of notificationListeners) listener(notification);
			return;
		}
		if (id === null) return;
		const entry = pending.get(id);
		if (!entry) return;
		pending.delete(id);
		clearTimeout(entry.timer);
		const error = message.error as { code?: number; message?: string; data?: unknown } | undefined;
		if (error) {
			const detail =
				error.data && typeof error.data === "object" && "details" in (error.data as Record<string, unknown>)
					? `：${String((error.data as { details?: unknown }).details)}`
					: "";
			entry.reject(new Error(`${error.message ?? `${prefix} 请求失败`}${detail}`));
		} else entry.resolve(message.result);
	};

	const wire = (process: ChildProcessWithoutNullStreams): void => {
		process.stdout.setEncoding("utf8");
		process.stdout.on("data", (chunk: string) => {
			// close() 之后旧进程可能还会吐完缓冲区里的字节：不许它写进“新进程”的 buffer，
			// 否则重启后第一帧会被旧半行拼坏 → JSON.parse 失败 → initialize 超时（看着就是「切回来连不上」）
			if (child !== process) return;
			buffer += chunk;
			let index: number;
			while ((index = buffer.indexOf("\n")) >= 0) {
				const line = buffer.slice(0, index);
				buffer = buffer.slice(index + 1);
				handleLine(line);
			}
		});
		process.stderr.setEncoding("utf8");
		process.stderr.on("data", (chunk: string) => {
			const text = chunk.trim();
			// 两边都会在 stderr 打启动信息，别把日志刷满
			if (text !== "" && !/^(WARNING|note:)/.test(text)) options.log?.(`${prefix}: ${text.slice(0, 400)}`);
		});
		const onGone = (reason: string) => {
			if (child !== process) return;
			child = null;
			initialized = false;
			version = null;
			starting = null;
			buffer = "";
			const error = new Error(reason);
			rejectAll(error);
			for (const listener of exitListeners) listener(error);
		};
		process.on("exit", (code) => onGone(`${prefix} 已退出（code ${code ?? "?"}）`));
		process.on("error", (error) => onGone(`${prefix} 启动失败：${error.message}`));
		/**
		 * stdin 的 error **必须**接住。
		 *
		 * 子进程已经没了但我们还在 write（审批回包、turn/interrupt、通知都可能撞上），
		 * Node 会把 EPIPE 以 'error' 事件形式丢到 Writable 上；没监听就是**未捕获异常**，
		 * 而本仓只注册了 unhandledRejection（index.ts），于是整个工作台跟着退出。
		 * 处理方式与进程退出一致：拒掉在飞请求、通知 onExit（上层会标记引擎不可用）。
		 */
		process.stdin.on("error", (error: Error) => onGone(`${prefix} 写入失败：${error.message}`));
	};

	const requestRaw = <T>(method: string, params?: unknown, timeoutMs = baseTimeout): Promise<T> => {
		const id = ++seq;
		return new Promise<T>((resolve, reject) => {
			const timer = setTimeout(() => {
				pending.delete(id);
				reject(new Error(`${prefix} 请求超时：${method}`));
			}, timeoutMs);
			pending.set(id, { method, resolve: (value) => resolve(value as T), reject, timer });
			try {
				send({ id, method, params: params ?? {} });
			} catch (error) {
				pending.delete(id);
				clearTimeout(timer);
				reject(error instanceof Error ? error : new Error(String(error)));
			}
		});
	};

	const ensureStarted = async (): Promise<void> => {
		if (initialized && child) return;
		if (starting) return starting;
		starting = (async () => {
			if (!child) {
				const env = { ...process.env };
				for (const [key, value] of Object.entries(options.env ?? {})) {
					if (value === undefined) delete env[key];
					else env[key] = value;
				}
				// Windows 上 codex/dsh 是 .cmd shim：resolveCli 负责改成 cmd.exe /c
				const command = resolveCli(options.bin, options.args, env);
				const next = spawn(command.file, command.args, {
					...command.options,
					env,
					cwd: options.cwd,
					stdio: ["pipe", "pipe", "pipe"],
				});
				child = next;
				wire(next);
			}
			const result = await options.handshake((method, params) => requestRaw<unknown>(method, params));
			version = result.version ?? null;
			initialized = true;
		})();
		try {
			await starting;
		} catch (error) {
			const process = child;
			child = null;
			initialized = false;
			version = null;
			if (process) killTree(process);
			throw error instanceof Error ? error : new Error(String(error));
		} finally {
			starting = null;
		}
	};

	return {
		async request<T>(method: string, params?: unknown, requestOptions?: { timeoutMs?: number }) {
			await ensureStarted();
			return requestRaw<T>(method, params, requestOptions?.timeoutMs);
		},
		notify: (method, params) => {
			try {
				// 通知也要求「已连接」：没连上就没人收，静默丢掉即可
				if (!child) return;
				send({ method, params: params ?? {} });
			} catch (error) {
				options.log?.(
					`${prefix}: 通知发送失败（${method}）：${error instanceof Error ? error.message : String(error)}`,
				);
			}
		},
		respond,
		respondError: (id, code, message) => {
			try {
				send({ id, error: { code, message } });
			} catch {
				/* 进程没了就算了 */
			}
		},
		onNotification: (listener) => {
			notificationListeners.add(listener);
			return () => notificationListeners.delete(listener);
		},
		onServerRequest: (listener) => {
			serverRequestListeners.add(listener);
			return () => serverRequestListeners.delete(listener);
		},
		onExit: (listener) => {
			exitListeners.add(listener);
			return () => exitListeners.delete(listener);
		},
		ensureStarted,
		version: () => version,
		isReady: () => initialized && child !== null,
		close: () => {
			const process = child;
			child = null;
			initialized = false;
			version = null;
			// 必须清：onGone 里那句 `if (child !== process) return` 在 close 之后会提前返回，
			// 所以这条路径上没人会帮我们清 buffer（旧半行会污染下次 spawn 的第一帧）
			buffer = "";
			rejectAll(new Error(`${prefix} 已关闭`));
			if (process) killTree(process);
		},
	};
}
