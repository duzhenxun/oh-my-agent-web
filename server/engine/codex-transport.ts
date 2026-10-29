/**
 * codex app-server 客户端（JSONL over stdio）。
 *
 * 为什么是「子进程 + stdio」而不是自建协议：codex 自己就有本地服务（`codex app-server`），
 * 项目 / 会话 / 回合 / 审批全走它的 JSON-RPC。我们只当客户端，**不碰它的存储格式**
 * （`state_5.sqlite`、rollout jsonl 都不直写），这样 Codex Desktop / CLI 与工作台看到的是
 * 同一份会话。
 *
 * 生命周期：懒启动（第一次 request 才 spawn）+ 按需重建（进程挂了下次请求再拉起）。
 * 这样「机器上没装 codex」不会让工作台起不来 —— 只有在真正用这个引擎时才报错。
 *
 * 帧格式（实测 0.162/0.163 一致）：
 *   请求 → `{"id":1,"method":"thread/list","params":{...}}\n`
 *   响应 → `{"id":1,"result":{...}}` / `{"id":1,"error":{"code":-32602,"message":"..."}}`
 *   通知 → `{"method":"item/agentMessage/delta","params":{...},"emittedAtMs":...}`
 *   服务端请求（审批）→ `{"id":9,"method":"item/commandExecution/requestApproval","params":{...}}`
 *     客户端必须回 `{"id":9,"result":{...}}`，否则那一轮会一直等。
 */
import { createJsonRpcStdioClient, type JsonRpcNotification, type JsonRpcServerRequest } from "./jsonrpc-stdio.js";

export type CodexNotification = JsonRpcNotification;
export type CodexServerRequest = JsonRpcServerRequest;

type CodexClientOptions = {
	/** codex 可执行文件；默认 PATH 里的 `codex` */
	bin?: string;
	/** 单独的 CODEX_HOME（测试用；不传就用用户自己的 ~/.codex） */
	home?: string;
	/** 客户端名（进 userAgent，方便在 codex 日志里认出来） */
	clientName?: string;
	clientVersion?: string;
	log?: (text: string) => void;
	/** 单次请求默认超时（毫秒）：模型列表/历史读取这类不该无限等 */
	timeoutMs?: number;
};

export type CodexClient = ReturnType<typeof createJsonRpcStdioClient>;

/**
 * codex app-server 客户端 = 通用 JSON-RPC stdio 客户端 + codex 的握手。
 * 握手结果里的 userAgent 形如 `agent-web/0.163.0 (Mac OS …)`，取中间的版本号。
 */
export function createCodexClient(options: CodexClientOptions = {}): CodexClient {
	const log = options.log ?? (() => {});
	return createJsonRpcStdioClient({
		bin: options.bin ?? "codex",
		args: ["app-server"],
		env: options.home ? { CODEX_HOME: options.home } : undefined,
		name: "codex",
		log,
		timeoutMs: options.timeoutMs,
		// codex 不带 jsonrpc 信封（实测 0.162/0.163 都接受裸 {id,method,params}）
		jsonrpc: false,
		async handshake(call) {
			const result = (await call("initialize", {
				clientInfo: {
					name: options.clientName ?? "agent-web",
					title: "agent-web",
					version: options.clientVersion ?? "0.1.0",
				},
				// experimentalApi 打开隐藏方法（project/* 等）；实测 0.162/0.163 都支持
				capabilities: { experimentalApi: true, requestAttestation: false },
			})) as { userAgent?: string } | undefined;
			const match = /^[^/]+\/([0-9][^\s]*)/.exec(result?.userAgent ?? "");
			return { version: match?.[1] ?? null };
		},
	});
}
