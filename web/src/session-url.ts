/**
 * 会话与地址栏同步：`?session=<id>`
 *
 * - 打开页面时若带 `?session=`，自动切到那条会话（可以把它当书签分享/自己存着）；
 * - 切换会话时用 `history.replaceState` 更新地址栏（**不产生历史记录**，
 *   否则后退键会在几十条会话之间来回跳，很难用）。
 */
export function sessionIdFromUrl(search: string): string | null {
	const value = new URLSearchParams(search).get("session");
	return value !== null && value.trim() !== "" ? value.trim() : null;
}

/** 生成新的 address（保留其它查询参数与 hash） */
export function sessionUrlFor(href: string, sessionId: string | null): string {
	const url = new URL(href);
	if (sessionId === null) url.searchParams.delete("session");
	else url.searchParams.set("session", sessionId);
	return `${url.pathname}${url.search}${url.hash}`;
}
