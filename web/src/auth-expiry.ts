/**
 * 登录态过期后的自愈（ADR-0031 修订）：cookie 7 天没顺延就算过期。
 *
 * 过期之后单纯重连没有意义 —— 服务端只会一直回 401。所以这里统一做一件事：
 * **整页刷新**，让服务端把自建登录页渲染出来（页面请求与接口请求是两套响应）。
 *
 * 注意区分两种失败：
 *   - 401：登录态问题 → 刷新（刷新后会看到登录页，而不是一个卡住的空壳）；
 *   - 网络错误 / 5xx：服务端可能只是重启中 → 交给 ws.ts 的退避重连。
 */

/** 一次请求的状态码是不是「需要重新登录」；是就立刻刷新整页 */
export function reloadIfUnauthorized(status: number): boolean {
	if (status !== 401) return false;
	location.reload();
	return true;
}

/**
 * SSE 被 401 掐掉时浏览器**不会重连**，而 EventSource 的 error 事件不告诉我们状态码，
 * 所以拿健康接口探一次：确认是 401 才刷新。服务端不可达时什么也不做。
 */
export async function reloadOnExpiredLogin(): Promise<void> {
	try {
		const response = await fetch("/api/health", { cache: "no-store" });
		if (response.status === 401) location.reload();
	} catch {
		// 网络层就失败了：不是登录态问题
	}
}
