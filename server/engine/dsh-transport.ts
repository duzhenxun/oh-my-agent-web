/**
 * DSH（DeepSeek Harness）ACP 客户端 = 通用 JSON-RPC stdio + ACP 握手。
 *
 * 为什么走 ACP（`dsh --profile acp`）而不是 SDK（`--profile sdk`）或 headless：
 *   - SDK 面只有 `initialize / session/prompt / shutdown`，没有会话列表/续接/取消/配置/权限，
 *     这些要么自己读文件、要么自己写插件补（等于把 26 个本地依赖 + 重启换模型揽进来）；
 *   - ACP 原生给了 `session/new|list|resume|close`、`session/set_config_option`（模型/思考档）、
 *     `session/cancel`、`session/request_permission`，我们只需当客户端；
 *   - headless 是一次性进程，没有权限问询。
 *
 * 协议细节见 ADR-0037；映射规则在 dsh-map.ts（纯函数）。
 */
import { createJsonRpcStdioClient } from "./jsonrpc-stdio.js";

type DshClientOptions = {
	/** dsh 可执行文件；默认 PATH 里的 `dsh` */
	bin?: string;
	/** 单独的 DSH_HOME（测试用；不传就用 ~/.dsh） */
	home?: string;
	/**
	 * 额外的 patch 叠加层（`dsh --patch <file>`，可多个）。
	 * 用途：把自定义 provider / 默认模型带给 **acp** profile —— 用户通常只在 web profile
	 * 里配了这些，而 acp 是另一套 profile，不会自动继承。
	 */
	patches?: string[];
	log?: (text: string) => void;
	timeoutMs?: number;
};

export type DshClient = ReturnType<typeof createJsonRpcStdioClient>;

/** ACP 要求初始化的能力协商；我们不用它的 fs/terminal 桥（工具都在 DSH 进程里跑） */
const CLIENT_CAPABILITIES = {
	fs: { readTextFile: false, writeTextFile: false },
	terminal: false,
};

export function createDshClient(options: DshClientOptions = {}): DshClient {
	return createJsonRpcStdioClient({
		bin: options.bin ?? "dsh",
		args: ["--profile", "acp", ...(options.patches ?? []).flatMap((file) => ["--patch", file])],
		env: options.home ? { DSH_HOME: options.home } : undefined,
		name: "dsh",
		log: options.log ?? (() => {}),
		timeoutMs: options.timeoutMs,
		// ACP 是标准 JSON-RPC 2.0：帧里必须带 jsonrpc 字段
		jsonrpc: true,
		async handshake(call) {
			const result = (await call("initialize", {
				protocolVersion: 1,
				clientCapabilities: CLIENT_CAPABILITIES,
			})) as { agentInfo?: { version?: string } } | undefined;
			return { version: result?.agentInfo?.version ?? null };
		},
	});
}
