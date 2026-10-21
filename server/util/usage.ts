/**
 * 解析「这条 assistant 消息用了多少 token」。
 *
 * 各家 provider 的字段名不一样（驼峰 / 下划线 / OpenAI 风格），这里统一认一遍：
 * 会话统计（累计）、消息尾注（单条）、历史回放都用这一份，避免三处各写一套。
 */
export type TokenUsage = { input: number; output: number; cacheRead: number; cacheWrite: number };

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
	return parsed.input + parsed.output + parsed.cacheRead + parsed.cacheWrite === 0 ? null : parsed;
}
