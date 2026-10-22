/**
 * 访问鉴权（ADR-0031，2026-10 修订）：本机直连放行，**其它来源必须输密码**。
 *
 * 登录界面是**自己渲染的页面**（`login-page.ts`），不再用浏览器原生 Basic 弹窗：
 * `POST /api/auth/login` 校验密码后种一张 **7 天**的 cookie（`auth-routes.ts`），
 * 页面 / 静态资源 / API / WS 握手全都认这张 cookie。
 * Basic 头仍然接受（curl、脚本、老客户端都还在用），只是不再拿它去触发弹窗。
 *
 * 判定顺序（先便宜后贵）：
 *   1. 来源是本机回环 → 放行（本地开发不该被打断输密码）
 *   2. 没设 `AGENT_WEB_PASSWORD` → **远程一律 403**（不给登录页：没有密码就没法远程进）
 *   3. 带有效 cookie 或 Basic 凭据且密码正确 → 放行
 *   4. 其它 → 401
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BRAND_NAME } from "../brand.js";
import { renderLoginPage } from "./login-page.js";

export const AUTH_REALM = BRAND_NAME;

/** 登录状态的保存时长：**7 天**（每次访问顺延） */
export const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * 登录成功后下发的 cookie 值：`sha256(密码)`，不含明文密码。
 *
 * 为什么需要它：**WebSocket 握手不一定带 Basic 凭据**（浏览器只在部分场景复用），
 * 但 cookie 一定会带 —— 有了它，WS 才能稳定通过鉴权。
 */
export const AUTH_COOKIE = "agent-web-auth";
export function cookieToken(password: string): string {
	return createHash("sha256").update(`agent-web:${password}`).digest("hex");
}

/** 登录成功后要写回的 `Set-Cookie`（7 天；HttpOnly：前端读不到也就偷不走） */
export function authCookieHeader(password: string): string {
	return [
		`${AUTH_COOKIE}=${cookieToken(password)}`,
		"Path=/",
		"HttpOnly",
		"SameSite=Lax",
		`Max-Age=${AUTH_COOKIE_MAX_AGE}`,
	].join("; ");
}

/** 清掉登录态（登出 / 密码错误兜底） */
export const CLEAR_AUTH_COOKIE = `${AUTH_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0`;

/**
 * 免鉴权的静态路径（图标 / 清单）。
 *
 * 为什么必须放行：手机「添加到主屏幕」时，iOS 抳 `apple-touch-icon`、Android 抳
 * `manifest` 和清单里的图标，**这些子请求不保证带 Basic 凭据** —— 回 401 设备就
 * 拿不到图，自己生成一个「主题色底 + 首字母」的方块顶上去（蓝底白 A 就是这么来的）。
 * 这些响应里没有任何用户数据（纯图片 / 图标清单），放行不扩大攻击面；
 * `/api/*`、页面本身、WebSocket 仍然一律要过密码。
 */
const PUBLIC_STATIC = /^\/(favicon[^/]*|icons\/.*|apple-touch-icon[^/]*|manifest\.webmanifest)$/;

export function isPublicStaticPath(path: string): boolean {
	return PUBLIC_STATIC.test(path);
}

/** 从 Cookie 头里取登录令牌 */
export function tokenFromCookie(header: string | undefined): string | null {
	if (!header) return null;
	for (const part of header.split(";")) {
		const [name, ...rest] = part.trim().split("=");
		if (name === AUTH_COOKIE) return rest.join("=").trim();
	}
	return null;
}

/** 是否是本机回环地址（IPv4 / IPv6 / IPv4-mapped） */
export function isLoopback(address: string | undefined): boolean {
	if (!address) return false;
	if (address === "::1") return true;
	if (address.startsWith("127.")) return true;
	return address.startsWith("::ffff:127.");
}

/** 常量时间比较（长度不同直接 false，避免泄漏长度以外的信息） */
export function samePassword(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
}

/**
 * 这次请求该不该拿到**登录页**（而不是 401 JSON）？
 *
 * 只认 `text/html`：fetch / EventSource / XHR 的默认 `Accept: *\/*` 必须继续拿 JSON，
 * 否则前端会把一张 HTML 当数据去解析。
 */
export function wantsLoginPage(method: string | undefined, accept: string | undefined): boolean {
	if (method !== "GET" && method !== "HEAD") return false;
	return typeof accept === "string" && accept.includes("text/html");
}

/**
 * 真实来源：本机对端（比如 Vite 反代）带了 `X-Forwarded-For` 时取**最右边**那个。
 *
 * 为什么不是最左边：那个位置客户端可以自己伪造（`X-Forwarded-For: 127.0.0.1` 就冒充本机了）；
 * 最右边是**我们的代理附加的**，才是可信值。同时只在对端本身是回环时才看这个头。
 */
export function effectiveAddress(peer: string | undefined, forwardedFor: string | undefined): string | undefined {
	if (!isLoopback(peer) || !forwardedFor) return peer;
	const parts = forwardedFor
		.split(",")
		.map((part) => part.trim())
		.filter((part) => part !== "");
	const last = parts[parts.length - 1];
	return last ?? peer;
}

/** 从 `Authorization: Basic base64(user:pass)` 里取密码（用户名忽略） */
export function passwordFromHeader(header: string | undefined): string | null {
	if (!header || !header.toLowerCase().startsWith("basic ")) return null;
	const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
	const index = decoded.indexOf(":");
	return index < 0 ? null : decoded.slice(index + 1);
}

/** allow = 放行；challenge = 让浏览器弹登录框；forbid = 直接拒（没设密码时的远程） */
export type AuthDecision = "allow" | "challenge" | "forbid";

export function decide(input: {
	password: string | null;
	remoteAddress: string | undefined;
	authorization: string | undefined;
	/** Cookie 头（WS 握手主要靠它） */
	cookie?: string | undefined;
}): AuthDecision {
	if (isLoopback(input.remoteAddress)) return "allow";
	// 没设密码 = 根本不开放远程（不是"留个空密码"，那样等于谁都能进）
	if (!input.password) return "forbid";
	// 先看 cookie（浏览器加载页面时已经登录过），再看 Basic
	const token = tokenFromCookie(input.cookie);
	if (token !== null && samePassword(token, cookieToken(input.password))) return "allow";
	const provided = passwordFromHeader(input.authorization);
	return provided !== null && samePassword(provided, input.password) ? "allow" : "challenge";
}

/**
 * Express 中间件：本机放行；远程未登录时——**页面请求给登录页**，其余给 401。
 *
 * 不再发 `WWW-Authenticate`：那会让浏览器弹原生框，与自建登录页打架。
 */
export function authMiddleware(options: { password: string | null; brandName?: string }) {
	const { password } = options;
	return (
		request: {
			path: string;
			method?: string;
			headers: Record<string, string | string[] | undefined>;
			socket: { remoteAddress?: string };
		},
		response: {
			setHeader: (name: string, value: string) => void;
			status: (code: number) => { end: (body?: string) => void };
		},
		next: () => void,
	) => {
		// 图标 / 清单：手机加桌面时不带凭据也能取（见 isPublicStaticPath）
		if (isPublicStaticPath(request.path)) {
			next();
			return;
		}
		const authorization = request.headers.authorization;
		const forwarded = request.headers["x-forwarded-for"];
		const cookie = request.headers.cookie;
		const decision = decide({
			password,
			remoteAddress: effectiveAddress(
				request.socket.remoteAddress,
				typeof forwarded === "string" ? forwarded : undefined,
			),
			authorization: typeof authorization === "string" ? authorization : undefined,
			cookie: typeof cookie === "string" ? cookie : undefined,
		});
		if (decision === "allow") {
			// 每次访问都把 7 天重新算起（顺延）；WS / SSE 握手一定带 cookie，Basic 不保证
			if (password) response.setHeader("Set-Cookie", authCookieHeader(password));
			next();
			return;
		}
		if (decision === "forbid") {
			response.setHeader("Content-Type", "text/plain; charset=utf-8");
			response.status(403).end("未设置 AGENT_WEB_PASSWORD：本服务不开放远程访问\n");
			return;
		}
		const accept = request.headers.accept;
		if (wantsLoginPage(request.method, typeof accept === "string" ? accept : undefined)) {
			const page = renderLoginPage(options.brandName ? { brandName: options.brandName } : {});
			response.setHeader("Content-Type", "text/html; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			// connect-src 必须显式放开 'self'：default-src 'none' 会把 fetch 一起禁掉，
			// 表现就是「点了登录没反应」（密码 POST 被浏览器拦下，根本没有请求出去）。
			// form-action 'self' 兜住无 JS 的原生表单提交，两者缺一个登录都会坏。
			response.setHeader(
				"Content-Security-Policy",
				[
					"default-src 'none'",
					"img-src 'self'",
					"style-src 'unsafe-inline'",
					"script-src 'unsafe-inline'",
					"connect-src 'self'",
					"form-action 'self'",
					"base-uri 'none'",
				].join("; "),
			);
			response.status(200).end(page);
			return;
		}
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		response.status(401).end(JSON.stringify({ ok: false, error: "未登录或登录已过期" }));
	};
}
