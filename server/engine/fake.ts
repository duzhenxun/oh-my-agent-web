/**
 * 假引擎（ADR-0009 第 2 层的地基）。
 *
 * 它是引擎端口的一份**测试实现**：能脚本化地产生文本流、工具调用、审批请求、慢速输出、
 * 超大输出与错误。有了它，「协议 → 快照 → 会话 → 审批」的全链路可以零 token、零外网、
 * 秒级跑完 —— 这是参考实现没有的便宜。
 *
 * `planFor(text)` 是纯函数（单测直接覆盖）；`createFakeEngine` 只负责按计划、
 * 按可配置的延迟把事件吐出来（`chunkDelayMs: 0` 时同步返回，便于单测）。
 */
import type { ApprovalHandler, EngineEvent, EngineMessage, EnginePort, EngineSessionOptions } from "./port.js";

export type FakePlanStep =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; argsSummary: string; output: string; exitCode?: number }
	| { kind: "approval"; toolName: string; argsSummary: string; scopeKey: string; scopeHint: string; riskNote: string }
	| { kind: "error"; code: string; message: string };

const BIG_OUTPUT_CHARS = 200 * 1024;

/** 触发词 → 脚本。默认行为：把用户输入原样念一遍，证明「逐字说话」。 */
export function planFor(text: string): FakePlanStep[] {
	const key = text.toLowerCase();

	if (key.includes("boom")) {
		return [
			{ kind: "text", text: "好，我准备炸一下试试：\n" },
			{ kind: "error", code: "fake.boom", message: "假引擎按剧本报错了" },
		];
	}

	if (key.includes("approve")) {
		return [
			{ kind: "text", text: "这一步要写文件，按规矩先问你一下：\n" },
			{
				kind: "approval",
				toolName: "write_file",
				argsSummary: 'path="docs/notes.md", bytes=128',
				scopeKey: "write_file|/Users/me/code/agent-web/docs",
				scopeHint: "目录 /Users/me/code/agent-web/docs",
				riskNote: "写文件会改动磁盘内容，确认后才能执行",
			},
			{ kind: "text", text: "（按你的决定，我要么继续、要么收手。）\n" },
		];
	}

	if (key.includes("huge")) {
		return [
			{ kind: "text", text: "准备吐一大坨输出，看看截断提示对不对：\n" },
			{
				kind: "tool",
				name: "run_command",
				argsSummary: "cat very-big.log",
				output: "x".repeat(BIG_OUTPUT_CHARS),
			},
			{ kind: "text", text: "上面这段应该被截断了。\n" },
		];
	}

	if (key.includes("fail")) {
		return [
			{ kind: "text", text: "跑一下测试：\n" },
			{
				kind: "tool",
				name: "run_command",
				argsSummary: "npm test",
				output: "1 test failed: 期望 42 实际 43\n",
				exitCode: 1,
			},
			{ kind: "text", text: "失败了，退出码 1。\n" },
		];
	}

	if (key.includes("tool")) {
		return [
			{ kind: "text", text: "我先看一下这个文件：\n" },
			{ kind: "tool", name: "read_file", argsSummary: 'path="server/index.ts"', output: "export const x = 1;\n" },
			{ kind: "text", text: "看完了。\n" },
		];
	}

	if (key.includes("slow")) {
		const chunks = Array.from({ length: 40 }, (_, i) => `第 ${i + 1} 块 … `);
		return [{ kind: "text", text: "慢慢说：\n" }, ...chunks.map((chunk) => ({ kind: "text" as const, text: chunk }))];
	}

	return [{ kind: "text", text: `收到：「${text}」。\n这是假引擎（M1）在逐字说话，没有调用任何模型。\n` }];
}

export type FakeEngineOptions = {
	/** 每个字符块之间的延迟；单测传 0 */
	chunkDelayMs?: number;
	/** 一次吐多少个字符 */
	chunkChars?: number;
	/** slow 模式下的每块延迟 */
	slowChunkDelayMs?: number;
};

export type FakeEngine = EnginePort & {
	/** 测试用：读出累积的转录 */
	transcripts(): Map<string, EngineMessage[]>;
	/** 测试用：清掉所有会话 */
	reset(): void;
};

const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
	const chunkDelayMs = options.chunkDelayMs ?? 18;
	const chunkChars = options.chunkChars ?? 6;
	const slowChunkDelayMs = options.slowChunkDelayMs ?? 250;

	const transcripts = new Map<string, EngineMessage[]>();
	const interrupted = new Set<string>();
	let approvalHandler: ApprovalHandler | null = null;
	let toolCallSeq = 0;

	async function streamText(
		sessionId: string,
		text: string,
		onEvent: (event: EngineEvent) => void,
		slow: boolean,
	): Promise<boolean> {
		const buffer = transcripts.get(sessionId);
		for (let index = 0; index < text.length; index += chunkChars) {
			if (interrupted.has(sessionId)) return false;
			const chunk = text.slice(index, index + chunkChars);
			onEvent({ type: "text_delta", text: chunk });
			buffer?.push({ role: "assistant", text: chunk, ts: Date.now() });
			await sleep(slow ? slowChunkDelayMs : chunkDelayMs);
		}
		return true;
	}

	return {
		async createSession(sessionOptions: EngineSessionOptions) {
			transcripts.set(sessionOptions.sessionId, []);
		},

		async sendMessage(sessionId: string, text: string, onEvent) {
			const transcript = transcripts.get(sessionId) ?? [];
			transcripts.set(sessionId, transcript);
			transcript.push({ role: "user", text, ts: Date.now() });

			const slow = text.toLowerCase().includes("slow");

			// 中断标志只在**回合结束时**清理（不能在建回合时清）：
			// 宿主可能在「回合已开跑但还没进到引擎」的窗口里发来中断，那时它必须仍然生效。
			try {
				for (const step of planFor(text)) {
					if (interrupted.has(sessionId)) {
						onEvent({ type: "turn_end", reason: "interrupted" });
						return;
					}

					if (step.kind === "text") {
						if (!(await streamText(sessionId, step.text, onEvent, slow))) {
							onEvent({ type: "turn_end", reason: "interrupted" });
							return;
						}
						continue;
					}

					if (step.kind === "tool") {
						const toolCallId = `fake-tool-${++toolCallSeq}`;
						onEvent({ type: "tool_start", toolCallId, name: step.name, argsSummary: step.argsSummary });
						await sleep(Math.max(chunkDelayMs, 20));
						onEvent({
							type: "tool_end",
							toolCallId,
							status: step.exitCode ? "failed" : "ok",
							output: step.output,
							...(step.exitCode === undefined ? {} : { exitCode: step.exitCode }),
						});
						continue;
					}

					if (step.kind === "error") {
						onEvent({ type: "error", code: step.code, message: step.message });
						onEvent({ type: "turn_end", reason: "error" });
						return;
					}

					// 审批：把决定权交回宿主（ADR-0006）
					const decision = approvalHandler
						? await approvalHandler({
								toolName: step.toolName,
								argsSummary: step.argsSummary,
								scopeKey: step.scopeKey,
								scopeHint: step.scopeHint,
								riskNote: step.riskNote,
							})
						: "deny";
					onEvent({ type: "text_delta", text: `审批结果：${decision}\n` });
				}

				onEvent({ type: "turn_end", reason: "done" });
			} finally {
				interrupted.delete(sessionId);
			}
		},

		async interrupt(sessionId: string) {
			interrupted.add(sessionId);
		},

		async readTranscript(sessionId: string) {
			return [...(transcripts.get(sessionId) ?? [])];
		},

		setApprovalHandler(handler: ApprovalHandler) {
			approvalHandler = handler;
		},

		transcripts() {
			return transcripts;
		},

		reset() {
			transcripts.clear();
			interrupted.clear();
			approvalHandler = null;
		},
	};
}
