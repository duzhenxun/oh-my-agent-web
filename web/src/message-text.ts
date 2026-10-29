/**
 * 消息里的纯文本（复制、从斜杠命令取"最后一条回复"、从此处编辑都用它）。
 *
 * 单独成文件而不是留在 MessageList 里：斜杠命令（`/copy`）也要用它，
 * 而从组件里 import 会顺带把整张消息列表拉进那条路径。
 */
import type { UiMessage } from "./types.ts";

export function textOfMessage(message: UiMessage): string {
	return message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((text) => text.trim() !== "")
		.join("\n\n");
}
