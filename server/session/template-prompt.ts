/**
 * 「AI 生成提示词」（提示词模板编辑弹窗里的按钮）的编排层。
 *
 * 和 suggest-title.ts 同一个分法，三件事各自能单独测：
 *   1. 校验 + 截断输入（标题 / 说明 / 已有草稿，任一非空即可）；
 *   2. 拼提示词（`buildTemplatePromptRequest`）并让引擎跑一次一次性问答（`ask`）；
 *   3. 清洗模型输出（去围栏、去前导语），落成可直接塞进编辑框的正文。
 *
 * 纯函数只留「语感」和「清洗」；IO 全部经由 `ask` 注入，单测不需要模型。
 */

export type TemplatePromptInput = { name: string; description: string; text: string };

export type GenerateTemplatePromptResult =
	{ ok: true; text: string } | { ok: false; error: { code: string; message: string } };

/** 生成提示词的系统提示词：定义「标准提示词」长什么样 */
export const TEMPLATE_PROMPT_SYSTEM = [
	"你是「提示词模板」编辑助手。把用户给的标题、说明或草稿，改写成一份可以直接交给 AI agent 执行的标准提示词。",
	"只输出提示词正文本身：不要解释，不要前言（如「好的，以下是…」），不要用代码块包裹。",
	"",
	"标准结构（按需取用；用户没提供的信息直接省略，不要编造）：",
	"1. 目标：一两句话说清要完成什么；",
	"2. 输入与范围：要读取或处理的对象（文件、模块、材料），以及用户会提供什么；",
	"3. 步骤：按顺序列出关键动作，每步一句，用祈使句；",
	"4. 输出：交付物的形式与结构（清单、表格、diff、报告等）和语言；",
	"5. 约束：不做什么、边界条件、哪些事情要先问用户再做。",
	"",
	"语言与用户输入保持一致（中文就写中文）。篇幅控制在用户能一眼看完的长度，不要堆砌套话。",
].join("\n");

/** 输入截断上限：标题短、说明一句话、草稿可能很长，超了就截（再长模型也抓不住重点） */
const MAX_NAME_CHARS = 200;
const MAX_DESCRIPTION_CHARS = 500;
const MAX_TEXT_CHARS = 6000;

function clamp(value: unknown, max: number): string {
	if (typeof value !== "string") return "";
	const text = value.trim();
	return [...text].length <= max ? text : [...text].slice(0, max).join("");
}

/** 规整三段输入（类型、空白、长度都在这里收口） */
export function normalizeTemplatePromptInput(
	input: Partial<Record<keyof TemplatePromptInput, unknown>>,
): TemplatePromptInput {
	return {
		name: clamp(input.name, MAX_NAME_CHARS),
		description: clamp(input.description, MAX_DESCRIPTION_CHARS),
		text: clamp(input.text, MAX_TEXT_CHARS),
	};
}

/**
 * 拼给模型的用户消息。有草稿时明确告诉模型「在草稿基础上改写」，
 * 否则它很容易无视草稿另起炉灶，把用户写好的要求丢掉。
 */
export function buildTemplatePromptRequest(input: TemplatePromptInput): string {
	const lines = ["请为下面这个提示词模板写一份标准提示词。", ""];
	if (input.name !== "") lines.push(`标题：${input.name}`);
	if (input.description !== "") lines.push(`说明：${input.description}`);
	if (input.text !== "") {
		lines.push("", "已有草稿（保留其中有用的要求，补全缺的结构，去掉重复和空话）：", input.text);
	} else {
		lines.push("", "还没有草稿：只根据标题和说明来写。");
	}
	return lines.join("\n");
}

/**
 * 清洗模型输出：去掉包裹的代码块围栏，去掉「好的，以下是…：」这类前导语。
 * 前导语判据和起名那边一致：寒暄/引导词开头 **且** 以冒号收尾。
 */
export function sanitizeTemplatePrompt(raw: string): string {
	let text = raw.trim();
	const fenced = text.match(/^```[\w-]*\r?\n([\s\S]*?)\r?\n?```$/);
	if (fenced) text = (fenced[1] ?? "").trim();

	const lines = text.split(/\r?\n/);
	const first = lines[0]?.trim() ?? "";
	if (lines.length > 1 && /^(好的|以下是|这是|下面是|已为你|已生成|当然|可以)/.test(first) && /[:：]$/.test(first)) {
		lines.shift();
	}
	return lines.join("\n").trim();
}

/**
 * 生成器：校验 → 拼提示词 → 一次性问答 → 清洗。
 * `ask` 返回 null 表示「没有可用模型」，单独给一条文案，别让用户以为是生成坏了。
 */
export function createTemplatePromptGenerator(deps: {
	/** 跑一次补全；`conversationId` 决定用哪个模型（弹窗里可能还没有会话） */
	ask: (prompt: string, systemPrompt: string, conversationId: string | null) => Promise<string | null>;
}): (
	input: Partial<Record<keyof TemplatePromptInput, unknown>>,
	conversationId?: string | null,
) => Promise<GenerateTemplatePromptResult> {
	return async (raw, conversationId = null) => {
		const input = normalizeTemplatePromptInput(raw);
		if (input.name === "" && input.description === "" && input.text === "") {
			return {
				ok: false,
				error: { code: "template.empty", message: "先填一个标题或说明，AI 才知道要写什么" },
			};
		}

		let answer: string | null = null;
		try {
			answer = await deps.ask(buildTemplatePromptRequest(input), TEMPLATE_PROMPT_SYSTEM, conversationId);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return { ok: false, error: { code: "template.failed", message: `生成失败：${message}` } };
		}
		if (answer === null) {
			return {
				ok: false,
				error: { code: "template.no_model", message: "AI 生成需要一个可用模型，先在「模型」里配好" },
			};
		}

		const text = sanitizeTemplatePrompt(answer);
		if (text === "") {
			return { ok: false, error: { code: "template.empty_output", message: "模型没有返回内容，再点一次试试" } };
		}
		return { ok: true, text };
	};
}
