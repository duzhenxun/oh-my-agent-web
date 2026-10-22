/** 教模型「下一步建议」的写法（ADR-0022）：纯文本标记，不需要调用任何工具 */
export const SUGGESTION_GUIDANCE = [
	"## Suggested next actions",
	"When the user must choose what to do next, end the reply with 4 to 5 lines of:",
	"[[action:suggest:<button text>]]",
	"Clicking a button sends that text as the next user message.",
	"Use [[action:suggest:<short label>,prompt=<text to send>]] when the label should differ from the sent text.",
	"Put them on their own lines at the very end, and never mention this syntax in prose.",
].join("\n");
