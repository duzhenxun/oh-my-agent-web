/**
 * 本地语音识别桥（macOS 原生 SFSpeechRecognizer，离线）的服务端这一半。
 *
 * 为什么这么绕：Apple 的离线识别只在原生侧可用，而 TCC（隐私授权）认的"主体"是
 * **被 LaunchServices 启动的那个 app**，不是终端拉起的子进程。所以流程是：
 *
 *   1. 服务端先 bind 一个 unix socket；
 *   2. 用 `open -n -a ASRBridge.app --args --socket <path>` 让系统启动那个 app
 *      （它有自己的 Info.plist + NSSpeechRecognitionUsageDescription，首次会弹一次授权）；
 *   3. app 连回来，双方用「4 字节大端长度 + 操作码 + 载荷」分帧：`'A'` 音频、`'E'` 说完；
 *   4. app 用 JSON 行吐 `partial` / `final`。
 *
 * 一个进程一句一句地用：同一时间只有一段话。浏览器侧的点按 → 一句话 → 发送，
 * 所以不需要多路复用；真要并行再加 session id 也不难。
 */
import { spawn } from "node:child_process";
import { existsSync, rmSync } from "node:fs";
import { createServer, type Server, type Socket } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export type AsrBridgeState = "missing" | "starting" | "authorizing" | "ready" | "error";

export type AsrBridgeStatus = {
	state: AsrBridgeState;
	/** 给人看的一句话（missing / error 时必填；authorizing 时说明要等什么） */
	message?: string;
	locale?: string;
	onDevice?: boolean;
};

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

/**
 * 找 ASRBridge.app：源码运行（server/asr/）和构建后（dist/server/asr/）的深度不同，
 * 所以从近到远各试一次，取第一个存在的。`OH_MY_AGENT_ASR_APP` 可以覆盖。
 */
export function resolveAsrAppPath(): string {
	const override = process.env.OH_MY_AGENT_ASR_APP;
	if (override && override.trim() !== "") return override;
	const candidates = [
		new URL("../../../helper/asr/ASRBridge.app", import.meta.url), // dist/server/asr → 仓库根
		new URL("../../helper/asr/ASRBridge.app", import.meta.url), // server/asr → 仓库根
	];
	for (const candidate of candidates) {
		const path = fileURLToPath(candidate);
		if (existsSync(path)) return path;
	}
	// 都不存在也回第一候选：报错时把「去哪儿找过」显示出来，用户知道要 build 什么
	return fileURLToPath(candidates[1]!);
}

/** 与 Swift 那边的操作码对应 */
const OP_AUDIO = 0x41;
const OP_END = 0x45;
const OP_QUIT = 0x58;

/** 一次听写最多攒多久的音频（兜底，正常一句话远小于这个数） */
const MAX_UTTERANCE_BYTES = 16 * 1024 * 1024;

export class AsrBridge {
	private readonly appPath: string;
	private readonly socketPath: string;
	private readonly log: Logger;
	private server: Server | null = null;
	private socket: Socket | null = null;
	private status: AsrBridgeStatus = { state: "starting" };
	private text = "";
	private audioBytes = 0;
	private tail = "";
	private launching = false;
	private finalWaiter: { resolve: (text: string) => void; timer: NodeJS.Timeout } | null = null;

	constructor(options: { appPath: string; path?: string; log: Logger }) {
		this.appPath = options.appPath;
		this.log = options.log;
		// 放在临时目录：unix socket 路径有 104 字节上限，数据目录可能很深
		this.socketPath = options.path ?? join(tmpdir(), "oh-my-agent-web-asr.sock");
	}

	current(): AsrBridgeStatus {
		return this.status;
	}

	/** 当前这句到目前为止的文字（partial 也在内） */
	latestText(): string {
		return this.text;
	}

	/**
	 * 确保桥在跑：没连上就（异步）启动，然后立刻返回当前状态。
	 * **不要 await 到 ready**：首次授权要等用户在系统弹框里点一下，可能几十秒，
	 * HTTP 请求不该挂在那儿 —— 前端轮询状态即可。
	 */
	ensureStarted(): AsrBridgeStatus {
		if (this.socket) return this.status;
		if (this.launching) return this.status;
		if (!existsSync(this.appPath)) {
			this.status = {
				state: "missing",
				message: `找不到本地识别程序：${this.appPath}（在仓库里执行 ./helper/asr/build.sh 生成）`,
			};
			return this.status;
		}
		this.launching = true;
		this.status = { state: "starting" };
		void this.listen().catch((error: unknown) => {
			this.launching = false;
			this.status = { state: "error", message: error instanceof Error ? error.message : String(error) };
			this.log.warn("本地识别桥启动失败", { message: this.status.message });
		});
		return this.status;
	}

	/** bind socket → 用 LaunchServices 拉起 app → 等它连回来 */
	private async listen(): Promise<void> {
		rmSync(this.socketPath, { force: true });
		await new Promise<void>((resolve, reject) => {
			const server = createServer((socket) => this.attach(socket));
			server.once("error", reject);
			server.listen(this.socketPath, () => {
				this.server = server;
				resolve();
			});
		});
		// `-n` = 新实例；`-a` 接 **绝对路径**（相对路径会被当成 app 名字去找，直接失败）
		spawn("open", ["-n", "-a", this.appPath, "--args", "--socket", this.socketPath], {
			stdio: "ignore",
			detached: true,
		}).unref();
		// 连不上（app 没跑起来 / 被 Gatekeeper 拦了）时别一直显示 starting
		const timer = setTimeout(() => {
			if (this.socket) return;
			this.status = {
				state: "error",
				message: "本地识别进程没有连回来（可能是首次运行被系统拦截，或 .app 被移动了）",
			};
		}, 20_000);
		timer.unref();
	}

	private attach(socket: Socket): void {
		this.launching = false;
		this.socket = socket;
		this.status = { state: "authorizing" };
		socket.setEncoding("utf8");
		socket.on("data", (chunk: string) => this.onData(chunk));
		socket.on("close", () => this.detach());
		socket.on("error", () => this.detach());
	}

	private detach(): void {
		this.socket = null;
		this.tail = "";
		if (this.status.state === "ready" || this.status.state === "authorizing") {
			this.status = { state: "starting" };
		}
		this.resolveFinal(this.text);
	}

	/** stdout 是 JSON 行；这里按行切开再解析（一个 chunk 里可能有好几行） */
	private onData(chunk: string): void {
		this.tail += chunk;
		let index = this.tail.indexOf("\n");
		while (index >= 0) {
			const line = this.tail.slice(0, index).trim();
			this.tail = this.tail.slice(index + 1);
			if (line !== "") this.onEvent(line);
			index = this.tail.indexOf("\n");
		}
	}

	private onEvent(line: string): void {
		let event: { type?: string; text?: string; message?: string; status?: string; locale?: string; onDevice?: boolean };
		try {
			event = JSON.parse(line) as typeof event;
		} catch {
			return; // 不是 JSON 就忽略（别因为一行杂音把整条通道废掉）
		}
		switch (event.type) {
			case "starting":
				this.status = { state: "authorizing" };
				return;
			case "auth":
				// 授权还没完；ready 才是「能用了」
				this.status = { state: "authorizing" };
				return;
			case "ready":
				this.status = { state: "ready", locale: event.locale, onDevice: event.onDevice === true };
				return;
			case "partial":
				this.text = event.text ?? "";
				return;
			case "final":
				this.text = event.text ?? this.text;
				this.resolveFinal(this.text);
				return;
			case "error":
				this.status = { state: "error", message: event.message ?? "本地识别进程报错" };
				this.resolveFinal(this.text);
				return;
			default:
				return;
		}
	}

	private resolveFinal(text: string): void {
		const waiter = this.finalWaiter;
		if (!waiter) return;
		this.finalWaiter = null;
		clearTimeout(waiter.timer);
		waiter.resolve(text);
	}

	/** 开一段新的听写（清掉上一句的残留文字） */
	startUtterance(): void {
		this.text = "";
		this.audioBytes = 0;
	}

	/** 送一段 16k 单声道 int16 PCM */
	pushAudio(pcm: Buffer): void {
		const socket = this.socket;
		if (!socket) return;
		if (this.audioBytes + pcm.length > MAX_UTTERANCE_BYTES) return; // 兜底：别把整个进程喂爆
		this.audioBytes += pcm.length;
		const body = Buffer.concat([Buffer.from([OP_AUDIO]), pcm]);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(body.length, 0);
		socket.write(Buffer.concat([header, body]));
	}

	/** 说完：让 app `endAudio()`，等 final（超时就用已经识别到的部分） */
	async endUtterance(timeoutMs = 8000): Promise<string> {
		const socket = this.socket;
		if (!socket) return this.text;
		const body = Buffer.from([OP_END]);
		const header = Buffer.alloc(4);
		header.writeUInt32BE(body.length, 0);
		socket.write(Buffer.concat([header, body]));
		return await new Promise<string>((resolve) => {
			const timer = setTimeout(() => {
				this.finalWaiter = null;
				resolve(this.text);
			}, timeoutMs);
			this.finalWaiter = { resolve, timer };
		});
	}

	/** 服务端退出时收摊：让 app 自己退出，并删掉 socket 文件 */
	dispose(): void {
		try {
			if (this.socket) {
				const body = Buffer.from([OP_QUIT]);
				const header = Buffer.alloc(4);
				header.writeUInt32BE(body.length, 0);
				this.socket.write(Buffer.concat([header, body]));
			}
		} catch {
			// 进程已经没了就算了
		}
		this.server?.close();
		this.server = null;
		this.socket = null;
		rmSync(this.socketPath, { force: true });
	}
}
