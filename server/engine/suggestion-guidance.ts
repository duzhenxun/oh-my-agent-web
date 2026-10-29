/**
 * 教模型「下一步建议」的写法（ADR-0022）：纯文本标记，不需要调用任何工具。
 *
 * 条数由调用方给（设置里「想想」那一个 `settings.thinkCount`，取值 1~5）：
 * 界面上「再给一批」按几条问，模型结尾就写几条 —— 两边用同一个数，不然按钮数和
 * 「想想」的结果数对不上。拿不到就退回默认区间 4~5（与 ADR-0039 一致）。
 */
export function suggestionGuidance(count?: number | null): string {
	const wanted = typeof count === "number" && Number.isInteger(count) && count >= 1 && count <= 5 ? count : null;
	const amount = wanted === null ? "4 to 5" : String(wanted);
	const unit = wanted === 1 ? "line" : "lines";
	return [
		"## Suggested next actions",
		`When the user must choose what to do next, end the reply with ${amount} ${unit} of:`,
		"[[action:suggest:<button text>]]",
		"Clicking a button sends that text as the next user message.",
		"Use [[action:suggest:<short label>,prompt=<text to send>]] when the label should differ from the sent text.",
		"Put them on their own lines at the very end, and never mention this syntax in prose.",
	].join("\n");
}

/** 默认版（4~5 条）：给拿不到设置的地方用（测试、临时会话、预热） */
export const SUGGESTION_GUIDANCE = suggestionGuidance();
