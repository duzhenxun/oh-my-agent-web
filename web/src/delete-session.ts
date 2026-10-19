/**
 * 删除会话：二次确认 → 调服务端把文件改名成 `.deleted-时间戳`（可从磁盘恢复）→ 重扫列表。
 * 单独成文件只是为了 Sidebar 守住 400 行。
 */
import { requestState } from "./ws.ts";

export function deleteSession(id: string, label: string): void {
	const ok = window.confirm(
		`删除会话「${label}」？\n\n文件会被改名成 .deleted-时间戳（可从磁盘恢复），列表中不再显示。`,
	);
	if (!ok) return;
	void fetch("/api/sessions/delete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	}).then(() => requestState());
}
