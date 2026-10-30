/**
 * 给**父会话**注册的 `Agent` 工具（子代理的入口）。
 *
 * 为什么放在引擎层：工具是 SDK 的扩展点（`pi.registerTool`），只有引擎能碰。
 * 这个文件只做三件事：
 *   1. 把「有哪些模板」写进工具描述（模型据此选 `subagent_type`）；
 *   2. 调子代理运行时起一个子会话（`SubagentEnginePort.start`）；
 *   3. 前台调用等它跑完，把结果文本还给模型 —— 后台调用立刻返回，跑完进面板。
 *
 * 纪律：这个工具**不给子会话**（子代理不能再开子代理），否则一次委派能无限展开。
 */
import { Type } from "@earendil-works/pi-ai";
import { defineTool, type InlineExtension } from "@earendil-works/pi-coding-agent";
import type { SubagentEnginePort } from "./port.js";
import type { SubagentRunView } from "../protocol.js";
import { enabledSubagentSpecs, readSubagentSettings } from "../subagents/profile-store.js";

const TERMINAL = new Set(["completed", "failed", "aborted"]);
/** 前台等待上限：子代理是长任务，但不能让工具永远不返回（40 分钟） */
const WAIT_TIMEOUT_MS = 40 * 60_000;

type SubagentToolOptions = {
	port: SubagentEnginePort;
	agentDir: string;
	/** 归属的宿主会话 id（面板按它分组） */
	conversationId: string;
	workspace: string;
	/** 父会话文件路径：子会话按它归档（懒读：建会话时才知道） */
	parentSessionPath: () => string | null;
};

function describeProfiles(options: SubagentToolOptions): string {
	const profiles = enabledSubagentSpecs(options.agentDir);
	if (profiles.length === 0) return "No subagent profiles are enabled.";
	return profiles
		.map((profile) => {
			const tools = profile.tools.length > 0 ? profile.tools.join(", ") : "none";
			const details = [`tools: ${tools}`];
			if (profile.model) details.push(`model: ${profile.model}`);
			if (profile.thinking) details.push(`thinking: ${profile.thinking}`);
			return `- ${profile.id}: ${profile.description || profile.label} (${details.join("; ")})`;
		})
		.join("\n");
}

function resultText(run: SubagentRunView): string {
	const head = `${run.label} · ${run.status}`;
	const body = run.result?.trim();
	if (run.status === "completed") return body ? `${head}\n\n${body}` : `${head}（没有文本输出）`;
	if (run.status === "aborted") return `${head}（已停止）${body ? `\n\n${body}` : ""}`;
	return `${head}：${run.error ?? "未知错误"}${body ? `\n\n${body}` : ""}`;
}

/**
 * 等这个运行进入终态；返回最后一次看到的记录。
 *
 * 导出是为了能单独调：这里有一个「先查再订阅」的竞态，
 * 只有把函数单独拿出来才能构造出那个窗口。
 */
export function waitForRun(port: SubagentEnginePort, id: string, timeoutMs: number): Promise<SubagentRunView | null> {
	// 极快的任务可能在 start() 返回前就结束了：先看一眼，再订阅
	const current = port.get(id);
	if (current && TERMINAL.has(current.status)) return Promise.resolve(current);
	return new Promise((resolve) => {
		let last: SubagentRunView | null = current;
		let settled = false;
		let timer: ReturnType<typeof setTimeout> | null = null;
		let off = (): void => {};
		const finish = (run: SubagentRunView | null): void => {
			if (settled) return;
			settled = true;
			if (timer) clearTimeout(timer);
			off();
			resolve(run);
		};
		timer = setTimeout(() => finish(last), timeoutMs);
		off = port.subscribe((run) => {
			if (run.id !== id) return;
			last = run;
			if (!TERMINAL.has(run.status)) return;
			finish(run);
		});
		/**
		 * 订阅之后再补查一次。
		 *
		 * `port.subscribe` **只推后续事件、不回放当前状态**，所以上面那次 `get()` 与订阅之间
		 * 如果刚好跃迁到终态，那一推就永远收不到 —— 工具会一直等到 timeoutMs（默认 40 分钟）
		 * 才返回「一直没有结束」，父回合也就一直挂在「进行中」。补这一次查询把窗口关掉。
		 */
		const after = port.get(id);
		if (after) last = after;
		if (after && TERMINAL.has(after.status)) finish(after);
	});
}

export function makeSubagentToolExtension(options: SubagentToolOptions): InlineExtension {
	return {
		name: "agent-web-subagents",
		hidden: true,
		factory: (pi) => {
			const settings = readSubagentSettings(options.agentDir);
			if (!settings.enabled) return;
			const profiles = enabledSubagentSpecs(options.agentDir);
			if (profiles.length === 0) return;
			const available = profiles.map((profile) => profile.id).join(", ");
			pi.registerTool(
				defineTool({
					name: "Agent",
					label: "Agent",
					description: `Delegate a focused task to a subagent. Each subagent runs as a full Pi session with its own context and tool allowlist; it shows up in the workspace's Agents panel where the user can watch or stop it.\n\nAvailable subagent types:\n${describeProfiles(options)}`,
					promptSnippet: "Delegate a task to a subagent session (several calls in one reply run in parallel)",
					promptGuidelines: [
						"Use Agent for a focused task that benefits from an isolated context.",
						"For independent parts of one task, send several Agent calls in the SAME reply so they run in parallel.",
						"Do not duplicate work already delegated to a running subagent.",
						"If an Agent call fails, report the error text; do not claim you lack the ability to spawn subagents.",
					],
					executionMode: "parallel",
					parameters: Type.Object({
						subagent_type: Type.String({
							description: `Subagent type. One of: ${available}. Default: general-purpose.`,
						}),
						prompt: Type.String({ description: "The complete task for the subagent." }),
						description: Type.String({ description: "Short activity label shown in the Agents panel." }),
						run_in_background: Type.Optional(
							Type.Boolean({
								description: "Return as soon as the subagent starts; its result only appears in the Agents panel.",
							}),
						),
					}),
					async execute(_toolCallId, params) {
						const profileId = params.subagent_type?.trim() || "general-purpose";
						const profile = profiles.find((item) => item.id === profileId);
						if (!profile) {
							return {
								content: [{ type: "text", text: `未知的子代理类型 ${profileId}（可用：${available}）` }],
								details: undefined,
								isError: true,
							};
						}
						try {
							const { id } = await options.port.start({
								conversationId: options.conversationId,
								workspace: options.workspace,
								parentSessionPath: options.parentSessionPath(),
								profile: {
									id: profile.id,
									label: profile.label,
									systemPrompt: profile.systemPrompt,
									tools: profile.tools,
									...(profile.model ? { model: profile.model } : {}),
									...(profile.thinking ? { thinking: profile.thinking } : {}),
									...(profile.maxTurns ? { maxTurns: profile.maxTurns } : {}),
								},
								description: params.description || profile.label,
								task: params.prompt,
							});
							if (params.run_in_background) {
								return {
									content: [
										{
											type: "text",
											text: `子代理已启动：${id}（${profile.label}）。它跑完后会出现在 Agents 面板里，不会自动把结果送到这里。`,
										},
									],
									details: undefined,
								};
							}
							const run = await waitForRun(options.port, id, WAIT_TIMEOUT_MS);
							if (!run) {
								return {
									content: [{ type: "text", text: `子代理 ${id} 一直没有结束（看 Agents 面板）。` }],
									details: undefined,
									isError: true,
								};
							}
							return {
								content: [{ type: "text", text: resultText(run) }],
								details: undefined,
								...(run.status === "failed" ? { isError: true } : {}),
							};
						} catch (error) {
							return {
								content: [{ type: "text", text: error instanceof Error ? error.message : String(error) }],
								details: undefined,
								isError: true,
							};
						}
					},
				}),
			);
		},
	};
}
