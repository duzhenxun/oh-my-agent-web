/**
 * 删除会话：二次确认 → 调服务端把文件改名成 `.deleted-时间戳`（可从磁盘恢复）→ 重扫列表。
 * 单独成文件只是为了 Sidebar 守住 400 行。
 */
import { forgetCachedMessages } from "./session-cache.ts";
import { requestState } from "./ws.ts";

export function deleteSession(id: string, label: string): void {
	const ok = window.confirm(
		`删除会话「${label}」？\n\n文件会被改名成 .deleted-时间戳（可从磁盘恢复），列表中不再显示。`,
	);
	if (!ok) return;
	void forgetCachedMessages(id); // 本地缓存的正文也一并删掉
	void fetch("/api/sessions/delete", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ id }),
	}).then(() => requestState());
}

/**
 * 批量删除（归档视图里用）：**只问一次**，然后逐条改名成 `.deleted-时间戳`。
 * 服务端接口是单条的，所以这里顺序发（数量级是几条～几十条，够用）。
 */
export function deleteSessions(ids: string[], label = "选中的会话"): void {
	if (ids.length === 0) return;
	const ok = window.confirm(
		`删除${label}（共 ${ids.length} 条）？\n\n文件会被改名成 .deleted-时间戳（可从磁盘恢复），列表中不再显示。`,
	);
	if (!ok) return;
	void (async () => {
		for (const id of ids) {
			void forgetCachedMessages(id); // 本地缓存的正文也一并删掉
			try {
				await fetch("/api/sessions/delete", {
					method: "POST",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ id }),
				});
			} catch {
				// 单条失败不影响其它条
			}
		}
		requestState();
	})();
}
