/**
 * 假引擎（ADR-0009 第 2 层的地基）。
 *
 * 它是引擎端口的一份**测试实现**：能脚本化地产生文本流、工具调用、审批请求、慢速输出、
 * 超大输出与错误。有了它，「协议 → 快照 → 会话 → 审批」的全链路可以零 token、零外网、
 * 秒级跑完。
 *
 * ⚠️ 它必须**忠实复现真引擎的生命周期**：`sendMessage` 前没有 `createSession` 就回
 * `engine.no_session`。历史教训：早期版本太宽容（没建会话也能跑），把「重启后旧会话发不出
 * 消息」这个真 bug 藏了整整一个里程碑（见 ADR-0018）。
 *
 * `planFor(text)` 是纯函数；`createFakeEngine` 只负责按计划、
 * 按可配置的延迟把事件吐出来（`chunkDelayMs: 0` 时同步返回）。
 */
import type { ApprovalHandler, EngineEvent, EngineMessage, EnginePort, EngineSessionOptions } from "./port.js";

type FakePlanStep =
	| { kind: "text"; text: string }
	| { kind: "tool"; name: string; argsSummary: string; output: string; exitCode?: number }
	| { kind: "approval"; toolName: string; argsSummary: string; scopeKey: string; scopeHint: string; riskNote: string }
	| { kind: "error"; code: string; message: string };

const BIG_OUTPUT_CHARS = 200 * 1024;

/** 触发词 → 脚本。默认行为：把用户输入原样念一遍，证明「逐字说话」。 */
function planFor(text: string): FakePlanStep[] {
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

	return [
		{ kind: "text", text: `收到：「${text}」。\n这是假引擎在逐字说话：零 token 的测试替身，没有调用任何模型。\n` },
		// 建议操作（ADR-0022）：默认剧本就带上，方便零 token 验证这条链路
		{ kind: "text", text: "\n[[action:suggest:继续]]\n[[action:suggest:总结一下,prompt=用三句话总结刚才的内容]]\n" },
	];
}

type FakeEngineOptions = {
	/** 每个字符块之间的延迟；0 = 同步返回 */
	chunkDelayMs?: number;
	/** 一次吐多少个字符 */
	chunkChars?: number;
	/** slow 模式下的每块延迟 */
	slowChunkDelayMs?: number;
	/** openSession 时假引擎不知道 cwd（真引擎从 header 读）→ 用一个显式回退值 */
	workspaceHint?: string;
};

type FakeEngine = EnginePort & {
	/** 测试钩子：宿主交给引擎的图片 */
	images(): Array<{ data: string; mimeType: string }>;

	/** 测试钩子：会话表（含 createSession 收到的历史与累积转录） */
	sessions(): Map<string, { workspace: string; transcript: EngineMessage[]; sessionPath: string | null }>;
	/** 测试钩子：`switchModel` 的调用记录（断言「新会话用了哪个模型」） */
	switchedModels(): Array<{ sessionId: string; modelId: string }>;
	/** 测试用：清掉所有会话 */
	reset(): void;
};

const sleep = (ms: number) => (ms <= 0 ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, ms)));

export function createFakeEngine(options: FakeEngineOptions = {}): FakeEngine {
	const chunkDelayMs = options.chunkDelayMs ?? 18;
	const chunkChars = options.chunkChars ?? 6;
	const slowChunkDelayMs = options.slowChunkDelayMs ?? 250;

	/** 会话表：**必须先 createSession**，否则 sendMessage 报 engine.no_session（与真引擎一致） */
	const sessions = new Map<string, { workspace: string; transcript: EngineMessage[]; sessionPath: string | null }>();
	const interrupted = new Set<string>();
	/** 假引擎自己的模型状态（只为了让 switchModel 有地方记） */
	const models = new Map<string, string>();
	/** 测试钩子：宿主交给引擎的图片（ADR-0020 §P3） */
	const receivedImages: Array<{ data: string; mimeType: string }> = [];
	/** switchModel 的调用记录：断言「新会话按项目的默认模型起步」 */
	const switchedModels: Array<{ sessionId: string; modelId: string }> = [];
	let approvalHandler: ApprovalHandler | null = null;
	let toolCallSeq = 0;
	/** 派生会话的 id 序号（真引擎是 pi 的 `createSessionId()`，同样不复用传进来的 id） */
	let forkSeq = 0;

	async function streamText(
		sessionId: string,
		text: string,
		onEvent: (event: EngineEvent) => void,
		slow: boolean,
	): Promise<boolean> {
		const buffer = sessions.get(sessionId)?.transcript;
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
		version: () => "fake",
		async createSession(sessionOptions: EngineSessionOptions) {
			const ephemeral = sessionOptions.ephemeral === true;
			/** 派生：把源会话的转录拄过来（按 `fake-<会话>-<序号>` 里的序号截断） */
			let transcript: EngineMessage[] = [];
			if (sessionOptions.fork) {
				const source = sessions.get(sessionOptions.fork.sourceSessionId);
				// 与真引擎一致：没落盘的会话不能 fork
				if (!source?.sessionPath) throw new Error("这条会话还没存过盘（临时对话），不能从它派生分支");
				const cut = Number(/-(\d+)$/.exec(sessionOptions.fork.leafId)?.[1] ?? Number.NaN);
				transcript = Number.isFinite(cut) ? source.transcript.slice(0, cut + 1) : [...source.transcript];
				// 与真引擎一致（pi 的 `createBranchedSession`）：派生会**另生一个会话 id**，
				// 不采纳传进来的那个。宿主必须拿回报的 id 当会话 id，否则发消息就会
				// `engine.no_session`（引擎表里只有新 id）—— 这里必须忠实复现，不然测试盖不住。
				forkSeq += 1;
				const forkedId = `forked-${forkSeq}`;
				const forkedPath = `fake-sessions/${forkedId}.jsonl`;
				sessions.set(forkedId, { workspace: sessionOptions.workspace, transcript, sessionPath: forkedPath });
				return { sessionPath: forkedPath, sessionId: forkedId };
			}
			// 临时会话没有会话文件（与 pi 的 `--no-session` 一致）
			const sessionPath = ephemeral ? null : `fake-sessions/${sessionOptions.sessionId}.jsonl`;
			sessions.set(sessionOptions.sessionId, { workspace: sessionOptions.workspace, transcript, sessionPath });
			return { sessionPath };
		},

		/** 临时会话转正：给它一个文件路径（真引擎是原生导出写盘） */
		async persistSession(sessionId: string) {
			const session = sessions.get(sessionId);
			if (!session) return { sessionPath: null };
			if (session.sessionPath) return { sessionPath: session.sessionPath };
			if (session.transcript.length === 0) return { sessionPath: null };
			session.sessionPath = `fake-sessions/${sessionId}.jsonl`;
			return { sessionPath: session.sessionPath };
		},

		/** 打开已有会话（ADR-0021 §2）：假引擎没有真文件，只登记「已打开」 */
		async openSession(openOptions) {
			if (!sessions.has(openOptions.sessionId)) {
				sessions.set(openOptions.sessionId, {
					workspace: options.workspaceHint ?? "/tmp/agent-web-fake",
					transcript: [],
					sessionPath: openOptions.sessionPath ?? null,
				});
			}
		},

		async readUiMessages(sessionId: string) {
			const session = sessions.get(sessionId);
			if (!session) return [];
			return session.transcript.map((message, index) => ({
				id: `fake-${sessionId}-${index}`,
				role: message.role,
				ts: message.ts,
				blocks: [{ kind: "text" as const, text: message.text }],
			}));
		},

		async sendMessage(
			sessionId: string,
			text: string,
			onEvent,
			messageOptions?: { images?: Array<{ data: string; mimeType: string }> },
		) {
			// 记下宿主交给引擎的图片（测试用；ADR-0020 §P3 的视觉注入）
			if (messageOptions?.images?.length) receivedImages.push(...messageOptions.images);
			// 生命周期忠实于真引擎：**没有 createSession 就没有会话**（ADR-0018）
			const session = sessions.get(sessionId);
			if (!session) {
				onEvent({ type: "error", code: "engine.no_session", message: `引擎里没有这个会话：${sessionId}` });
				onEvent({ type: "turn_end", reason: "error" });
				return;
			}
			const transcript = session.transcript;
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

		async listModels() {
			// 假引擎固定给两个模型（零 token 也能验证「选模型」这条链路）
			return [
				{ id: "fake/alpha", label: "Fake Alpha", current: true },
				{ id: "fake/beta", label: "Fake Beta", current: false },
			];
		},

		async switchModel(sessionId: string, modelId: string) {
			models.set("current", modelId);
			switchedModels.push({ sessionId, modelId });
			return true;
		},

		async closeSession(sessionId: string) {
			sessions.delete(sessionId);
		},

		async interrupt(sessionId: string) {
			interrupted.add(sessionId);
		},

		async readTranscript(sessionId: string) {
			return [...(sessions.get(sessionId)?.transcript ?? [])];
		},

		setApprovalHandler(handler: ApprovalHandler) {
			approvalHandler = handler;
		},

		/** 测试钩子：宿主交给引擎的图片（ADR-0020 §P3） */
		images() {
			return receivedImages;
		},

		/** 测试钩子：看会话表（含 createSession 时收到的历史） */
		sessions() {
			return sessions;
		},

		switchedModels: () => [...switchedModels],

		reset() {
			sessions.clear();
			interrupted.clear();
			approvalHandler = null;
			switchedModels.length = 0;
		},
	};
}
