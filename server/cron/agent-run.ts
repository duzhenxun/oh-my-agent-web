/**
 * cron 的「agent 任务」：在指定工作区**真开一个会话**跑一遍提示词。
 *
 * 与「文本任务」的区别（`completeOnce`）：
 *   - 文本任务：直连模型，无工具、不读文件、不能改仓库 —— 便宜、可预测，适合生成文案；
 *   - agent 任务：走当前引擎的完整回合，能读文件、跑命令、改代码 —— 这才是「让它干活」。
 *
 * 无人值守的三条底线：
 *   1. **默认拒绝写操作**：把会话登记成 `deny-writes`，审批请求直接被拒（见 `approval/unattended.ts`），
 *      不会挂在一个没人的弹窗上等超时；要写入必须在任务上显式勾选；
 *   2. **超时即中断**：默认 20 分钟（与回合看门狗同量级），到点 `interrupt`，绝不无限占用引擎；
 *   3. **被中断就如实失败**：不把半截输出当成成功结果写进运行记录。
 *
 * 这个模块不做 IO、不认识 HTTP：所有能力由调用方注入，便于用假 runtime 单测。
 */
import type { UiMessage } from "../protocol.js";
import { clearUnattendedPolicy, setUnattendedPolicy } from "../approval/unattended.js";

/** 运行记录里保留的结果上限：太长会把 cron.json 撑大，界面上也没人看 */
const MAX_RESULT_CHARS = 4000;
const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000;

export type AgentRunInput = {
	prompt: string;
	workspace: string;
	/** true = 允许 agent 改动工作区（仍需用户在任务上显式开启） */
	allowWrites: boolean;
	/** cron 服务停机时中止 */
	signal: AbortSignal;
	timeoutMs?: number;
	/** 续跑已有会话（空 = 新开一个） */
	sessionId?: string;
	/** 指定模型（空 = 新建跟随默认、续跑沿用原模型） */
	model?: string;
};

export type AgentRunnerDeps = {
	newConversation: (
		workspace: string,
	) => Promise<{ ok: true; conversationId: string } | { ok: false; error: { message: string } }>;
	setApprovalMode: (mode: "ask" | "allow", conversationId: string) => void;
	/** 读当前审批模式（续跑时要还原，别把用户的会话永久改成问/不问） */
	getApprovalMode: (conversationId: string) => "ask" | "allow";
	/** 会话是否还在（用户可能已经删了；历史清单里的也算在） */
	conversationExists: (conversationId: string) => boolean;
	/** 打开会话（历史会话也行）：切模型前必须先开，否则引擎拿不到会话句柄 */
	openConversation: (conversationId: string) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
	/** 会话是否正在跑回合（正在跑就跳过这一轮，别打断用户手上的活） */
	conversationBusy: (conversationId: string) => boolean;
	/** 切模型（可选能力：引擎不支持时返回错误，不假装成功） */
	setModel: (
		model: string,
		conversationId: string,
	) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
	sendMessage: (
		text: string,
		conversationId: string,
	) => Promise<{ ok: true } | { ok: false; error: { message: string } }>;
	interrupt: (conversationId: string) => Promise<unknown>;
	/** 某个会话当前的 UI 消息（取最后一条 assistant 的正文作为结果） */
	messages: (conversationId: string) => UiMessage[];
	/** 订阅「回合结束」，返回取消订阅函数（必须在发消息**之前**挂上） */
	subscribeTurnEnd: (
		listener: (info: { conversationId: string; failed: boolean; interrupted: boolean }) => void,
	) => () => void;
};

/** 把最后一条 assistant 消息的正文拼出来；没有正文就退回到所有 assistant 文本 */
export function finalAssistantText(messages: UiMessage[]): string {
	const assistants = messages.filter((message) => message.role === "assistant");
	const texts = (list: UiMessage[]): string =>
		list
			.map((message) =>
				message.blocks
					.filter((block) => block.kind === "text")
					.map((block) => block.text)
					.join("\n"),
			)
			.map((text) => text.trim())
			.filter((text) => text !== "")
			.join("\n\n");
	const last = texts(assistants.slice(-1));
	return last !== "" ? last : texts(assistants);
}

function truncate(text: string): string {
	if (text.length <= MAX_RESULT_CHARS) return text;
	return `${text.slice(0, MAX_RESULT_CHARS)}\n\n…（结果过长，已截断 ${text.length - MAX_RESULT_CHARS} 字）`;
}

export function createAgentRunner(deps: AgentRunnerDeps) {
	return async (input: AgentRunInput): Promise<string> => {
		const resumeId = input.sessionId?.trim() ?? "";
		let conversationId: string;
		if (resumeId !== "") {
			if (!deps.conversationExists(resumeId)) throw new Error(`指定的会话不存在（可能已被删除）：${resumeId}`);
			if (deps.conversationBusy(resumeId)) throw new Error("指定的会话正在运行，本轮跳过");
			conversationId = resumeId;
		} else {
			const created = await deps.newConversation(input.workspace);
			if (!created.ok) throw new Error(`新建会话失败：${created.error.message}`);
			conversationId = created.conversationId;
		}

		const model = input.model?.trim() ?? "";
		if (model !== "") {
			// 续跑历史会话时它可能还没被打开：先打开再切模型，否则引擎拿不到句柄、切模型必然失败
			const opened = await deps.openConversation(conversationId);
			if (!opened.ok) throw new Error(`打开会话失败：${opened.error.message}`);
			const switched = await deps.setModel(model, conversationId);
			if (!switched.ok) throw new Error(`切换模型失败：${switched.error.message}`);
		}

		// 默认只读：需要审批的操作由 unattended 策略直接拒绝；勾了写入才整体放行
		setUnattendedPolicy(conversationId, input.allowWrites ? "allow" : "deny-writes");
		// 续跑时必须记住原来的模式：跑完还原，不能把用户自己的会话永久改成 ask/allow
		const previousMode = deps.getApprovalMode(conversationId);
		deps.setApprovalMode(input.allowWrites ? "allow" : "ask", conversationId);

		let unsubscribe: (() => void) | undefined;
		/** 看门狗与停机监听器都在 finally 里收掉：发送失败这类提前抛出也必须清，否则定时器要挂 20 分钟 */
		let timeoutTimer: ReturnType<typeof setTimeout> | undefined;
		let onAbort: (() => void) | undefined;
		try {
			let settled = false;
			const ended = new Promise<{ failed: boolean; interrupted: boolean }>((resolve) => {
				unsubscribe = deps.subscribeTurnEnd((info) => {
					if (info.conversationId !== conversationId || settled) return;
					settled = true;
					resolve({ failed: info.failed, interrupted: info.interrupted });
				});
			});
			const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
			/*
			 * 超时定时器：**不用 unref**，而是结算后 clearTimeout。
			 * unref 看似更省事，但「唯一还活着的句柄就是这个定时器」时事件循环会先空掉、
			 * 定时器永远不触发 —— 表现为任务卡在 running（单测里当场复现过）。
			 * 注意它建在 `sendMessage` 之前：发送本身也可能卡死，所以它要一起兜住。
			 */
			const timeout = new Promise<{ timeout: true }>((resolve) => {
				timeoutTimer = setTimeout(() => resolve({ timeout: true }), timeoutMs);
			});
			const aborted = new Promise<{ aborted: true }>((resolve) => {
				if (input.signal.aborted) {
					resolve({ aborted: true });
					return;
				}
				onAbort = () => resolve({ aborted: true });
				input.signal.addEventListener("abort", onAbort, { once: true });
			});

			const sent = await deps.sendMessage(input.prompt, conversationId);
			if (!sent.ok) throw new Error(`发送失败：${sent.error.message}`);

			const outcome = await Promise.race([ended, timeout, aborted]);
			if ("timeout" in outcome) {
				await deps.interrupt(conversationId).catch(() => undefined);
				throw new Error(`运行超过 ${Math.round(timeoutMs / 60000)} 分钟，已中断`);
			}
			if ("aborted" in outcome) {
				await deps.interrupt(conversationId).catch(() => undefined);
				throw new Error("服务正在停止，运行已中断");
			}
			if (outcome.interrupted) throw new Error("运行被中断");
			if (outcome.failed) {
				const text = finalAssistantText(deps.messages(conversationId));
				throw new Error(text.trim() !== "" ? `运行失败：${text.slice(0, 500)}` : "运行失败（引擎未给出原因）");
			}
			const text = finalAssistantText(deps.messages(conversationId));
			if (text.trim() === "") throw new Error("运行结束但没有产出正文");
			return truncate(text);
		} finally {
			if (timeoutTimer) clearTimeout(timeoutTimer);
			if (onAbort) input.signal.removeEventListener("abort", onAbort);
			unsubscribe?.();
			clearUnattendedPolicy(conversationId);
			deps.setApprovalMode(previousMode, conversationId);
		}
	};
}
