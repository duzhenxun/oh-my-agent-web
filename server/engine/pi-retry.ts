/**
 * 「这一轮挂了，要不要自己再试一次」——判断与策略（纯函数，方便单测）。
 *
 * 为什么需要这一层：pi 只对**它认得出来**的瞬时错误自动重试（overloaded / 5xx /
 * socket hang up / timed out ……），而「This operation was aborted」这类**传输层 abort**
 * 它一律当终态（SDK 里那句注释写得很明白：aborts are terminal and never retried）。
 *
 * 实际观感就是：模型刚连上就被掐断（代理换连接、undici 的 socket 被回收、请求 body 被
 * cancel），界面上一条红色 `engine.provider_error: This operation was aborted`，这一轮
 * 就没了 —— 用户什么都没干，只是运气不好。所以这里补两件事：
 *
 *   1. `classifyProviderError` 把错误分成「可以再试」和「再试也没用」；
 *   2. `retryDelayMs` 给一个短退避（不必等 pi 那套 2s / 4s / 8s）。
 *
 * 只判断**错误文本**，不碰会话状态：要不要重试还有另外几条边界（用户是否按了停止、
 * 这一轮有没有已经往界面上吐过东西……），那些在 `pi-sdk.ts` 的 sendMessage 里。
 */
type ProviderErrorKind = "transient" | "fatal";

/**
 * 再试一次大概率就好的字样：传输层抖动 + 上游过载。
 *
 * ⚠️ `/abort/` 也在里面 —— 用户点「停止」时 SDK 也会吐 abort，但那一路**走不到这里**：
 * 宿主在中断时已经把 `handle.aborting` 置上了，调用方会跳过重试。
 */
const TRANSIENT_PATTERNS: RegExp[] = [
	/\babort(?:ed|ing)?\b/i,
	/socket hang up/i,
	/other side closed/i,
	/\bterminated\b/i,
	/premature close/i,
	/ended without/i,
	/stream (?:was )?(?:interrupted|disconnected)/i,
	/fetch failed/i,
	/ECONNRESET|ECONNABORTED|ECONNREFUSED|EPIPE|ETIMEDOUT|EAI_AGAIN|ENOTFOUND/i,
	/timed? ?out|timeout/i,
	/overloaded|rate.?limit|too many requests|server.?busy/i,
	/service.?(?:is.?)?(?:temporarily.?)?unavailable/i,
	/bad gateway|upstream|gateway/i,
	// 状态码要独立成词，别把请求 id / 字节数里的数字当成 5xx
	/(?:^|[^0-9])(?:429|500|502|503|504|520|524)(?:[^0-9]|$)/,
	/connection (?:error|lost|reset|closed|refused)/i,
	/network.?error|internal.?error|server.?error/i,
];

/**
 * 再试也没用的字样：凭据 / 配额 / 上下文 / 参数。
 * 这些错误换个时间也一样，重试只会多烧一遍钱（甚至把额度烧空），先判它们。
 */
const FATAL_PATTERNS: RegExp[] = [
	/api.?key|unauthori[sz]ed|authentication|invalid.?(?:token|credential)/i,
	/\b401\b|\b403\b/,
	/insufficient|quota|billing|balance|usage limit/i,
	/context.?(?:length|window)|too many tokens|maximum context|token limit/i,
	/model.?(?:not found|does not exist)|no such model/i,
	/\b404\b/,
	/invalid.?(?:request|parameter|argument|schema)/i,
];

/**
 * 分类一条 provider 错误文本。
 *
 * 认不出来的一律算 `fatal`（保守）：自动重试只有「明显是抖动」才值得做，
 * 别把不认识的服务端拒绝重试成刷屏。
 */
export function classifyProviderError(message: string): ProviderErrorKind {
	const text = typeof message === "string" ? message : "";
	if (text.trim() === "") return "fatal";
	if (FATAL_PATTERNS.some((pattern) => pattern.test(text))) return "fatal";
	return TRANSIENT_PATTERNS.some((pattern) => pattern.test(text)) ? "transient" : "fatal";
}

/** 一轮里最多补试几次（不含第一次）。pi 自己那 3 次重试是另一层，互不干扰。 */
export const RETRY_MAX_ATTEMPTS = 2;

/** 补试前的退避：第 1 次 1s、第 2 次 3s（再往后就按最后那个值） */
const RETRY_DELAYS_MS = [1_000, 3_000];

export function retryDelayMs(attempt: number): number {
	const index = Math.min(Math.max(attempt, 1), RETRY_DELAYS_MS.length) - 1;
	return RETRY_DELAYS_MS[index] ?? RETRY_DELAYS_MS[RETRY_DELAYS_MS.length - 1]!;
}

/** 会话树上的一条 entry（只认重试需要的那几个字段） */
export type BranchEntryLike = { type?: string; id: string; message?: unknown };

function asRecord(value: unknown): Record<string, unknown> {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}

function isMessageEntry(entry: BranchEntryLike | undefined): boolean {
	return entry?.type === "message" && typeof entry.id === "string";
}

function roleOf(entry: BranchEntryLike): string | null {
	const role = asRecord(entry.message).role;
	return typeof role === "string" ? role : null;
}

/** 这条助手消息里调用了哪些工具（重试时它们的 toolResult 要一起抹掉） */
function toolCallIdsOf(entry: BranchEntryLike): Set<string> {
	const content = asRecord(entry.message).content;
	const ids = new Set<string>();
	if (!Array.isArray(content)) return ids;
	for (const block of content) {
		const item = asRecord(block);
		if (item.type === "toolCall" && typeof item.id === "string") ids.add(item.id);
	}
	return ids;
}

function toolCallIdOf(entry: BranchEntryLike): string | null {
	const id = asRecord(entry.message).toolCallId;
	return typeof id === "string" ? id : null;
}

/**
 * 重试前要把哪几条从**模型上下文**里抹掉（`context_edit` = null，pi 自己的重试与上下文
 * 溢出恢复也是这么干的）。
 *
 * 抹的是「这一轮那条失败的助手消息 + 它调过的工具的 toolResult」：
 *   · 只抹助手消息不够 —— 配对不上 toolResult 会让下一次请求直接 400（SDK 里也标了这点）；
 *   · 只抹这一轮 —— 用户那句提问要留着，重试就是从它接着跑，不能重复发一遍。
 *
 * 末尾那些不贡献消息的 entry（usage / model_change / label / session_info）先跳过。
 * 找不到「末尾的助手消息」时返回空数组 = 这次别重试了（宁可报错，也不要抹错东西）。
 */
export function retryOmitTargets(branch: readonly BranchEntryLike[]): string[] {
	// 从后往前找最后一条助手消息（跳过 usage / model_change / label 这类不贡献消息的 entry）
	let index = branch.length - 1;
	while (index >= 0 && !(isMessageEntry(branch[index]) && roleOf(branch[index]!) === "assistant")) index -= 1;
	if (index < 0) return [];
	const failed = branch[index]!;

	const targets = [failed.id];
	const toolCallIds = toolCallIdsOf(failed);
	for (const entry of branch.slice(index + 1)) {
		if (!isMessageEntry(entry)) continue;
		const role = roleOf(entry);
		// 后面已经是别的回合了：这不是「末尾那次失败」，别乱抹
		if (role === "user" || role === "assistant") return [];
		if (role !== "toolResult") return [];
		const toolCallId = toolCallIdOf(entry);
		if (toolCallId === null || !toolCallIds.has(toolCallId)) return [];
		targets.push(entry.id);
	}
	return targets;
}
