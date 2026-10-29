/**
 * 「让 AI 给会话起个名」的提示词与结果清洗（**纯函数**）。
 *
 * 为什么单独一层：提示词是产品语感（想让它起什么样的名字），清洗是健壮性
 * （模型经常回「标题：」开头、带引号、带句号、或者干脆回一段解释）。
 * 两者都不需要模型、不需要 IO，抽出来就是纯函数，改语气不用碰运行时。
 */

type TitleMessage = { role: "user" | "assistant"; text: string };

/** 喂给模型的对话正文上限：起名只看开头与最近几轮，塞整段长对话既慢又容易跑偏 */
const MAX_TRANSCRIPT_CHARS = 5000;
/** 标题长度上限（按字符算；中文 18 字在小屏幕上刚好一行） */
const MAX_TITLE_CHARS = 18;
/** 英文标题按「单词」放宽一点，别把 "Fix sidebar session ordering" 砍成半截单词 */
const MAX_TITLE_CHARS_LATIN = 56;

/** 去掉模型爱加的前后缀：`#`、引号、`标题：`、结尾标点（多跑几轮 —— 引号和标点常叠在一起） */
function stripDecorations(line: string): string {
	let text = line.trim();
	for (let round = 0; round < 4; round += 1) {
		const before = text;
		text = text.replace(/^#{1,6}\s*/, "");
		text = text.replace(/^(?:标题|会话名|名字|title|name)\s*[:：]\s*/i, "");
		text = text.replace(/^["'“”『』「」‘’`*]+/, "");
		text = text.replace(/["'“”『』「」‘’`*]+$/, "");
		text = text.replace(/[。．.、,，；;：:!！?？~～]+$/, "");
		if (text === before) break;
	}
	return text.trim();
}

/**
 * 「这是前导语，不是标题」：`好的，我给这条会话起个名：` / `以下是建议的标题：` 这类。
 *
 * 判据两条：以寒暄/引导词开头，或**以冒号结尾**（标题不会以冒号收尾）。
 */
function isLeadIn(line: string): boolean {
	return /^(好的|好|ok\b|okay|可以|以下是|这是|建议|已为你|已生成)/i.test(line) || /[:：]$/.test(line);
}

function hasCjk(text: string): boolean {
	return /[\u3400-\u9fff\uf900-\ufaff]/.test(text);
}

/** 超长就截断：中文按字数，英文按词边界 */
function clampTitle(text: string): string {
	if (!hasCjk(text)) {
		if (text.length <= MAX_TITLE_CHARS_LATIN) return text;
		const cut = text.slice(0, MAX_TITLE_CHARS_LATIN);
		const space = cut.lastIndexOf(" ");
		return (space > MAX_TITLE_CHARS_LATIN / 2 ? cut.slice(0, space) : cut).trim();
	}
	const chars = [...text];
	return chars.length <= MAX_TITLE_CHARS ? text : chars.slice(0, MAX_TITLE_CHARS).join("").trim();
}

/** 拼对话正文：用户/助手各自一段，压掉空行与超长内容 */
function transcript(messages: TitleMessage[]): string {
	const parts: string[] = [];
	let used = 0;
	for (const message of messages) {
		const text = message.text.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		const line = `${message.role === "user" ? "用户" : "助手"}：${text}`;
		if (used + line.length > MAX_TRANSCRIPT_CHARS) {
			// 超了就停 —— 起名不需要把整段对话都读完
			parts.push(line.slice(0, Math.max(0, MAX_TRANSCRIPT_CHARS - used)));
			break;
		}
		parts.push(line);
		used += line.length + 1;
	}
	return parts.join("\n");
}

/**
 * 起名提示词。
 *
 * 语感要求（都在用户反馈里踩过）：
 *   - **别照抄第一句**（以前自动标题就是首条消息截断，长句直接被当成名字）；
 *   - **名词短语**，说得清「在做什么事」，别写成「关于 X 的讨论」；
 *   - 只回一行纯文本 —— 让清洗层能一把过。
 */
export function buildTitlePrompt(messages: TitleMessage[]): string {
	const body = transcript(messages);
	return [
		"你在给一条会话起标题。只输出标题本身：一行纯文本，不要引号、不要前缀「标题：」、不要句号、不要任何解释。",
		"",
		"要求：",
		"- 概括这段对话**实际在做的事**，不要照抄原句，也不要复述用户的原话；",
		"- 用简洁的名词短语，体现「对象 + 动作/结论」，例如「侧栏会话排序修复」「图片压缩流程接入」；",
		"- 不要用「关于…的讨论」「问题咨询」这类空话；",
		`- 最多 ${MAX_TITLE_CHARS} 个汉字（英文最多 ${MAX_TITLE_CHARS_LATIN} 个字符，按词断开）。`,
		"",
		"对话内容：",
		body,
	].join("\n");
}

/**
 * 清洗模型输出。`fallback` 是拿不到好标题时的兜底（通常是第一条用户消息的截断）。
 *
 * 取**第一个非空行**：模型偶尔会先来一句「好的，我给这条会话起个名：」再给标题，
 * 那种情况第一行就是废话 —— 所以先找「像标题」的行（清洗后非空、且不是明显的前导语）。
 */
export function sanitizeTitle(raw: string, fallback: string): string {
	const lines = raw
		.split(/\r?\n/)
		.map((line) => line.trim())
		.filter((line) => line !== "")
		// 先判「这是不是前导语」，再剥装饰 —— 反过来的话「好的，…：」被剥成「好的，…」就不再好认了
		.filter((line) => !isLeadIn(line))
		.map(stripDecorations)
		.filter((line) => line !== "");
	const cleaned = clampTitle(lines[0] ?? "");
	if (cleaned !== "") return cleaned;
	const plain = clampTitle(stripDecorations(fallback.replace(/\s+/g, " ")));
	return plain !== "" ? plain : "新对话";
}

/** 把界面消息压成「谁说了什么」：只留正文，工具块/思考块不进提示词 */
export function messagesForTitle(
	messages: { role: "user" | "assistant"; blocks: { kind: string; text?: string }[] }[],
): TitleMessage[] {
	return messages
		.map((message) => ({
			role: message.role,
			text: message.blocks
				.filter((block) => block.kind === "text" && typeof block.text === "string")
				.map((block) => block.text as string)
				.join("\n"),
		}))
		.filter((message) => message.text.trim() !== "");
}
