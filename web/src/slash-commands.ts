/**
 * 斜杠命令（输入框里打 `/` 弹出的那一张表）。
 *
 * 为什么先做「壳」而不是直接转发给引擎：pi 的 `/compact`、`/plan` 这类确实能透传给 agent，
 * 但 `/new`、`/name`、`/model` 这些**是工作台自己的动作** —— 交给模型只会换来一段"我不会执行命令"。
 * 所以每条命令标一个 `kind`：
 *   - `app`：宿主自己执行（新建对话 / 改名 / 切模型 / 切思考档 / 复制上一条回复 / 刷新会话）；
 *   - `agent`：原样作为一条消息发给引擎（pi 的 CLI 命令，语义由引擎决定）。
 *
 * 这条分界线也让右栏 badge 有意义：`app` 显示「本地」，`agent` 显示「发给 Agent」。
 */
import type { Snapshot } from "./types.ts";
import { lastSeenMessages, setDraft } from "./store.ts";
import { textOfMessage } from "./message-text.ts";
import { copyText } from "./clipboard.ts";
import { newChat, renameSession, requestState, setModel, setThinkingLevel } from "./ws.ts";
import { showToast } from "./toast.ts";

type SlashCommandKind = "app" | "agent";

export type SlashCommand = {
	/** 不带斜杠的名字，例如 `new` */
	name: string;
	kind: SlashCommandKind;
	/** 参数提示（`<名称>` / `[档位]`），没有参数就是空 */
	args?: string;
	/** 参数提示的英文写法（`<name>` / `[level]`）；不填就用 `args` */
	argsEn?: string;
	/** 中文说明（英文走 i18n 字典） */
	description: string;
};

/** 面板里列出来的全部命令（顺序 = 面板顺序，常用的排前面） */
const SLASH_COMMANDS: SlashCommand[] = [
	{
		name: "new",
		kind: "app",
		args: "[首条消息]",
		argsEn: "[first message]",
		description: "新建对话，可带上第一条消息",
	},
	{ name: "name", kind: "app", args: "<名称>", argsEn: "<name>", description: "重命名当前会话" },
	{ name: "model", kind: "app", args: "<名称>", argsEn: "<name>", description: "切换模型（按 id 或显示名模糊匹配）" },
	{
		name: "thinking",
		kind: "app",
		args: "<档位>",
		argsEn: "<level>",
		description: "设置思考强度（off / low / … / max）",
	},
	{ name: "copy", kind: "app", description: "复制最后一条助手消息" },
	{ name: "session", kind: "app", description: "显示会话消息数 / token / 费用统计" },
	{ name: "resume", kind: "app", description: "刷新会话列表（别的终端里刚开的会话）" },
	{
		name: "skill",
		kind: "agent",
		args: "<技能名>",
		argsEn: "<skill name>",
		description: "用某个技能（下面会列出已安装的技能）",
	},
	{ name: "compact", kind: "agent", args: "[说明]", argsEn: "[note]", description: "压缩上下文（交给引擎处理）" },
	{ name: "plan", kind: "agent", args: "[on|off]", description: "开关计划模式（交给引擎处理）" },
	{ name: "cwd", kind: "agent", args: "<路径>", argsEn: "<path>", description: "切换工作目录（交给引擎处理）" },
];

/**
 * 输入框里这段文本算不算「正在敲命令」。
 *
 * 判据：**第一行以 `/` 开头**且还没敲到空白之后（`/na me` 这种已经是参数了，面板该收）。
 * 返回 null = 不弹面板。
 */
type SlashInput = { mode: "commands"; term: string } | { mode: "skills"; term: string };

export function parseSlashInput(text: string): SlashInput | null {
	const first = text.split("\n", 1)[0] ?? "";
	if (!first.startsWith("/")) return null;
	const body = first.slice(1);
	// `/skill:xxx` = **已经写全了具体技能名**（面板插入的就是这个形状）：它是发给引擎的正文，
	// 不是什么命令 —— 弹面板会让它看起来像个命令，而且面板开着时 Enter 会被面板吃掉
	// （用户看到的：打了 `/skill:smart-charts …` 按发送/回车，一点反应都没有）。
	if (/^skill:/i.test(body)) return null;
	// `/skill `（带空格）继续留在面板里：这时候是在挑技能名，不是在写命令参数
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

/** 挑技能时的候选（`enabled === false` 的也列出来，但标一下） */
export type SkillChoice = { id: string; name: string; description: string; enabled: boolean };

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
	return command.args ? `/${command.name} ` : `/${command.name} `;
}

/** 一条命令的完整写法（面板里显示用）；`english` 时参数提示走 `argsEn` */
export function commandUsage(command: SlashCommand, english = false): string {
	const hint = english ? (command.argsEn ?? command.args) : command.args;
	return hint ? `/${command.name} ${hint}` : `/${command.name}`;
}

/**
 * 这条文本是不是「宿主自己就能做完」的命令（`app` 类）。
 *
 * 调用方靠它决定**要不要再当消息发出去**。以前是在 Composer 里用
 * `filterCommands(首个词).some(kind === "agent")` 反推的 —— 那个判据认不出
 * `/skill:smart-charts` 这种形状，于是整条消息被静默吞掉（点发送毫无反应）。
 * 直接用「是不是 app 命令」这件事本身判断，不绕。
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
 * 只做**宿主自己做得动**的那几条；`agent` 类和不认识的命令返回 `handled: false`，
 * 由调用方照常当消息发出去（引擎自己认识 `/compact` 之类）。
 */
export async function runSlashCommand(text: string, snapshot: Snapshot | null): Promise<SlashOutcome> {
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
			// 以前这里派发 `agent-web:seed-draft` 事件，但**全仓没有任何监听者** ——
			// `/new 你好` 的「你好」就这么静默丢了。直接写 store 就行。
			if (args) window.setTimeout(() => setDraft(args), 80);
			return { handled: true };
		}
		case "name": {
			const conversationId = snapshot?.active.conversationId ?? null;
			if (!conversationId) {
				showToast({ text: "先打开一个会话再改名" });
				return { handled: true };
			}
			if (!args) {
				showToast({ text: "用法：/name <名称>" });
				return { handled: true };
			}
			renameSession(conversationId, args);
			showToast({ text: `已把会话改名为「${args}」` });
			return { handled: true };
		}
		case "model": {
			const models = snapshot?.models ?? [];
			if (models.length === 0) {
				showToast({ text: "模型列表还没就绪，等一下再试" });
				return { handled: true };
			}
			if (!args) {
				showToast({ text: "用法：/model <模型名或 id>" });
				return { handled: true };
			}
			const key = args.toLowerCase();
			const hit =
				models.find((model) => model.id.toLowerCase() === key) ??
				models.find((model) => model.label.toLowerCase() === key) ??
				models.find((model) => model.id.toLowerCase().includes(key) || model.label.toLowerCase().includes(key));
			if (!hit) {
				showToast({ text: `没找到模型「${args}」` });
				return { handled: true };
			}
			setModel(hit.id);
			showToast({ text: `已切到 ${hit.label}` });
			return { handled: true };
		}
		case "thinking": {
			const levels = snapshot?.thinkingLevels ?? [];
			if (!args) {
				showToast({ text: `用法：/thinking <${levels.join(" | ") || "off | low | medium | high | xhigh | max"}>` });
				return { handled: true };
			}
			if (levels.length > 0 && !levels.includes(args)) {
				showToast({ text: `这个模型没有「${args}」档：${levels.join(" / ")}` });
				return { handled: true };
			}
			setThinkingLevel(args);
			showToast({ text: `思考强度已设为 ${args}` });
			return { handled: true };
		}
		case "copy": {
			// 会话正文在会话页（MessageList）里，不在快照里：从 store 的本地预览 / 最近渲染的正文取
			const messages = lastSeenMessages();
			const last = [...messages].reverse().find((message) => message.role === "assistant");
			const text_ = (last ? textOfMessage(last) : "").trim();
			if (!text_) {
				showToast({ text: "没有可复制的助手消息" });
				return { handled: true };
			}
			const copied = await copyText(text_);
			showToast({ text: copied ? "已复制最后一条回复" : "复制失败（浏览器不给权限）" });
			return { handled: true };
		}
		case "session": {
			const stats = snapshot?.sessionStats ?? null;
			if (!stats) {
				showToast({ text: "还没有会话统计（跑一轮之后才有）" });
				return { handled: true };
			}
			showToast({
				text: `消息 ${stats.userMessages}+${stats.assistantMessages} · 工具 ${stats.toolCalls} · 输入 ${stats.inputTokens} / 输出 ${stats.outputTokens} tokens`,
			});
			return { handled: true };
		}
		case "resume": {
			requestState();
			showToast({ text: "已请求刷新会话列表" });
			return { handled: true };
		}
		default:
			return { handled: false };
	}
}
