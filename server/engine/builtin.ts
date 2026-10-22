/**
 * 内置引擎注册（进程启动时装配一次）。
 *
 * 从 index.ts 搬出来（ADR-0010 的 400 行护栏）：这里是**唯一**知道「有哪些引擎、
 * 各自怎么造、界面怎么描述」的地方，index 只需要拿注册表 + 目录。
 *
 * 加一个引擎的完整动作仍然是：写 `server/engine/<name>.ts` + 在这个数组里加一项
 * （ADR-0024 §1）；前端不需要改 —— 切换面板读的是注册表。
 */
import type { CodexClient } from "./codex-transport.js";
import { createCodexEngine } from "./codex.js";
import type { DshClient } from "./dsh-transport.js";
import { createDshEngine } from "./dsh.js";
import { createFakeEngine } from "./fake.js";
import { createPiSdkEngine } from "./pi-sdk.js";
import { createEngineRegistry, FAKE_CAPABILITIES, PI_CAPABILITIES, type EngineRegistry } from "./registry.js";

export function createBuiltinEngineRegistry(options: {
	/** 引擎自己发的运行期提示（pi 的 SDK 会发）：转给界面 */
	onNotice: (text: string, level?: "info" | "warn" | "error") => void;
	/** pi 的告警同时要进日志（引擎层的 notify 不带 logger） */
	onLog?: (text: string) => void;
	/** codex 的 app-server 客户端（与会话清单提供者共享同一个进程）；不给就不注册 codex */
	codex?: { client: CodexClient; description?: string };
	/** dsh 的 ACP 客户端；不给就不注册 dsh */
	dsh?: { client: DshClient; model?: string | null; description?: string };
}): EngineRegistry {
	return createEngineRegistry([
		{
			name: "pi",
			label: "pi 原生引擎",
			badge: "PI",
			description: "完整插件与技能生态、工具延迟加载、审批门禁、目标模式与子代理",
			providerConfig: true, // 模型 / provider 配置由本工作台管理（models-store.json + auth.json）
			capabilities: PI_CAPABILITIES,
			create: () =>
				createPiSdkEngine({
					onNotice: (text, level) => {
						options.onLog?.(text);
						options.onNotice(text, level);
					},
				}),
		},
		...(options.codex
			? [
					{
						name: "codex",
						label: "Codex",
						badge: "CODEX",
						// 能力如实写：审批是命令/文件级的（比 pi 粗一档），没有 provider 面板
						description: options.codex.description ?? "codex 官方 agent：独立 loop 与沙箱，会话与 Codex Desktop / CLI 共用",
						providerConfig: false,
						capabilities: { approvals: true, tools: true, modelSwitch: true, thinkingLevel: true, resume: true },
						create: () => createCodexEngine({ client: options.codex?.client, log: options.onLog }),
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
						capabilities: { approvals: true, tools: true, modelSwitch: true, thinkingLevel: true, resume: true },
						create: () => createDshEngine({ client: options.dsh?.client, model: options.dsh?.model, log: options.onLog }),
					},
				]
			: []),
		{
			name: "fake",
			label: "假引擎",
			badge: "FAKE",
			description: "零 token 的脚本化引擎：没有真实模型，只用来验证协议、工具与审批流程",
			providerConfig: false,
			hidden: true, // 测试引擎：AGENT_WEB_ENGINE=fake 仍可选，但不进普通用户的切换面板
			capabilities: FAKE_CAPABILITIES,
			create: () => createFakeEngine(),
		},
	]);
}
