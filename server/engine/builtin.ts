/**
 * 内置引擎注册（进程启动时装配一次）。
 *
 * 从 index.ts 搬出来（ADR-0010 的 400 行护栏）：这里是**唯一**知道「有哪些引擎、
 * 各自怎么造、界面怎么描述」的地方，index 只需要拿注册表 + 目录。
 *
 * 加一个引擎的完整动作仍然是：写 `server/engine/<name>.ts` + 在这个数组里加一项
 * （ADR-0024 §1）；前端不需要改 —— 切换面板读的是注册表。
 */
import type { ClaudeClient } from "./claude-transport.js";
import { createClaudeEngine } from "./claude.js";
import { probeCliVersion, probePackageVersion } from "./cli-version.js";
import type { CodexClient } from "./codex-transport.js";
import { createCodexEngine, type CodexSubagentPolicy } from "./codex.js";
import type { DshClient } from "./dsh-transport.js";
import { createDshEngine } from "./dsh.js";
import { createFakeEngine } from "./fake.js";
import type { OpencodeClient } from "./opencode-transport.js";
import { createOpencodeEngine } from "./opencode.js";
import { createPiSdkEngine } from "./pi-sdk.js";
import { piSdkVersion } from "./pi-version.js";
import { createEngineRegistry, FAKE_CAPABILITIES, PI_CAPABILITIES, type EngineRegistry } from "./registry.js";

/**
 * ACP 适配器（claude-code-acp）的版本：它不认 `--version`（直接去握手），
 * 所以读 bin 旁边的 package.json —— 与握手给的 `agentInfo.version` 是同一个数。
 */
function claudeVersionOf(bin: string | undefined): Promise<string | null> {
	return Promise.resolve(probePackageVersion(bin ?? "claude-code-acp"));
}

export function createBuiltinEngineRegistry(options: {
	/** 引擎自己发的运行期提示（pi 的 SDK 会发）：转给界面 */
	onNotice: (text: string, level?: "info" | "warn" | "error") => void;
	/** 技能目录（交给 pi 展开 `/skill:xxx` 用；不给就只认 pi 自己的） */
	skillPaths?: string[];
	/**
	 * 「下一步建议」要几条（设置里「想想」的那个数，1~5）。
	 *
	 * pi / codex 都在**建会话/开 thread 时现读**（改了设置，下一条会话就生效）；
	 * dsh 吃不到它 —— 它只能靠进程级 patch，启动时定型（见 dsh-prompt-patch.ts）。
	 */
	thinkCount?: () => number;
	/** pi 的告警同时要进日志（引擎层的 notify 不带 logger） */
	onLog?: (text: string) => void;
	/**
	 * codex 的 app-server 客户端（与会话清单提供者共享同一个进程）；不给就不注册 codex。
	 *
	 * `subagentPolicy`：宿主从模板库读出来的子代理策略。codex 的委派是它自己发起的
	 * （spawn_agent 那套），我们能做的是「把模板按会话注入 + 把运行显示出来 + 允许停掉」。
	 */
	codex?: { client: CodexClient; bin?: string; description?: string; subagentPolicy?: () => CodexSubagentPolicy };
	/** dsh 的 ACP 客户端；不给就不注册 dsh */
	dsh?: { client: DshClient; bin?: string; model?: string | null; description?: string };
	/** opencode 的 ACP 客户端；不给就不注册 opencode */
	opencode?: { client: OpencodeClient; bin?: string; args?: string[]; model?: string | null; description?: string };
	/** Claude Code 的 ACP 客户端（claude-code-acp）；不给就不注册 claude */
	claude?: { client: ClaudeClient; bin?: string; args?: string[]; model?: string | null; description?: string };
}): EngineRegistry {
	return createEngineRegistry([
		{
			name: "pi",
			label: "pi 原生引擎",
			badge: "PI",
			description: "完整插件与技能生态、工具延迟加载、审批门禁、目标模式与子代理",
			providerConfig: true, // 模型 / provider 配置由本工作台管理（models-store.json + auth.json）
			// 版本同步就有（SDK 导出的 VERSION），不用探测
			version: () => piSdkVersion(),
			capabilities: PI_CAPABILITIES,
			create: () =>
				createPiSdkEngine({
					onNotice: (text, level) => {
						options.onLog?.(text);
						options.onNotice(text, level);
					},
					...(options.skillPaths ? { skillPaths: options.skillPaths } : {}),
					...(options.thinkCount ? { thinkCount: options.thinkCount } : {}),
				}),
		},
		...(options.codex
			? [
					{
						name: "codex",
						label: "Codex",
						badge: "CODEX",
						// 能力如实写：审批是命令/文件级的（比 pi 粗一档），没有 provider 面板
						description:
							options.codex.description ?? "codex 官方 agent：独立 loop 与沙箱，会话与 Codex Desktop / CLI 共用",
						providerConfig: false,
						// 版本号跟本机的 codex CLI 走（`codex --version` → `codex-cli 0.162.1`）
						version: () => probeCliVersion(options.codex?.bin ?? "codex"),
						// steer: false —— 底层（JSON-RPC / ACP）没有「插进正在跑的这一轮」的语义，宿主会降级成排队
						capabilities: {
							approvals: true,
							tools: true,
							modelSwitch: true,
							thinkingLevel: true,
							resume: true,
							steer: false,
							// 真回合探针：临时 thread 发一句 ping，量 TTFT / 出字速度（不偷 codex 的凭证，见 port.ts）
							modelProbe: true,
							// codex 自带多代理（spawn_agent 那一套）：显示成面板卡片 + 按会话注入模板
							subagents: true,
							// 它的隔离是「沙箱 + 审批」，不是逐工具白名单 → 模板里的工具勾选对 codex 不生效
							subagentToolWhitelist: false,
						},
						create: () =>
							createCodexEngine({
								client: options.codex?.client,
								log: options.onLog,
								...(options.codex?.subagentPolicy ? { subagentPolicy: options.codex.subagentPolicy } : {}),
								...(options.thinkCount ? { thinkCount: options.thinkCount } : {}),
							}),
					},
				]
			: []),
		...(options.dsh
			? [
					{
						name: "dsh",
						label: "DeepSeek Harness",
						badge: "DSH",
						description:
							options.dsh.description ??
							"DeepSeek 官方 agent（ACP）：模型与思考档可切、权限逐次确认，会话与 dsh web/tui 共用",
						providerConfig: false,
						// 版本号跟本机的 dsh CLI 走（`dsh --version` → `0.2.0-rc.2`）
						version: () => probeCliVersion(options.dsh?.bin ?? "dsh"),
						// steer: false —— 底层（JSON-RPC / ACP）没有「插进正在跑的这一轮」的语义，宿主会降级成排队
						capabilities: {
							approvals: true,
							tools: true,
							modelSwitch: true,
							thinkingLevel: true,
							resume: true,
							steer: false,
						},
						create: () =>
							createDshEngine({ client: options.dsh?.client, model: options.dsh?.model, log: options.onLog }),
					},
				]
			: []),
		...(options.opencode
			? [
					{
						name: "opencode",
						label: "opencode",
						badge: "OC",
						// 如实写：审批能不能真的拦住，取决于 opencode 自己的权限配置（见 engine/opencode.ts 头注释）
						description:
							options.opencode.description ??
							"opencode 官方 agent（ACP）：自带工具与 MCP/插件生态，模型与思考档可切，会话与 opencode CLI / TUI 共用；审批取决于 opencode 自身 permission 配置",
						providerConfig: false,
						// 版本号跟本机的 opencode CLI 走（`opencode --version` → `1.19.0`）
						version: () => probeCliVersion(options.opencode?.bin ?? "opencode"),
						// 没有子代理面板（ACP 不暴露 task 子代理的运行视图）→ subagents 不写，界面就不出现那块
						// steer: false —— 底层（JSON-RPC / ACP）没有「插进正在跑的这一轮」的语义，宿主会降级成排队
						capabilities: {
							approvals: true,
							tools: true,
							modelSwitch: true,
							thinkingLevel: true,
							resume: true,
							steer: false,
						},
						create: () =>
							createOpencodeEngine({
								client: options.opencode?.client,
								bin: options.opencode?.bin,
								args: options.opencode?.args,
								model: options.opencode?.model,
								log: options.onLog,
							}),
					},
				]
			: []),
		...(options.claude
			? [
					{
						name: "claude",
						label: "Claude Code",
						// 短标签沿用 DSH / OC 的风格：长名字会把顶栏那枚胶囊撑开
						badge: "CC",
						// 能力如实写：模型可切（session/set_model），**没有思考档**（协议不暴露），没有子代理面板
						description:
							options.claude.description ??
							"Claude Code（ACP）：Anthropic 官方 agent，模型可切、工具逐次确认，会话与 claude CLI 共用；思考档与子代理面板不暴露",
						providerConfig: false,
						// 版本 = ACP 适配器（claude-code-acp）的版本，与握手给的 "agentInfo.version" 一致
						version: () => claudeVersionOf(options.claude?.bin),
						// steer: false —— 底层（JSON-RPC / ACP）没有「插进正在跑的这一轮」的语义，宿主会降级成排队
						capabilities: {
							approvals: true,
							tools: true,
							modelSwitch: true,
							thinkingLevel: false, // ACP 面里 Claude 不暴露 thinking/effort
							resume: true,
							steer: false,
						},
						create: () =>
							createClaudeEngine({
								client: options.claude?.client,
								bin: options.claude?.bin,
								args: options.claude?.args,
								model: options.claude?.model,
								log: options.onLog,
							}),
					},
				]
			: []),
		{
			name: "fake",
			label: "假引擎",
			badge: "FAKE",
			description: "零 token 的脚本化引擎：没有真实模型，只用来验证协议、工具与审批流程",
			providerConfig: false,
			version: () => "fake",
			hidden: true, // 测试引擎：AGENT_WEB_ENGINE=fake 仍可选，但不进普通用户的切换面板
			capabilities: FAKE_CAPABILITIES,
			create: () => createFakeEngine(),
		},
	]);
}
