/**
 * 从「这一轮的对话消息」里提取产出：改了哪些文件、跑了哪些命令。
 *
 * 和 `web/src/changed-files.ts` 同一个思路（从工具调用**推**，不额外记状态），
 * 但这边是服务端、要看整轮消息，所以单独一份实现：
 *   - 只认**跑成功**的工具调用（failed / running 都不算"产出"）；
 *   - 文件只认写文件类工具（write / edit / apply_patch …），读文件不做数；
 *   - 路径折成相对工作区；工作区外的标出来（客户端点不开就不假装能点）；
 *   - 一条都没有时，退一步把最后一段回复当摘要（研究型的那一步只有结论，没有文件）。
 *
 * 上限 12 条：节点上挂的是"这一步做出了什么"，不是完整日志。
 */
import type { CanvasArtifact, MessageBlock, UiMessage } from "../protocol.js";

const MAX_ARTIFACTS = 12;
const MAX_LABEL = 120;

/** 写文件类工具名（含 MCP 的 `mcp__xxx__write_file` 这种） */
const WRITE_TOOL =
	/(^|__)(write|edit|multiedit|multi_edit|apply_patch|patch|create_file|write_file|edit_file|update_file|modify_file|str_replace\w*)$/i;
/** 跑命令类工具名 */
const COMMAND_TOOL = /(^|__)(bash|shell|run_command|run_shell_command|exec|execute|command|terminal)$/i;

const PATH_KEYS = ["path", "file_path", "filePath"];
const COMMAND_KEYS = ["command", "cmd", "script"];

function argsOf(block: MessageBlock): Record<string, unknown> | null {
	if (block.kind !== "tool") return null;
	const raw = block.argsFull ?? block.argsSummary;
	if (typeof raw !== "string" || raw.trim() === "") return null;
	try {
		const parsed = JSON.parse(raw) as unknown;
		return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

function pickString(args: Record<string, unknown> | null, keys: readonly string[]): string | null {
	if (args === null) return null;
	for (const key of keys) {
		const value = args[key];
		if (typeof value === "string" && value.trim() !== "") return value.trim();
	}
	return null;
}

/** 绝对路径折成相对工作区；工作区外的原样返回并标记 */
function relativeTo(workspace: string, path: string): { label: string; outside: boolean } {
	if (workspace === "") return { label: path, outside: false };
	const root = workspace.endsWith("/") ? workspace : `${workspace}/`;
	if (path === workspace) return { label: ".", outside: false };
	if (path.startsWith(root)) return { label: path.slice(root.length), outside: false };
	// 相对路径（pi 的 write/edit 经常直接给相对路径）原样用
	if (!path.startsWith("/")) return { label: path, outside: false };
	return { label: path, outside: true };
}

function clip(text: string, max = MAX_LABEL): string {
	const oneLine = text.replace(/\s+/g, " ").trim();
	return oneLine.length > max ? `${oneLine.slice(0, max)}…` : oneLine;
}

/**
 * 收集一轮消息里的产出。
 * `messages` 只要这一轮的那几条（宿主按"开工时的消息下标"切好再传进来）。
 */
export function collectArtifacts(messages: readonly UiMessage[], workspace: string): CanvasArtifact[] {
	const files: CanvasArtifact[] = [];
	const commands: CanvasArtifact[] = [];
	const seenPaths = new Set<string>();

	for (const message of messages) {
		if (message.role !== "assistant") continue;
		for (const block of message.blocks) {
			if (block.kind !== "tool" || block.status !== "ok") continue;
			const args = argsOf(block);

			if (WRITE_TOOL.test(block.name)) {
				const path = pickString(args, PATH_KEYS);
				if (path === null) continue;
				const { label, outside } = relativeTo(workspace, path);
				if (seenPaths.has(label)) continue;
				seenPaths.add(label);
				files.push({ kind: "file", label, ...(outside ? { detail: "工作区外" } : {}) });
				continue;
			}

			if (COMMAND_TOOL.test(block.name)) {
				const command = pickString(args, COMMAND_KEYS) ?? block.argsSummary;
				if (command === null || command.trim() === "") continue;
				const exit = block.exitCode;
				commands.push({
					kind: "command",
					label: clip(command),
					...(typeof exit === "number" && exit !== 0 ? { detail: `退出码 ${exit}` } : {}),
				});
			}
		}
	}

	// 文件在前（"做出了什么"比"跑了什么"更值得看）
	const merged = [...files, ...commands].slice(0, MAX_ARTIFACTS);
	if (merged.length > 0) return merged;

	// 一条都没有：把最后一段回复当摘要（研究/排查类的步骤往往只有结论）
	for (let index = messages.length - 1; index >= 0; index -= 1) {
		const message = messages[index];
		if (message === undefined || message.role !== "assistant") continue;
		const text = message.blocks
			.filter((block): block is Extract<MessageBlock, { kind: "text" }> => block.kind === "text")
			.map((block) => block.text)
			.join(" ")
			.trim();
		if (text !== "") return [{ kind: "note", label: clip(text, 160) }];
	}
	return [];
}
