/**
 * Claude Code 的 ACP 客户端（ADR-0044）= 通用 JSON-RPC stdio + ACP 握手。
 *
 * 为什么走 `claude-code-acp`（`@zed-industries/claude-code-acp`）而不是 SDK / `claude -p`：
 *   - `claude -p --output-format stream-json` 是**一次性回合**：权限问询要靠管道里的 control
 *     帧自己实现，也没有 `session/list`（历史会话只能自己扫 `~/.claude/projects`），
 *     换模型要重启进程 —— 只能当兜底，不能当引擎；
 *   - `@anthropic-ai/claude-agent-sdk` 能力最全，但它把 Claude Code 整个打包进宿主进程，
 *     版本跟着本工作台的依赖走，用户本机的 `claude` 登录态 / 权限配置反而管不到；
 *   - 这个适配器是 Zed 维护的官方级 ACP 实现，对外给的就是我们要的那几个动作：
 *     `session/new|load|resume|list`、`session/set_model`、`session/set_mode`、
 *     `session/cancel`、`session/request_permission`。与 dsh / opencode 走同一套协议，
 *     所以复用 `jsonrpc-stdio.ts`（换的只有可执行文件与握手参数）。
 *
 * 实测（claude-code-acp 0.16.2 + Claude Code 2.1.301）：
 *   initialize → `{protocolVersion:1, agentCapabilities:{loadSession:true,
 *                 sessionCapabilities:{list,resume,fork}, promptCapabilities:{image,embeddedContext}},
 *                 agentInfo:{name:"@zed-industries/claude-code-acp", title:"Claude Code", version}}`
 *   session/new → `{sessionId, models:{availableModels:[{modelId,name,description}], currentModelId},
 *                   modes:{currentModeId, availableModes}}`
 *
 * 与 dsh / opencode 的两处差异（决定了 claude.ts 的写法）：
 *   1. 没有 `configOptions`：模型是 `session/new` 返回的 `models`，切换走 `session/set_model`
 *      （不是 `session/set_config_option`），思考档位这套协议里压根没有；
 *   2. `session/resume`（不重放历史）与 `session/load`（重放历史）都在，所以「续接」用前者，
 *      历史回放交给 JSONL（见 claude-sessions.ts），不必让适配器把整段历史再推一遍。
 */
import { findExecutable } from "../util/spawn-cli.js";
import { createJsonRpcStdioClient } from "./jsonrpc-stdio.js";

/**
 * 这个适配器**改过名**，两个包都还在被装着，所以两个 bin 名都认：
 *   - `@zed-industries/claude-code-acp` → `claude-code-acp`（老包，npm 上已标记 deprecated）；
 *   - `@agentclientprotocol/claude-agent-acp` → `claude-agent-acp`（改名后的新包）。
 * 只认一个的话，用户按 deprecation 提示装完新包反而变成「没有找到适配器」。
 */
export const CLAUDE_ACP_BINS = ["claude-code-acp", "claude-agent-acp"] as const;

/** 默认可执行文件：PATH 里先命中哪个用哪个；都没装就报第一个名字（错误信息里再教怎么装） */
export function defaultClaudeBin(
	env: NodeJS.ProcessEnv = process.env,
	find: (bin: string, env: NodeJS.ProcessEnv) => string | null = (bin, e) => findExecutable(bin, e),
): string {
	for (const bin of CLAUDE_ACP_BINS) {
		if (find(bin, env)) return bin;
	}
	return CLAUDE_ACP_BINS[0];
}

type ClaudeClientOptions = {
	/** 可执行文件；默认取 PATH 里的 `claude-code-acp` / `claude-agent-acp`（见 `defaultClaudeBin`） */
	bin?: string;
	/** 额外参数（逃生阀：AGENT_WEB_CLAUDE_ARGS） */
	args?: string[];
	/** 额外环境变量（例如 CLAUDE_CONFIG_DIR） */
	env?: Record<string, string | undefined>;
	/**
	 * 子进程 cwd（默认继承宿主进程）。
	 * 注意：Claude 的**会话作用域**跟着 `session/new` 里的 cwd 走，不跟进程 cwd；
	 * 所以这里只是「别让它以为自己在工作台的源码目录里」。
	 */
	cwd?: string;
	log?: (text: string) => void;
	timeoutMs?: number;
};

export type ClaudeClient = ReturnType<typeof createJsonRpcStdioClient>;

/**
 * 握手时声明的客户端能力。
 *
 * 全部 `false`：Claude 自己的工具（Bash / Read / Write …）在适配器进程里跑，
 * 我们不当它的 fs / terminal 桥（与 dsh / opencode 一致）。
 * `promptCapabilities.image` 是**它**收图，不需要我们声明。
 */
const CLIENT_CAPABILITIES = {
	fs: { readTextFile: false, writeTextFile: false },
	terminal: false,
};

export function createClaudeClient(options: ClaudeClientOptions = {}): ClaudeClient {
	return createJsonRpcStdioClient({
		bin: options.bin ?? defaultClaudeBin(),
		args: options.args ?? [],
		env: options.env,
		cwd: options.cwd,
		name: "claude",
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
