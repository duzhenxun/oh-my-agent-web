/**
 * 删除会话：调服务端把文件改名成 `.deleted-时间戳`（可从磁盘恢复）。
 *
 * **两条纪律**（都是 2026-10-29「怎么删不掉啊？」那次踩出来的）：
 *
 * 1. **不用 `window.confirm`**。浏览器可以把整页的原生对话框屏蔽掉（Chrome 那个
 *    「阻止此页面创建更多对话框」勾上之后，`confirm` 永远返回 false），那时按钮点下去
 *    一声不响、什么都不做 —— 用户看到的就是「删不掉」，还查不到原因。
 *    确认那一步改在**菜单里**做（第一下上膛「再点一次确认」，第二下才真删），见
 *    `ProjectMenu` / `SessionMenu` / `ArchivedSessions`。
 * 2. **失败要说话**。以前 `fetch(...)` 不看 `response.ok`、`catch` 也是空的，
 *    服务端 404/500 跟「成功」长得一模一样（列表刷新后还在，看着像没反应）。
 *    现在把服务端给的原因原样塞进一条轻提示。
 */
import { forgetCachedMessages } from "./session-cache.ts";
import { showToast } from "./toast.ts";
import { requestState } from "./ws.ts";

type RemoveOutcome = { ok: true } | { ok: false; message: string };

async function removeOne(id: string): Promise<RemoveOutcome> {
	void forgetCachedMessages(id); // 本地缓存的正文也一并删掉
	try {
		const response = await fetch("/api/sessions/delete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			body: JSON.stringify({ id }),
		});
		if (!response.ok) {
			const body = (await response.json().catch(() => null)) as {
				error?: { code?: string; message?: string };
			} | null;
			/**
			 * 「这条会话已经不在」不算失败：目标状态已经达成（幂等删除）。
			 * 服务端现在会直接回 ok（并清掉内存里的残留），但老服务端仍可能回 404，
			 * 所以这里也收一下 —— 否则批量删会弹一条「失败 1 条」，而那个项目其实已经被清空了。
			 */
			if (response.status === 404 || body?.error?.code === "session.not_found") return { ok: true };
			return { ok: false, message: body?.error?.message ?? `HTTP ${response.status}` };
		}
		return { ok: true };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/** 删一条（确认已经在上层做过）：成功就刷新列表，失败把原因说出来 */
export function deleteSession(id: string, label: string): void {
	void (async () => {
		const result = await removeOne(id);
		if (!result.ok) {
			showToast({ text: `删除「${label}」失败：${result.message}`, ttl: 12_000 });
			return;
		}
		requestState();
	})();
}

/**
 * 批量删（归档视图的「删除选中」/ 项目菜单的「删除全部会话」）。
 * 服务端接口是单条的，所以顺序发；有一条失败不影响其它条，最后统一收口一条提示。
 */
export function deleteSessions(ids: string[], label = "选中的会话"): void {
	if (ids.length === 0) return;
	void (async () => {
		let done = 0;
		const failures: string[] = [];
		for (const id of ids) {
			const result = await removeOne(id);
			if (result.ok) done += 1;
			else failures.push(result.message);
		}
		requestState();
		if (failures.length > 0) {
			showToast({
				text: `删除${label}：成功 ${done} 条，失败 ${failures.length} 条（${failures[0]}）`,
				ttl: 12_000,
			});
		}
	})();
}
