/**
 * opencode ACP 客户端 = 通用 JSON-RPC stdio + ACP 握手。
 *
 * 为什么走 ACP（`opencode acp`）而不是 SDK / `opencode run --format json`：
 *   - `opencode run` 是「一次性回合」：没有权限问询、没有 `session/cancel`（打断只能杀进程）、
 *     也没法在一次进程里换模型 —— 只能当兜底，不能当引擎；
 *   - HTTP（`opencode serve`）+ `@opencode-ai/sdk` 能力最全，但要多管一个带鉴权的子进程 +
 *     自己解析 SSE，且审批要在 HTTP 上回包；
 *   - ACP 原生给了我们端口需要的全部动作：`session/new|list|resume|load|close`、
 *     `session/set_config_option`（模型 / 思考档 / 模式）、`session/cancel`、
 *     `session/request_permission`，外加带分桶的 usage。与 dsh 走的是同一套协议，
 *     所以复用 `jsonrpc-stdio.ts`（换的只有可执行文件与握手参数）。
 *
 * 实测（opencode 1.19.0）：
 *   initialize → `{protocolVersion:1, agentCapabilities:{loadSession:true, sessionCapabilities:{list,resume,fork,close},
 *                 promptCapabilities:{image:true, embeddedContext:true}}, agentInfo:{name:"OpenCode", version:"1.19.0"}}`
 */
import { createJsonRpcStdioClient } from "./jsonrpc-stdio.js";

type OpencodeClientOptions = {
	/** opencode 可执行文件；默认 PATH 里的 `opencode` */
	bin?: string;
	/** 额外的 `opencode acp` 参数（例如 `--pure` 跳过外部插件；默认不带，尊重用户配置） */
	args?: string[];
	/** 额外环境变量（测试注入 `XDG_*` / `OPENCODE_*` 用） */
	env?: Record<string, string | undefined>;
	/**
	 * 子进程 cwd（默认继承宿主进程）。至少要等于当前工作区：
	 * opencode 的项目上下文跟着 cwd 走，别让它以为自己在工作台的源码目录里。
	 */
	cwd?: string;
	log?: (text: string) => void;
	timeoutMs?: number;
};

export type OpencodeClient = ReturnType<typeof createJsonRpcStdioClient>;

/**
 * 握手时声明的客户端能力。
 *
 * 全部 `false`：工具都在 opencode 自己的进程里跑，我们不当它的 fs / terminal 桥
 * （与 dsh 一致）。opencode 的 `promptCapabilities.image` 是**它**收图，不需要我们这边声明。
 */
const CLIENT_CAPABILITIES = {
	fs: { readTextFile: false, writeTextFile: false },
	terminal: false,
};

export function createOpencodeClient(options: OpencodeClientOptions = {}): OpencodeClient {
	return createJsonRpcStdioClient({
		bin: options.bin ?? "opencode",
		args: ["acp", ...(options.args ?? [])],
		env: options.env,
		cwd: options.cwd,
		name: "opencode",
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
