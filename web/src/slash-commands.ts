/**
 * 输入框里的 `/` 面板：**一条命令（`/new`）+ 技能补全**。
 *
 * 2026-11-24 用户：「这些都删了吧，没啥用」——`/name` `/model` `/thinking` `/copy`
 * `/session` `/resume` 全删了：改名、切模型、切思考档、复制上一条在界面上本来就有按钮 / 菜单，
 * 会话统计在顶栏，刷新会话列表是重连后自动做的事。留着只是多一张表 + 多一套
 * 「这条命令在哪个引擎不生效」的解释成本（实测 opencode / dsh / claude 根本没有改名能力）。
 *
 * `/new` 保留（同日用户：「把 /new 留着」）：它是唯一一条「打字比点按钮快」的动作 ——
 * 尤其 `/new 帮我看看这个` 这种带首条消息的写法，键盘流里很顺手。
 *
 * `/skill ` 不是工作台命令，而是 pi 的技能输入语法：它最终作为正文发给引擎
 * （`/skill:名字 …` 会被引擎展开），面板只是帮忙挑名字 —— 删了技能就得靠人肉记名字。
 */
import { setDraft } from "./store.ts";
import { newChat } from "./ws.ts";
import type { Snapshot } from "./types.ts";

type SlashCommandKind = "app" | "agent";

export type SlashCommand = {
	/** 不带斜杠的名字，例如 `new` */
	name: string;
	kind: SlashCommandKind;
	/** 参数提示，没有参数就是空 */
	args?: string;
	/** 参数提示的英文写法；不填就用 `args` */
	argsEn?: string;
	/** 中文说明 */
	description: string;
	/** 英文说明（调用点：`t(description, descriptionEn)`） */
	descriptionEn?: string;
};

/** 面板里列出来的全部命令 */
const SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "new",
		kind: "app",
		args: "[首条消息]",
		argsEn: "[first message]",
		description: "新建对话，可带上第一条消息",
		descriptionEn: "Start a new conversation, optionally with the first message",
	},
	/*
	 * 下面三条是 `kind: "agent"`：宿主**不执行**它们，原样当一条消息发给引擎自己解释
	 * （2026-11-24 用户：「/new 下面还需要这几个」）。
	 * 所以面板只管补全写法， `isAppCommand` 对它们返回 false → 发送时不会被拦下。
	 */
	{
		name: "skill",
		kind: "agent",
		args: "<技能名>",
		argsEn: "<skill name>",
		description: "用某个技能（下面会列出已安装的技能）",
		descriptionEn: "Use a skill (installed skills are listed below)",
	},
	{
		name: "compact",
		kind: "agent",
		args: "[说明]",
		argsEn: "[note]",
		description: "压缩上下文（交给引擎处理）",
		descriptionEn: "Compact the context (handled by the engine)",
	},
	{
		name: "plan",
		kind: "agent",
		args: "[on|off]",
		description: "开关计划模式（交给引擎处理）",
		descriptionEn: "Toggle plan mode (handled by the engine)",
	},
];

/** 挑技能时的候选（`enabled === false` 的也列出来，但标一下） */
export type SkillChoice = { id: string; name: string; description: string; enabled: boolean };

type SlashInput = { mode: "commands"; term: string } | { mode: "skills"; term: string };

/**
 * 输入框里这段文本算不算「正在敲命令 / 挑技能」。
 *
 * 判据：**第一行以 `/` 开头**且还没敲到空白之后（`/new 你好` 这种已经是参数了，面板该收）。
 * 返回 null = 不弹面板。
 */
export function parseSlashInput(text: string): SlashInput | null {
	const first = text.split("\n", 1)[0] ?? "";
	if (!first.startsWith("/")) return null;
	const body = first.slice(1);
	// `/skill:xxx` = **已经写全了具体技能名**：它是发给引擎的正文，不是什么命令 ——
	// 弹面板会让它看起来像个命令，而且面板开着时 Enter 会被面板吃掉
	// （用户看到的：打了 `/skill:smart-charts …` 按发送/回车，一点反应都没有）。
	if (/^skill:/i.test(body)) return null;
	// `/skill `（带空格）继续留在面板里：这时候是在挑技能名
	if (/^skill\s/i.test(body)) return { mode: "skills", term: body.replace(/^skill\s+/i, "").trim() };
	if (body.includes(" ")) return null;
	// 只打了 `/skill`（还没空格）：命令模式，让用户先选中那条 skill 命令
	return { mode: "commands", term: body };
}

/** 按输入过滤（前缀优先，其次包含名字或说明里出现过） */
export function filterCommands(query: string): SlashCommand[] {
	const key = query.trim().toLowerCase();
	if (key === "") return SLASH_COMMANDS;
	const prefix = SLASH_COMMANDS.filter((item) => item.name.startsWith(key));
	const rest = SLASH_COMMANDS.filter((item) => !item.name.startsWith(key) && item.name.includes(key));
	return [...prefix, ...rest];
}

/** 按输入过滤技能（名字/描述都匹配；`/skill ` 后面没写就是全列） */
export function filterSkills(skills: SkillChoice[], term: string): SkillChoice[] {
	const key = term.trim().toLowerCase();
	const list =
		key === "" ? skills : skills.filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(key));
	// 启用的排前面：挑的时候多半是想用一个能用的
	return [...list].sort(
		(left, right) => Number(right.enabled) - Number(left.enabled) || left.name.localeCompare(right.name),
	);
}

/** 选中之后填进输入框的文本：带参数的命令留一个空格，光标正好落在参数位置 */
export function commandDraft(command: SlashCommand): string {
	return `/${command.name} `;
}

/** 一条命令的完整写法（面板里显示用）；`english` 时参数提示走 `argsEn` */
export function commandUsage(command: SlashCommand, english = false): string {
	const hint = english ? (command.argsEn ?? command.args) : command.args;
	return hint ? `/${command.name} ${hint}` : `/${command.name}`;
}

/**
 * 这条文本是不是「宿主自己就能做完」的命令（`app` 类）。
 *
 * 调用方靠它决定**要不要再当消息发出去**。
 */
export function isAppCommand(text: string): boolean {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return false;
	const name = (trimmed.slice(1).split(/\s+/)[0] ?? "").toLowerCase();
	return SLASH_COMMANDS.some((item) => item.name === name && item.kind === "app");
}

type SlashOutcome = { handled: true } | { handled: false };

/**
 * 执行一条斜杠命令。
 *
 * 只做**宿主自己做得动**的那几条；其余和不认识的命令返回 `handled: false`，
 * 由调用方照常当消息发出去（引擎自己认识 `/compact` 之类）。
 */
export async function runSlashCommand(text: string, _snapshot: Snapshot | null): Promise<SlashOutcome> {
	const trimmed = text.trim();
	if (!trimmed.startsWith("/")) return { handled: false };
	const [rawName, ...rest] = trimmed.slice(1).split(/\s+/);
	const name = (rawName ?? "").toLowerCase();
	const args = rest.join(" ").trim();
	const command = SLASH_COMMANDS.find((item) => item.name === name);
	if (!command || command.kind !== "app") return { handled: false };

	switch (name) {
		case "new": {
			newChat();
			// 带了首条消息：新建后把它放进输入框，用户确认再发（不替人按发送）。
			// 延迟一拍是因为 newChat() 会切空会话，等它推平再写草稿（否则会被当成上一会话的残留）。
			if (args) window.setTimeout(() => setDraft(args), 80);
			return { handled: true };
		}
		default:
			return { handled: false };
	}
}
