/**
 * 解析「这条 assistant 消息用了多少 token」。
 *
 * 各家 provider 的字段名不一样（驼峰 / 下划线 / OpenAI 风格），这里统一认一遍：
 * 会话统计（累计）、消息尾注（单条）、历史回放都用这一份，避免三处各写一套。
 */
type TokenUsage = {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	/** 本次花费（美元，pi 在 usage.cost.total 里给；没有就是拿不到） */
	cost?: number;
};

const num = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

export function parseUsage(raw: unknown): TokenUsage | null {
	if (typeof raw !== "object" || raw === null) return null;
	const usage = raw as Record<string, unknown>;
	const parsed: TokenUsage = {
		input: num(usage.inputTokens ?? usage.input ?? usage.input_tokens ?? usage.promptTokens),
		output: num(usage.outputTokens ?? usage.output ?? usage.output_tokens ?? usage.completionTokens),
		cacheRead: num(usage.cacheReadTokens ?? usage.cacheRead ?? usage.cache_read ?? usage.cachedTokens),
		cacheWrite: num(usage.cacheWriteTokens ?? usage.cacheWrite ?? usage.cache_write),
	};
	if (parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite === 0) return null;
	// 花费：provider 没配价格 / 免费模型时 pi 不给 cost，这种就不显示
	const costTotal = num((usage.cost as Record<string, unknown> | undefined)?.total);
	if (costTotal > 0) parsed.cost = costTotal;
	return parsed;
}
