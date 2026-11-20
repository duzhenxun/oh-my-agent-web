/**
 * 「AI 生成任务描述」（定时任务表单「提示词」旁边的 AI 按钮）的编排层。
 *
 * 和 template-prompt.ts 同一个分法：校验输入 → 拼请求 → 一次性问答 → 清洗输出。
 * 输入只有任务标题（表单里的「名称」）；输出是一段可以直接当 agent 指令用的任务描述。
 *
 * `ask` 经由依赖注入，单测不需要模型。
 */
import { sanitizeTemplatePrompt } from "./template-prompt.js";

export type GenerateCronPromptResult =
	{ ok: true; text: string } | { ok: false; error: { code: string; message: string } };

/** 任务描述的系统提示词：每次运行时 agent 要照着做的那段话 */
export const CRON_PROMPT_SYSTEM = [
	"你是「定时任务」编辑助手。根据用户给的任务标题，写出这个任务每次运行时要做的事，作为提示词交给 AI agent 执行。",
	"只输出任务描述正文本身：不要解释，不要前言（如「好的，以下是…」），不要用代码块包裹。",
	"",
	"要求：",
	"1. 用一到两段话说清楚：做什么、看哪些对象、产出什么（报告、结论或改动）；",
	"2. 用祈使句，直接对 agent 下指令；",
	"3. 只依据标题推断，不编造具体文件名、路径、数字或网址；标题信息不足时写通用但可执行的描述；",
	"4. 检查类任务要写清楚汇报哪些结论；修改类任务要写清楚改动范围与边界。",
	"",
	"语言与标题保持一致（中文标题就写中文）。篇幅控制在 200 字以内，不要堆砌套话。",
].join("\n");

/** 标题截断上限：标题本应很短，超长的截掉（模型也抓不住重点） */
const MAX_NAME_CHARS = 200;

/** 拼给模型的用户消息 */
export function buildCronPromptRequest(name: string): string {
	return ["请为下面这个定时任务写任务描述。", "", `任务标题：${name}`].join("\n");
}

/**
 * 生成器：校验标题 → 拼请求 → 一次性问答 → 清洗。
 * `ask` 返回 null 表示「没有可用模型」，单独给一条文案，别让用户以为是生成坏了。
 */
export function createCronPromptGenerator(deps: {
	ask: (prompt: string, systemPrompt: string, conversationId: string | null) => Promise<string | null>;
}): (name: unknown, conversationId?: string | null) => Promise<GenerateCronPromptResult> {
	return async (rawName, conversationId = null) => {
		const name = typeof rawName === "string" ? [...rawName.trim()].slice(0, MAX_NAME_CHARS).join("") : "";
		if (name === "") {
			return { ok: false, error: { code: "cron.empty", message: "先填一个名称，AI 才知道要写什么" } };
		}

		let answer: string | null = null;
		try {
			answer = await deps.ask(buildCronPromptRequest(name), CRON_PROMPT_SYSTEM, conversationId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code: "cron.failed", message: `生成失败：${message}` } };
		}
		if (answer === null) {
			return {
				ok: false,
				error: { code: "cron.no_model", message: "AI 生成需要一个可用模型，先在「模型」里配好" },
			};
		}

		const text = sanitizeTemplatePrompt(answer);
		if (text === "") {
			return { ok: false, error: { code: "cron.empty_output", message: "模型没有返回内容，再点一次试试" } };
		}
		return { ok: true, text };
	};
}
