/**
 * 访问鉴权（ADR-0031）：本机直连放行，**其它来源必须输密码**。
 *
 * 为什么用 Basic 而不是自建登录页：浏览器原生弹窗、不占代码、也不用管 cookie 过期；
 * 同一次输入对 HTTP 与 WS 握手都生效（`Authorization` 头两边都有）。
 *
 * 判定顺序（先便宜后贵）：
 *   1. 来源是本机回环 → 放行（本地开发不该被打断输密码）
 *   2. 没设 `AGENT_WEB_PASSWORD` → **远程一律 403**（不给登录框：没有密码就没法远程进）
 *   3. 带 Basic 凭据且密码正确 → 放行
 *   4. 其它 → 401 + `WWW-Authenticate`，浏览器弹窗
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { BRAND_NAME } from "../brand.js";

export const AUTH_REALM = BRAND_NAME;

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
function sameSecret(a: string, b: string): boolean {
	const left = Buffer.from(a);
	const right = Buffer.from(b);
	if (left.length !== right.length) return false;
	return timingSafeEqual(left, right);
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
	if (token !== null && sameSecret(token, cookieToken(input.password))) return "allow";
	const provided = passwordFromHeader(input.authorization);
	return provided !== null && sameSecret(provided, input.password) ? "allow" : "challenge";
}

/** Express 中间件：不通过就 401（浏览器会弹原生登录框） */
export function authMiddleware(password: string | null) {
	return (
		request: { headers: Record<string, string | string[] | undefined>; socket: { remoteAddress?: string } },
		response: {
			setHeader: (name: string, value: string) => void;
			status: (code: number) => { end: (body?: string) => void };
		},
		next: () => void,
	) => {
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
			// 登录过一次就种 cookie：WS 握手不一定带 Basic，但一定带 cookie
			if (password) {
				response.setHeader(
					"Set-Cookie",
					`${AUTH_COOKIE}=${cookieToken(password)}; Path=/; HttpOnly; SameSite=Lax; Max-Age=604800`,
				);
			}
			next();
			return;
		}
		if (decision === "forbid") {
			response.status(403).end("未设置 AGENT_WEB_PASSWORD：本服务不开放远程访问\n");
			return;
		}
		response.setHeader("WWW-Authenticate", `Basic realm="${AUTH_REALM}", charset="UTF-8"`);
		response.status(401).end("需要密码：请在弹出的登录框里输入访问密码\n");
	};
}
