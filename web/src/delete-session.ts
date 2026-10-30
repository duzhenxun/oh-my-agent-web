/**
 * 删除会话 = **真删**（服务端 `unlink` 掉会话文件，不可恢复）。
 *
 * 界面上只有这一种删除（用户 2026-10-30：「不要删除，只要彻底删除」）：
 * 以前两颗并存 —— 一颗只把文件改名成 `.deleted-时间戳`、另一颗才真删 —— 名字上分不出区别，
 * 存了 207 个「已删除」的文件、469MB 却谁都不知道。现在只留真删那颗，按钮就叫「彻底删除」。
 * 服务端仍然两种模式都支持（`purge` 是可选参数）：这里一律带上。
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
import { forgetDraft } from "./store.ts";
import { showToast } from "./toast.ts";
import { requestState } from "./ws.ts";

type RemoveOutcome = { ok: true; mode?: string } | { ok: false; message: string };

async function removeOne(id: string): Promise<RemoveOutcome> {
	void forgetCachedMessages(id); // 本地缓存的正文也一并删掉
	try {
		const response = await fetch("/api/sessions/delete", {
			method: "POST",
			headers: { "content-type": "application/json" },
			// 一律真删：界面上没有「只改名」那条路了
			body: JSON.stringify({ id, purge: true }),
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
		// 服务端回的 mode 要看一下：`purged` = 真删了，`file` = 只是改名
		const body = (await response.json().catch(() => null)) as { mode?: string } | null;
		return { ok: true, mode: body?.mode };
	} catch (error) {
		return { ok: false, message: error instanceof Error ? error.message : String(error) };
	}
}

/**
 * 「要了 purge，服务端却只给 file」= 对面还是旧版本（没有 purge 参数）。
 *
 * 不提醒的话：界面上说「已彻底删除」，磁盘上其实只改了个名 —— 跟以前一模一样。
 * 一句话把真相说出来，别让人以为真删了（重启服务端之后就没了）。
 */
const STALE_SERVER = "服务端还是旧版本：只改了名、没真删（重启服务后重试，或先把控制台里的服务端重构一下）";

/** 删一条（确认已经在上层做过）：成功就刷新列表，失败把原因说出来 */
export function deleteSession(id: string, label: string): void {
	void (async () => {
		const result = await removeOne(id);
		if (!result.ok) {
			showToast({ text: `彻底删除「${label}」失败：${result.message}`, ttl: 12_000 });
			return;
		}
		// 会话没了，它那一格输入框草稿也别留着（否则 id 再被生成时会凭空顶出一句旧话，见 `forgetDraft`）
		forgetDraft(id);
		if (result.mode === "file") showToast({ text: `「${label}」${STALE_SERVER}`, ttl: 12_000 });
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
		let staleServer = false;
		const failures: string[] = [];
		for (const id of ids) {
			const result = await removeOne(id);
			if (result.ok) {
				done += 1;
				forgetDraft(id);
				if (result.mode === "file") staleServer = true;
			} else failures.push(result.message);
		}
		requestState();
		if (staleServer) showToast({ text: `${done} 条${STALE_SERVER}`, ttl: 12_000 });
		if (failures.length > 0) {
			showToast({
				text: `彻底删除${label}：成功 ${done} 条，失败 ${failures.length} 条（${failures[0]}）`,
				ttl: 12_000,
			});
		}
	})();
}
