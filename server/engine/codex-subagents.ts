/**
 * codex 的原生子代理（multi-agent）→ 工作台面板的**纯映射**（不碰网络/子进程）。
 *
 * 为什么不是「宿主自己起子会话」（pi 那条路）：codex 0.162 自带多代理，模型直接调
 * `spawn_agent / send_message / wait_agent / interrupt_agent / list_agents / close_agent`，
 * 子代理是**另一个 thread**（还能再 spawn，有 depth 上限）。工作台能做的只是
 * 「把它正在干什么显示出来 + 允许停掉 + 把模板翻译成它的配置」，不能重复实现一套。
 *
 * 实测（codex-cli 0.162.1，`features.multi_agent_v2=true`）：
 *   - `thread/start` 收 `config`（按 thread 生效！）与 `developerInstructions`，
 *     所以**模板与并发上限可以只对这条会话生效**，不必改用户全局的 `~/.codex/config.toml`；
 *   - 子代理的动作以两类 thread item 出现（见下面的类型定义）：
 *       `subAgentActivity`      —— started / interacted / interrupted / completed
 *       `collabAgentToolCall`   —— spawnAgent / wait / sendMessage … + `agentsStates`（每个子 thread 的状态）
 *   - 并发上限来自 `agents.max_concurrent_threads_per_session`（实测 2 → 模型被告知 3 个槽位，
 *     即「子代理 2 个 + 自己」）。
 *
 * **为什么默认 v1 而不是 v2**（实测，2026-05，codex-cli 0.162.1 + 自定义 provider 的 deepseek 模型）：
 *   - v2 的 spawn 靠 `message` / `items` 参数把任务带过去，而这几款模型调 `spawn_agent` 时**不带 message**，
 *     v2 于是拉起一个**完全没有内容**的子 thread（它的 turns 里连 userMessage 都没有），子代理只会回
 *     「你想让我做什么？」。同一句提示词在 v1 下子代理能正确拿到任务并干活。
 *   - v2 目前也是 `stable false`（`codex features list`），开了属于赌。
 *   - 代价：v1 没有「按类型挑子代理」（`agent_type`）和槽位提示，所以模板在 v1 里只是**委派说明**
 *     （写进 developer instructions），不是隔离级别 —— 面板上那句提示说的就是这个。
 */
import type { SubagentRunView, SubagentStatus } from "../protocol.js";
import type { SubagentEnginePort, SubagentRequest } from "./port.js";

/** 子代理工具调用（codex 的一项 thread item） */
type CodexCollabItem = {
	type: "collabAgentToolCall";
	id?: string;
	tool?: string;
	status?: "inProgress" | "completed" | "failed" | "interrupted" | string;
	senderThreadId?: string;
	receiverThreadIds?: string[];
	prompt?: string | null;
	model?: string | null;
	reasoningEffort?: string | null;
	agentsStates?: Record<string, { status?: string | null; message?: string | null }>;
};

/** 子代理生命周期事件（codex 的另一项 thread item） */
type CodexSubAgentActivityItem = {
	type: "subAgentActivity";
	id?: string;
	kind?: "started" | "interacted" | "interrupted" | "completed" | string;
	agentThreadId?: string;
	agentPath?: string;
	model?: string | null;
	reasoningEffort?: string | null;
};

type CodexSubagentItem = CodexCollabItem | CodexSubAgentActivityItem;

/** 子代理 thread 的状态（`CollabAgentStatus`）→ 面板的三态 */
function statusOfAgentState(status: string | null | undefined): SubagentStatus | null {
	switch (status) {
		case "running":
		case "pendingInit":
			return "running";
		case "completed":
			return "completed";
		case "interrupted":
		case "shutdown":
			return "aborted";
		case "errored":
			return "failed";
		default:
			return null;
	}
}

/**
 * 模板 id → codex 的 agent 类型名。
 *
 * codex 要求小写字母 / 数字 / 下划线（`spawn_agent` 的 `task_name` 是同一套规则），
 * 我们的模板 id 里带连字符（`general-purpose`），所以映射一次。
 */
function agentTypeId(id: string): string {
	const cleaned = id
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/^_+|_+$/g, "");
	return cleaned === "" ? "subagent" : cleaned;
}

/** `agentPath` 的最后一段就是模型给这次任务起的名字（`/root/directory_inventory`） */
function taskNameOf(agentPath: string | null | undefined, fallback: string): string {
	const last = (agentPath ?? "")
		.split("/")
		.filter((part) => part !== "")
		.pop();
	if (!last) return fallback;
	const pretty = last.replace(/[_-]+/g, " ").trim();
	return pretty === "" ? fallback : pretty.charAt(0).toUpperCase() + pretty.slice(1);
}

/** 一次 item 带来的增量（`undefined` = 这条 item 跟子代理无关） */
type CollabPatch = {
	threadId: string;
	conversationId?: string;
	status?: SubagentStatus;
	label?: string;
	model?: string;
	task?: string;
	error?: string;
	endedAt?: number;
};

/**
 * `subAgentActivity` → 增量。
 *
 * 文案全从引擎给的原话里取（`agentPath` / `model`），不自己编。
 */
function activityPatch(item: CodexSubAgentActivityItem, at: number): CollabPatch | null {
	const threadId = typeof item.agentThreadId === "string" ? item.agentThreadId : "";
	if (threadId === "") return null;
	const base: CollabPatch = { threadId, label: taskNameOf(item.agentPath, threadId.slice(0, 8)) };
	if (typeof item.model === "string" && item.model !== "") base.model = item.model;
	switch (item.kind) {
		case "started":
			return { ...base, status: "running" };
		case "interrupted":
			return { ...base, status: "aborted", endedAt: at };
		case "completed":
			return { ...base, status: "completed", endedAt: at };
		case "interacted":
			// 只是有消息往来：状态不变（running 的子代理继续保持 running）
			return { ...base, status: "running" };
		default:
			return base;
	}
}

/**
 * `collabAgentToolCall` → 增量（可能一次带来多个子 thread 的状态）。
 *
 * 只认 `agentsStates`：那是引擎对「这个子代理现在怎么样」的**权威回答**。
 * `wait` 之类的工具调用状态不等于子代理状态（wait 结束了不代表子代理跑完）。
 */
function collabStatesPatch(item: CodexCollabItem): CollabPatch[] {
	const states = item.agentsStates ?? {};
	const patches: CollabPatch[] = [];
	for (const [threadId, state] of Object.entries(states)) {
		const status = statusOfAgentState(state?.status);
		if (!status) continue;
		const message = typeof state?.message === "string" && state.message !== "" ? state.message : undefined;
		patches.push({
			threadId,
			status,
			...(status === "failed" && message ? { error: message } : {}),
			...(status === "running" ? {} : {}),
		});
	}
	/**
	 * spawn 那一刻把 prompt 记下来（面板上「让它干什么」有原文可看）。
	 *
	 * 注意：spawn item 的 `agentsStates` **不一定**已经有这个新 thread（我们实测到的是空对象），
	 * 所以要按 `receiverThreadIds` 补一条 patch —— 否则卡片上只剩「由 Codex 自己发起的委派」。
	 */
	if (item.tool === "spawnAgent" && typeof item.prompt === "string" && item.prompt !== "") {
		for (const threadId of item.receiverThreadIds ?? []) {
			const found = patches.find((patch) => patch.threadId === threadId);
			if (found) {
				found.task = item.prompt;
				continue;
			}
			patches.push({ threadId, status: "running", task: item.prompt });
		}
	}
	return patches;
}

/**
 * 模板 + 开关 → `thread/start` 的 `config`（**按会话生效**，不写用户全局配置）。
 *
 * `agents.<id>.description`：codex 会用这个 description 告诉模型「有哪些子代理类型可挑」；
 * 具体的模型 / 上下文由 `spawn_agent` 自己的参数决定（我们不硬塞，否则模板会骗人）。
 */
export function codexMultiAgentConfig(input: {
	enabled: boolean;
	concurrency: number;
	profiles: { id: string; description: string; label: string }[];
	/** 多代理运行时版本；默认 v1（原因见下面的实测说明） */
	version?: "v1" | "v2";
}): Record<string, unknown> {
	const version = input.version ?? "v1";
	const agents: Record<string, unknown> = {
		// 实测：这个数字是「同时几个子代理」；模型被告知的是 数字 + 1（含它自己）
		max_concurrent_threads_per_session: Math.max(1, Math.min(16, Math.round(input.concurrency))),
	};
	// `agents.<id>` 的「类型」只有 v2 认（v1 里所有子代理能力相同、没有类型可挑）
	if (input.enabled && version === "v2") {
		for (const profile of input.profiles) {
			agents[agentTypeId(profile.id)] = {
				description: `${profile.label}：${profile.description}`.trim(),
			};
		}
	}
	return {
		features: { multi_agent: input.enabled, multi_agent_v2: input.enabled && version === "v2" },
		agents,
	};
}

/**
 * 注入到**父会话** developer instructions 的委派说明。
 *
 * 只写 codex 真有的动作（`spawn_agent` 等），不写 pi 的 `Agent` 工具；也不假装
 * 「一定会主动委派」——codex 默认策略是 `explicitRequestOnly`（用户明确要求才派）。
 */
export function codexSubagentGuidance(input: {
	enabled: boolean;
	profiles: { id: string; label: string; description: string }[];
	/** 默认 v1：v1 的子代理没有「类型」，模板只作为委派说明（见文件头） */
	version?: "v1" | "v2";
}): string | null {
	const typed = (input.version ?? "v1") === "v2";
	if (!input.enabled || input.profiles.length === 0) return null;
	const types = input.profiles
		.map((profile) =>
			typed
				? `- ${agentTypeId(profile.id)}: ${profile.label} — ${profile.description}`
				: `- ${profile.label}: ${profile.description}`,
		)
		.join("\n");
	return [
		"## Delegating to subagents",
		"You can delegate with the collaboration tools: `spawn_agent` (create a sub-agent thread),",
		"`send_message` / `followup_task` (talk to it again), `wait_agent`, `interrupt_agent`, `list_agents`.",
		"The user watches these runs in the workspace's Agents panel and can stop them, so:",
		"- Delegate only when the user (or AGENTS.md / skill instructions) explicitly asks for",
		"  delegation or parallel work; do not spawn sub-agents on your own initiative.",
		"- Give every spawn a short `task_name` (it becomes the card title) and a self-contained",
		"  first message: the sub-agent cannot see this conversation unless you pass a full-history fork.",
		"- When several parts are independent, spawn them one after another and then `wait_agent` once",
		"  with all ids — do not poll in a loop.",
		typed
			? "- Available sub-agent types (pass the id as `agent_type`, and restate its rules in the message):"
			: "- Available delegation briefs — pick one and restate its rules in the `message` you send:",
		types,
		"- Always pass the task as the spawn `message`; a spawn without a message starts an agent with nothing to do.",
		"- Never claim you cannot delegate: if a collaboration call fails, report the error text.",
	].join("\n");
}

/** 内存里最多留几条运行记录（与 pi 侧同一个数） */
const MAX_RUNS = 60;

/** 一次运行的内部状态（`SubagentRunView`） */
type RunState = { view: SubagentRunView; settled: boolean };

type CodexSubagentsOptions = {
	/** 发 JSON-RPC（引擎的 client） */
	request: <T>(method: string, params?: unknown, options?: { timeoutMs?: number }) => Promise<T>;
	log?: (text: string) => void;
	now?: () => number;
};

/**
 * codex 版 `SubagentEnginePort`：**只观测 + 停止**，不起子会话（委派是模型自己发起的）。
 *
 * `start()` 因此会报一句可读错误：面板上并没有「手动起一个子代理」的入口，
 * 这条路径只有 pi 的 `Agent` 工具会走（见 pi-subagent-tool.ts）。
 */
export function createCodexSubagents(options: CodexSubagentsOptions): SubagentEnginePort & {
	/** 引擎把 collab item 喂进来（`conversationId` 由 senderThreadId 反查得到） */
	ingest(conversationId: string, item: CodexSubagentItem): void;
	/** 当前并发上限（引擎建会话时要写进 thread config） */
	concurrency: () => number;
	/** 子代理总开关（关掉 → 建会话时把 multi_agent 关掉，模型就没这套工具） */
	enabled: () => boolean;
	setEnabled(enabled: boolean): void;
} {
	const now = options.now ?? (() => Date.now());
	const runs = new Map<string, RunState>();
	const order: string[] = [];
	const listeners = new Set<(run: SubagentRunView) => void>();
	let limit = 4;
	let enabled = true;

	const emit = (run: SubagentRunView): void => {
		for (const listener of listeners) {
			try {
				listener({ ...run });
			} catch {
				// 宿主侧抛错不能打断引擎的事件流
			}
		}
	};

	/** 只留最近 N 条（跑一天的会话不该把内存堆满；面板本来就只显示当前会话的） */
	const trim = (): void => {
		while (order.length > MAX_RUNS) {
			const oldest = order.shift();
			if (!oldest) break;
			const state = runs.get(oldest);
			if (state && state.view.status === "running") {
				order.push(oldest); // 还在跑的不能删
				break;
			}
			runs.delete(oldest);
		}
	};

	const apply = (conversationId: string, patch: CollabPatch): void => {
		const id = `codex:${patch.threadId}`;
		const existing = runs.get(id);
		if (!existing) {
			const view: SubagentRunView = {
				id,
				conversationId,
				// codex 不在运行视图里报告用了哪个模板：如实写「引擎自己委派的」
				profile: "codex",
				label: patch.label ?? patch.threadId.slice(0, 8),
				description: patch.task ? patch.task.slice(0, 120) : "由 Codex 自己发起的委派",
				status: patch.status ?? "running",
				task: patch.task ?? "",
				startedAt: now(),
				...(patch.model ? { model: patch.model } : {}),
				...(patch.status && patch.status !== "running" ? { endedAt: patch.endedAt ?? now() } : {}),
				...(patch.error ? { error: patch.error } : {}),
			};
			runs.set(id, { view, settled: view.status !== "running" });
			order.push(id);
			trim();
			emit(view);
			// 结束得很快的任务：补一次结果（子 thread 的最后一条 agent 消息）
			if (view.status !== "running") void fillResult(patch.threadId, view);
			return;
		}
		const state = existing;
		if (state.settled && patch.status === "running") return; // 迟到的事件不改已结算的记录
		const next: SubagentRunView = {
			...state.view,
			// agentPath / prompt 是稳定的，后到的事件带了就以它为准（先到的那条常常只有 thread id）
			...(patch.label ? { label: patch.label } : {}),
			...(patch.task && state.view.task === "" ? { task: patch.task, description: patch.task.slice(0, 120) } : {}),
			...(patch.model ? { model: patch.model } : {}),
			...(patch.status ? { status: patch.status } : {}),
			...(patch.error ? { error: patch.error } : {}),
		};
		if (patch.status && patch.status !== "running") {
			next.endedAt = patch.endedAt ?? now();
			state.settled = true;
		}
		state.view = next;
		emit(next);
		if (state.settled && next.result === undefined && next.status === "completed") {
			void fillResult(patch.threadId, next);
		}
	};

	/**
	 * 子代理的最终答复不在 collab item 里（那是「工具调用」的元数据）→ 结束前读一次子 thread 的
	 * 最后一条 agent 消息。读不到就算了：卡片上没有结果正文，比编一段强。
	 */
	async function fillResult(threadId: string, view: SubagentRunView): Promise<void> {
		try {
			const listed = await options.request<{ data?: { items?: { type?: string; text?: string }[] }[] }>(
				"thread/turns/list",
				{ threadId, limit: 4, sortDirection: "desc" },
				{ timeoutMs: 15_000 },
			);
			const turns = listed?.data ?? [];
			// 子代理自己的第一条 user 消息就是「你让它干什么」：派活时 codex 没把 prompt 放进 item，
			// 只能从子 thread 里读回来（读不到就算了，卡片上没有任务原文，比编一段强）。
			let task: string | undefined;
			for (const turn of [...turns].reverse()) {
				const first = (turn.items ?? []).find((item) => item.type === "userMessage") as
					{ content?: { text?: string }[] } | undefined;
				const text = (first?.content ?? [])
					.map((part) => part.text ?? "")
					.join("")
					.trim();
				if (text !== "") {
					task = text;
					break;
				}
			}
			for (const turn of turns) {
				const message = (turn.items ?? []).filter((item) => item.type === "agentMessage").pop();
				if (message?.text) {
					const state = runs.get(view.id);
					if (state) {
						state.view = {
							...state.view,
							result: message.text.slice(0, 4000),
							...(task && state.view.task === "" ? { task, description: task.slice(0, 120) } : {}),
						};
						emit(state.view);
					}
					return;
				}
			}
		} catch (error) {
			options.log?.(
				`codex：读子代理结果失败（${threadId.slice(0, 8)}）：${error instanceof Error ? error.message : String(error)}`,
			);
		}
	}

	return {
		concurrency: () => limit,
		enabled: () => enabled,
		setEnabled: (value) => {
			enabled = value;
		},

		ingest(conversationId, item) {
			if (item.type === "subAgentActivity") {
				const patch = activityPatch(item, now());
				if (patch) apply(conversationId, patch);
				return;
			}
			for (const patch of collabStatesPatch(item)) apply(conversationId, patch);
		},

		async start(_request: SubagentRequest) {
			throw new Error("codex 的委派由引擎自己发起：在对话里明确要求它委派子代理即可（面板只负责展示与停止）");
		},

		async interrupt(runId) {
			const state = runs.get(runId);
			if (!state) return;
			const threadId = runId.replace(/^codex:/, "");
			try {
				// 子代理是一个 thread：找到它正在跑的那一轮，再打断
				const listed = await options.request<{ data?: { id?: string }[] }>(
					"thread/turns/list",
					{ threadId, limit: 1, sortDirection: "desc" },
					{ timeoutMs: 15_000 },
				);
				const turnId = listed?.data?.[0]?.id;
				if (!turnId) return;
				await options.request("turn/interrupt", { threadId, turnId });
			} catch (error) {
				options.log?.(`codex：停止子代理失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},

		get(runId) {
			return runs.get(runId)?.view ?? null;
		},

		subscribe(listener) {
			listeners.add(listener);
			return () => listeners.delete(listener);
		},

		setConcurrency(next) {
			limit = Math.max(1, Math.min(16, Math.round(next)));
		},

		dispose() {
			listeners.clear();
			runs.clear();
			order.length = 0;
		},
	};
}
