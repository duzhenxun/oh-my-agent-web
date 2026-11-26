/**
 * helper 的 JSON-RPC 客户端：建立传输 → `hello` 握手 → `request`（带截止时间与会话信息）。
 *
 * 默认 **stdio**：spawn oh-my-agent-web.app 内嵌的 `helper/agent-computer/agent-computer`，
 * 帧写 stdin、从 stdout 增量解码；用户不需要再单独安装 Agent Computer.app。
 * 显式 `AGENT_COMPUTER_TRANSPORT=socket`（或没找到二进制）时走旧 Unix socket 路径。
 *
 * 与 agent-computer-turbo 的 helper-client.mjs 行为一致：超时后直接断开传输，
 * 避免迟到的回复被误认为下一次请求的回复。`act` 超时后绝不自动重试（可能已经点过了）。
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { connect, type Socket } from "node:net";
import { FrameDecoder, encodeFrame } from "./framing.js";
import type { HelperTransport } from "./paths.js";

/** 客户端说的 API 版本（hello.clientApiVersion）；与 helper 不一致时拒绝继续。
 *  与原版 `agent-computer-turbo` 对齐（见 helper/agent-computer/README.md）。 */
export const CLIENT_API_VERSION = "turbo-1";
export const DEFAULT_DEADLINE_MS = 120_000;
const HELLO_TIMEOUT_MS = 5_000;
/** 需要经过 helper 安全与审批检查的请求：helper 可能弹确认框，本地超时要多等一段 */
const GATED_REQUESTS = new Set(["observeApp", "act", "appCommands", "waitFor"]);
const APPROVAL_ALLOWANCE_MS = 120_000;
const LOCAL_GRACE_MS = 5_000;

export type HelloResult = {
	serverApiVersion?: string;
	helperVersion?: string;
	pid?: number;
	permissions?: { accessibility?: boolean; screenRecording?: boolean };
};

export type HelperSession = {
	sessionId: string;
	turnId: string | null;
	agent?: { name?: string; ancestorPids?: number[] };
};

type HelperClientOptions = {
	socketPath: string;
	clientName: string;
	session: HelperSession;
	/** 内嵌二进制路径；给值且 transport 未显式指定时默认走 stdio */
	binaryPath?: string | null;
	/** 显式选传输（测试 / 排障用）；不传就按有没有 binaryPath 决定 */
	transport?: HelperTransport;
};

/** helper 返回的错误（或本地产生的错误）。`errorName` 对应 helper 的错误名，如 accessMissing */
export class HelperError extends Error {
	readonly errorName: string;
	readonly retryable: boolean;

	constructor(errorName: string, message: string, retryable = false) {
		super(message);
		this.name = "HelperError";
		this.errorName = errorName;
		this.retryable = retryable;
	}
}

type Pending = {
	resolve: (value: unknown) => void;
	reject: (error: Error) => void;
	timer: NodeJS.Timeout;
};

export class HelperClient {
	private socket: Socket | null = null;
	private child: ChildProcessWithoutNullStreams | null = null;
	private mode: HelperTransport | null = null;
	private readonly decoder = new FrameDecoder();
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closed = false;
	/** helper 的 stderr 可能被 chunk 切断，攒成整行再打，日志才看得懂 */
	private stderrBuffer = "";

	constructor(private readonly options: HelperClientOptions) {}

	/** 建立连接并完成 hello 握手；返回 helper 的版本与权限状态 */
	async connect(timeoutMs = HELLO_TIMEOUT_MS): Promise<HelloResult> {
		const transport = this.options.transport ?? (this.options.binaryPath ? "stdio" : "socket");
		this.mode = transport;
		try {
			if (transport === "stdio") await this.startStdio(timeoutMs);
			else await this.startSocket(timeoutMs);

			const hello = (await this.call(
				"hello",
				{ clientApiVersion: CLIENT_API_VERSION, clientName: this.options.clientName },
				timeoutMs,
			)) as HelloResult;
			if (hello?.serverApiVersion !== CLIENT_API_VERSION) {
				throw new HelperError(
					"protocolMismatch",
					`helper 的 API 版本是 ${hello?.serverApiVersion ?? "未知"}，本客户端只支持 ${CLIENT_API_VERSION}`,
				);
			}
			return hello;
		} catch (error) {
			// 握手没成就不留半开连接 / 子进程
			this.close();
			throw error;
		}
	}

	/** 发一个业务请求（observeApp、act、findApps 等）；deadlineMs 是 helper 端的截止时间 */
	request(requestType: string, payload: unknown, deadlineMs = DEFAULT_DEADLINE_MS): Promise<unknown> {
		const localTimeout = deadlineMs + LOCAL_GRACE_MS + (GATED_REQUESTS.has(requestType) ? APPROVAL_ALLOWANCE_MS : 0);
		return this.call(
			"request",
			{
				requestType,
				payload,
				deadlineUnixMillis: Date.now() + deadlineMs,
				session: this.options.session,
			},
			localTimeout,
		);
	}

	close(): void {
		if (this.closed) return;
		this.closed = true;
		this.failAll(new HelperError("helperFault", "helper 连接已关闭", true));
		this.flushStderr();

		this.socket?.destroy();
		this.socket = null;

		const child = this.child;
		this.child = null;
		if (child) {
			// 先关 stdin（helper 读到 EOF 会自己退出），再补一刀，避免留下孤儿进程
			try {
				child.stdin.end();
			} catch {
				// 已经退出就算了
			}
			if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
		}
	}

	// MARK: - 传输启动

	private startSocket(timeoutMs: number): Promise<void> {
		return new Promise<Socket>((resolve, reject) => {
			const socket = connect(this.options.socketPath);
			const timer = setTimeout(() => {
				socket.destroy();
				reject(new HelperError("timedOut", `连接 helper 超时（${timeoutMs} ms）`, true));
			}, timeoutMs);
			socket.once("connect", () => {
				clearTimeout(timer);
				this.socket = socket;
				this.attachSocket(socket);
				resolve(socket);
			});
			socket.once("error", (error) => {
				clearTimeout(timer);
				reject(new HelperError("helperFault", `连接 helper 失败：${error.message}`, true));
			});
		}).then(() => undefined);
	}

	private async startStdio(timeoutMs: number): Promise<void> {
		const binary = this.options.binaryPath;
		if (!binary) {
			throw new HelperError(
				"helperFault",
				"没找到内嵌的 agent-computer 二进制；可设 AGENT_COMPUTER_BINARY 指定路径，或 AGENT_COMPUTER_TRANSPORT=socket 回落旧 .app helper",
				true,
			);
		}

		const child = spawn(binary, ["--stdio"], { stdio: ["pipe", "pipe", "pipe"], env: process.env });
		this.child = child;

		child.stdout.on("data", (chunk: Buffer) => this.onData(chunk));
		child.stderr.on("data", (chunk: Buffer) => this.collectStderr(chunk));
		// stdin 写失败（helper 已退出）不能把整台服务带崩：由 pending 的 reject 报出去
		child.stdin.on("error", (error) => {
			this.failAll(new HelperError("helperFault", `写内嵌 helper 失败：${error.message}`, true));
		});
		child.on("error", (error) => {
			this.failAll(new HelperError("helperFault", `内嵌 helper 出错：${error.message}`, true));
			this.closed = true;
		});
		child.on("exit", (code, signal) => {
			this.child = null;
			this.flushStderr();
			if (this.closed) return;
			// 父进程（本服务）没主动关，说明 helper 自己死了：把在等的请求如实 reject 掉
			this.closed = true;
			const reason = signal ? `信号 ${signal}` : `退出码 ${code ?? "未知"}`;
			this.failAll(new HelperError("helperFault", `内嵌 helper 已退出（${reason}）`, true));
		});

		await new Promise<void>((resolve, reject) => {
			const timer = setTimeout(() => {
				reject(new HelperError("timedOut", `启动内嵌 helper 超时（${timeoutMs} ms）`, true));
			}, timeoutMs);
			child.once("spawn", () => {
				clearTimeout(timer);
				resolve();
			});
			child.once("error", (error) => {
				clearTimeout(timer);
				reject(new HelperError("helperFault", `启动内嵌 helper 失败：${error.message}`, true));
			});
		});
	}

	// MARK: - 收发

	private attachSocket(socket: Socket): void {
		socket.on("data", (chunk: Buffer) => this.onData(chunk));
		socket.on("error", (error) => {
			this.failAll(new HelperError("helperFault", `helper 连接出错：${error.message}`, true));
		});
		socket.on("close", () => {
			this.closed = true;
			this.failAll(new HelperError("helperFault", "helper 连接被断开", true));
		});
	}

	private onData(chunk: Buffer): void {
		let frames: unknown[];
		try {
			frames = this.decoder.push(chunk);
		} catch (error) {
			this.close();
			const message = error instanceof Error ? error.message : String(error);
			this.failAll(new HelperError("helperFault", `helper 协议错误：${message}`));
			return;
		}
		for (const frame of frames) this.onMessage(frame);
	}

	private onMessage(message: unknown): void {
		if (!message || typeof message !== "object") return;
		const msg = message as {
			id?: number;
			result?: unknown;
			error?: { code?: number; message?: string; data?: { name?: string; retryable?: boolean } };
		};
		if (typeof msg.id !== "number") return;
		const pending = this.pending.get(msg.id);
		if (!pending) return;
		this.pending.delete(msg.id);
		clearTimeout(pending.timer);
		if (msg.error) {
			const name = msg.error.data?.name ?? `code_${msg.error.code ?? "unknown"}`;
			pending.reject(new HelperError(name, msg.error.message ?? "helper 返回错误", msg.error.data?.retryable === true));
		} else {
			pending.resolve(msg.result);
		}
	}

	private call(method: string, params: unknown, timeoutMs: number): Promise<unknown> {
		return new Promise((resolve, reject) => {
			if (this.mode === null || this.closed) {
				reject(new HelperError("helperFault", "helper 未连接", true));
				return;
			}
			const id = this.nextId++;
			const timer = setTimeout(() => {
				// 超时：断开，避免晚到的回复被当成下一次请求的回复
				this.pending.delete(id);
				this.close();
				reject(
					new HelperError(
						"timedOut",
						`helper 没有在 ${Math.round(timeoutMs / 1000)} 秒内回复「${method}」；如果是操作，应用里可能已经执行，请先 observe 确认再重试`,
						false,
					),
				);
			}, timeoutMs);
			this.pending.set(id, { resolve, reject, timer });
			try {
				this.writeFrame({ jsonrpc: "2.0", id, method, params });
			} catch (error) {
				this.pending.delete(id);
				clearTimeout(timer);
				reject(
					new HelperError(
						"badArguments",
						`无法发送 ${method}：${error instanceof Error ? error.message : String(error)}`,
					),
				);
			}
		});
	}

	private writeFrame(frame: unknown): void {
		const data = encodeFrame(frame);
		if (this.mode === "stdio") {
			const stdin = this.child?.stdin;
			if (!stdin || stdin.destroyed) throw new Error("内嵌 helper 已退出");
			stdin.write(data);
			return;
		}
		const socket = this.socket;
		if (!socket || socket.destroyed) throw new Error("helper 未连接");
		socket.write(data);
	}

	private failAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}

	// MARK: - helper 日志

	private collectStderr(chunk: Buffer): void {
		this.stderrBuffer += chunk.toString("utf8");
		let index = this.stderrBuffer.indexOf("\n");
		while (index >= 0) {
			const line = this.stderrBuffer.slice(0, index).trimEnd();
			this.stderrBuffer = this.stderrBuffer.slice(index + 1);
			if (line !== "") console.error(`[computer/helper] ${line}`);
			index = this.stderrBuffer.indexOf("\n");
		}
	}

	private flushStderr(): void {
		const line = this.stderrBuffer.trimEnd();
		this.stderrBuffer = "";
		if (line !== "") console.error(`[computer/helper] ${line}`);
	}
}
