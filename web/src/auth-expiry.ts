/**
 * 登录态过期后的自愈（ADR-0031 修订）：cookie 7 天没顺延就算过期。
 *
 * 过期之后单纯重连没有意义 —— 服务端只会一直回 401。所以统一做一件事：
 * **跳到独立登录页 `/login`**（服务端那张自包含 HTML，见 `server/http/login-page.ts`）。
 *
 * 为什么是「跳页」而不是「刷新」或「盖个弹框」：
 *   - **刷新**在开发态是死循环：`GET /` 由 Vite 给，永远拿不到服务端的登录页，
 *     空壳一起就又 401 → 再刷新 → 页面**一闪一闪**（用户 2026-10-30 报的就是这个）；
 *   - **弹框**得先把整个 SPA 拉起来（几百个模块）。走隧道访问时那一步就要几十秒，
 *     只是为了让人输一个密码 —— 而 `/login` 是一张十几 KB 的静态页，一秒就出来。
 *
 * 注意区分两种失败：
 *   - 401：登录态问题 → 跳登录页；
 *   - 网络错误 / 5xx：服务端可能只是重启中 → 交给 ws.ts 的退避重连。
 */

/** 登录页地址：已经是它就不再跳（否则「登录页自己被 401」会自己套娃） */
export function loginPageUrl(): string {
	return "/login";
}

/** 跳登录页（`replace`：别在历史里留一条必然 401 的条目，否则手机返回键会来回弹） */
function goLoginPage(): void {
	try {
		if (location.pathname === loginPageUrl()) return;
		location.replace(loginPageUrl());
	} catch {
		// 非浏览器环境（单测）：不做跳转
	}
}

/** 一次请求的状态码是不是「需要重新登录」；是就跳登录页 */
export function reloadIfUnauthorized(status: number): boolean {
	if (status !== 401) return false;
	goLoginPage();
	return true;
}

/**
 * 现在是不是「远程访问」（域名 / 局域网 IP / 隧道）。
 *
 * 判据只看地址：本机直连（localhost / 127.0.0.1 / ::1）**永远免密**，登录态只对远程有意义；
 * 隧道进来时浏览器地址栏写的是域名，所以这一条对它同样成立。
 */
export function isRemoteAccess(): boolean {
	try {
		const hostname = location.hostname.toLowerCase();
		return !(hostname === "localhost" || hostname === "127.0.0.1" || hostname === "::1" || hostname === "[::1]");
	} catch {
		return false; // 非浏览器环境（单测 / SSR）：当成本机，不显示只有远程才有意义的入口
	}
}

/**
 * 退出远程登录：清掉那张 cookie，然后去登录页 —— 服务端会在那里重新问密码。
 *
 * 为什么不能「只把前端 state 清掉」：登录态在服务端的 cookie 里，前端清得再干净，
 * 下一个请求（包括刷新页面、SSE 重连）照样带着那张 cookie 直接进去。
 * 本机访问不走这条路（本机免密，退出后刷新就又在里面了，只会让人以为按钮坏了）。
 */
export function logoutRemote(): void {
	void fetch("/api/auth/logout", { method: "POST" })
		.catch(() => undefined)
		.finally(() => goLoginPage());
}

/**
 * SSE 被 401 掐掉时浏览器**不会重连**，而 EventSource 的 error 事件不告诉我们状态码，
 * 所以拿健康接口探一次：确认是 401 才跳登录页。服务端不可达时什么也不做。
 */
export async function reloadOnExpiredLogin(): Promise<void> {
	try {
		const response = await fetch("/api/health", { cache: "no-store" });
		if (response.status === 401) goLoginPage();
	} catch {
		// 网络层就失败了：不是登录态问题
	}
}
