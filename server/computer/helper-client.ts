/**
 * helper 的 JSON-RPC 客户端：连 Unix socket → `hello` 握手 → `request`（带截止时间与会话信息）。
 *
 * 与 agent-computer-turbo 的 helper-client.mjs 行为一致：超时后直接断开连接，
 * 避免迟到的回复被误认为下一次请求的回复。`act` 超时后绝不自动重试（可能已经点过了）。
 */
import { connect, type Socket } from "node:net";
import { FrameDecoder, encodeFrame } from "./framing.js";

/** 客户端说的 API 版本（hello.clientApiVersion）；与 helper 不一致时拒绝继续 */
export const CLIENT_API_VERSION = "agent-computer-1";
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
	private readonly decoder = new FrameDecoder();
	private nextId = 1;
	private readonly pending = new Map<number, Pending>();
	private closed = false;

	constructor(private readonly options: { socketPath: string; clientName: string; session: HelperSession }) {}

	/** 建立连接并完成 hello 握手；返回 helper 的版本与权限状态 */
	async connect(timeoutMs = HELLO_TIMEOUT_MS): Promise<HelloResult> {
		const socket = await new Promise<Socket>((resolve, reject) => {
			const s = connect(this.options.socketPath);
			const timer = setTimeout(() => {
				s.destroy();
				reject(new HelperError("timedOut", `连接 helper 超时（${timeoutMs} ms）`, true));
			}, timeoutMs);
			s.once("connect", () => {
				clearTimeout(timer);
				resolve(s);
			});
			s.once("error", (error) => {
				clearTimeout(timer);
				reject(new HelperError("helperFault", `连接 helper 失败：${error.message}`, true));
			});
		});
		this.socket = socket;
		this.attach(socket);

		const hello = (await this.call(
			"hello",
			{ clientApiVersion: CLIENT_API_VERSION, clientName: this.options.clientName },
			timeoutMs,
		)) as HelloResult;
		if (hello?.serverApiVersion !== CLIENT_API_VERSION) {
			this.close();
			throw new HelperError(
				"protocolMismatch",
				`helper 的 API 版本是 ${hello?.serverApiVersion ?? "未知"}，本客户端只支持 ${CLIENT_API_VERSION}`,
			);
		}
		return hello;
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
		this.socket?.destroy();
		this.socket = null;
	}

	private attach(socket: Socket): void {
		socket.on("data", (chunk: Buffer) => {
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
		});
		socket.on("error", (error) => {
			this.failAll(new HelperError("helperFault", `helper 连接出错：${error.message}`, true));
		});
		socket.on("close", () => {
			this.failAll(new HelperError("helperFault", "helper 连接被断开", true));
		});
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
			const socket = this.socket;
			if (!socket || this.closed) {
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
				socket.write(encodeFrame({ jsonrpc: "2.0", id, method, params }));
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

	private failAll(error: Error): void {
		for (const [id, pending] of this.pending) {
			clearTimeout(pending.timer);
			this.pending.delete(id);
			pending.reject(error);
		}
	}
}
