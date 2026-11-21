/**
 * 近讲门限的「兜底放开」判断（纯函数，好测）。
 *
 * 问题：门限靠「比最近 3 秒最安静那帧高 N dB」判断，这在**你自己说得小声 / 离得远**时
 * 会把你的声音当成背景一起挡掉 —— 表现就是「说了半天一个字没有」。
 *
 * 兜底规则：如果连续被挡超过一小段时间（默认 1.5 秒），说明门限此刻判的不是
 * 「别人在说话」，而是「你太小声」；这时就权当门限失效，把音频放过去。
 * 放过去之后底噪窗口里会混进你的声音，门限自然重新校准。
 *
 * 注意这是**宁可多收一点**的选择：旁边真有人说话时，如果持续 1.5 秒都压不过门限，
 * 那也是「环境整体响」，挡不挡意义不大。
 */
export function shouldFallbackOpen(input: {
	/** 这一段连续被挡了多少毫秒（0 = 当前没在被挡） */
	blockedForMs: number;
	/** 触发兜底的时长 */
	fallbackMs: number;
}): boolean {
	if (!Number.isFinite(input.blockedForMs) || input.blockedForMs <= 0) return false;
	if (!Number.isFinite(input.fallbackMs) || input.fallbackMs <= 0) return false;
	return input.blockedForMs >= input.fallbackMs;
}
