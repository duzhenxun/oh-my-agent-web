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
 *   2. 没设 `AGENT_WEB_PASSWORD` → **远程一律不开放**；页面请求给「设置访问密码」页
 *      （不设完密码就没有远程访问，见下方的 forbid 分支）
 *   3. 带有效 cookie 或 Basic 凭据且密码正确 → 放行
 *   4. 其它 → 401
 *
 * 密码是**运行时可改的**（`PasswordStore`）：第一次通过页面设完就落盘并立即生效，不用重启。
 */
import { createHash, timingSafeEqual } from "node:crypto";
import { isAllowedOrigin, isLoopbackHostHeader, isSameOrigin, type OriginPolicy } from "../util/origin.js";
import { renderLoginPage, renderSetupPage } from "./login-page.js";

/** 登录状态的保存时长：**7 天**（每次访问顺延） */
export const AUTH_COOKIE_MAX_AGE = 7 * 24 * 60 * 60;

/**
 * 登录成功后下发的 cookie 值：`sha256(密码)`，不含明文密码。
 *
 * 为什么需要它：**WebSocket 握手不一定带 Basic 凭据**（浏览器只在部分场景复用），
 * 但 cookie 一定会带 —— 有了它，WS 才能稳定通过鉴权。
 */
const AUTH_COOKIE = "agent-web-auth";
function cookieToken(password: string): string {
	return createHash("sha256").update(`agent-web:${password}`).digest("hex");
}

/**
 * 这次请求带的 cookie 是不是「用当前密码登录过」。
 *
 * 给 `/login` 用：已经登录的人再打开登录页，应该直接放回应用 —— 否则会出现
 * 「输了密码、服务器 204 了、页面却又回到登录框」这种看起来没反应的死循环。
 */
export function isAuthenticatedCookie(cookieHeader: string | undefined, password: string | null): boolean {
	if (!password) return false;
	const token = tokenFromCookie(cookieHeader);
	return token !== null && samePassword(token, cookieToken(password));
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

function isPublicStaticPath(path: string): boolean {
	return PUBLIC_STATIC.test(path);
}

/** 从 Cookie 头里取登录令牌 */
function tokenFromCookie(header: string | undefined): string | null {
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
 * 跨源请求到底该不该被拦？—**只拦「真的是本机直连」的**。
 *
 * 为什么只拦本机：本机直连（对端回环 + Host 回环）是**不需要密码**的 —— 那才是 CSRF 的靶子：
 * 浏览器里任何一个网页都能对 `http://127.0.0.1:<port>` 发 no-cors POST（不带 cookie 也能到达），
 * 不带 body 的端点（起终端、停终端……）照样会被执行。
 *
 * 而远程来的请求（域名 / 外网 IP / 局域网 IP）无论跨不跨源都还要过**密码**那道门，
 * 再拿域名白名单卡一道只会误伤：反向代理 / 隧道 / DNS 写法千奇百怪，
 * 很多反代还会把 `Host` 重写成 `127.0.0.1` —— 那时只看 Host 就会把「用自己域名访问」
 * 当成「本机点开」，用户为了能进得去又得去配 `--allow-host`（用户 2026-10-30 明确不要白名单）。
 *
 * 所以判据是 `local`（真实来源是否回环，XFF 已经算过）：
 *   - local = true  → 本机免密码，跨源必须拦；
 *   - local = false → 密码门在后面，跨源一律放行（任何域名 / IP 都能用）。
 */
export function isCrossOriginRejected(input: {
	origin: string | undefined;
	host: string | undefined;
	policy: OriginPolicy | undefined;
	/** 真实来源是不是本机（`effectiveAddress` 的结果 + `isLoopback`）；不给时按旧的「Host 是本机」算 */
	local?: boolean;
}): boolean {
	if (input.local === false) return false; // 远程：密码门在后面，不再拿域名白名单卡
	if (!input.policy || input.origin === undefined) return false; // 非浏览器客户端（curl / 脚本）不发 Origin
	if (!isLoopbackHostHeader(input.host)) return false; // 目标是外面：交给密码门
	return !isSameOrigin(input.origin, input.host) && !isAllowedOrigin(input.origin, input.policy);
}

/**
 * 这次请求该不该拿到**登录页**（而不是 401 JSON）？
 *
 * 只认 `text/html`：fetch / EventSource / XHR 的默认 `Accept: *\/*` 必须继续拿 JSON，
 * 否则前端会把一张 HTML 当数据去解析。
 */
function wantsLoginPage(method: string | undefined, accept: string | undefined): boolean {
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
function passwordFromHeader(header: string | undefined): string | null {
	if (!header || !header.toLowerCase().startsWith("basic ")) return null;
	const decoded = Buffer.from(header.slice(6).trim(), "base64").toString("utf8");
	const index = decoded.indexOf(":");
	return index < 0 ? null : decoded.slice(index + 1);
}

/** allow = 放行；challenge = 让浏览器弹登录框；forbid = 直接拒（没设密码时的远程） */
type AuthDecision = "allow" | "challenge" | "forbid";

export function decide(input: {
	password: string | null;
	remoteAddress: string | undefined;
	/**
	 * `Host` 头：请求**是发往谁的**。
	 *
	 * 必须一起看 —— 同机反代 / 隧道（nginx、cloudflared、tailscale serve…）打过来的连接
	 * 对端永远是 127.0.0.1：只看对端地址的话，「用公网域名访问」会被当成「在本机点开」，
	 * 不打密码就直接进（实测过）。
	 */
	host?: string | undefined;
	authorization: string | undefined;
	/** Cookie 头（WS 握手主要靠它） */
	cookie?: string | undefined;
}): AuthDecision {
	// 只有「对端是本机」**且**「请求就是发给本机的」才算本机直连
	if (isLoopback(input.remoteAddress) && isLoopbackHostHeader(input.host)) return "allow";
	// 没设密码 = 根本不开放远程（不是"留个空密码"，那样等于谁都能进）
	if (!input.password) return "forbid";
	// 先看 cookie（浏览器加载页面时已经登录过），再看 Basic
	const token = tokenFromCookie(input.cookie);
	if (token !== null && samePassword(token, cookieToken(input.password))) return "allow";
	const provided = passwordFromHeader(input.authorization);
	return provided !== null && samePassword(provided, input.password) ? "allow" : "challenge";
}

/** 把一张自建页面发出去（登录 / 设置密码共用一套 CSP） */
function sendHtmlPage(
	response: {
		setHeader: (name: string, value: string) => void;
		status: (code: number) => { end: (body?: string) => void };
	},
	html: string,
): void {
	response.setHeader("Content-Type", "text/html; charset=utf-8");
	response.setHeader("Cache-Control", "no-store");
	// connect-src 必须显式放开 'self'：default-src 'none' 会把 fetch 一起禁掉，
	// 表现就是「点了按钮没反应」（表单 POST 被浏览器拦下，根本没有请求出去）。
	// form-action 'self' 兜住无 JS 的原生表单提交，两者缺一个都会坏。
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
	response.status(200).end(html);
}

/**
 * Express 中间件：本机放行；远程未登录时——**页面请求给登录页**，其余给 401。
 *
 * 不再发 `WWW-Authenticate`：那会让浏览器弹原生框，与自建登录页打架。
 */
export function authMiddleware(options: {
	/** 每次请求现取：密码可以在运行中被设置（首次远程访问的设置页）*/
	getPassword: () => string | null;
	brandName?: string;
	/** 与 WS 握手同一份白名单：HTTP 面也要过同源这道门（见下面的注释） */
	originPolicy?: OriginPolicy;
}) {
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
		// 每次请求现取：密码可能刚在「设置访问密码」页里被设上
		const password = options.getPassword();
		// 先把请求头和真实来源解析好（同源门禁 / `/setup` / decide 三处都要用）
		const originHeader = request.headers.origin;
		const hostHeader = request.headers.host;
		const origin = typeof originHeader === "string" ? originHeader : undefined;
		const host = typeof hostHeader === "string" ? hostHeader : undefined;
		const forwarded = request.headers["x-forwarded-for"];
		const remoteAddress = effectiveAddress(
			request.socket.remoteAddress,
			typeof forwarded === "string" ? forwarded : undefined,
		);

		/**
		 * 本机设置**第一个密码**的入口：`/setup`。
		 *
		 * 为什么需要它：本机直连本来就免密码放行（进的是应用本身），而“远程首次访问时给设置页”
		 * 那个口子现在关掉了（不能由远程定密码）—— 总得有条路能在本机设。只认
		 * 「对端本机 + Host 本机」；反代 / 隧道打进来的（XFF 或非回环 Host）一律不给。
		 */
		if (request.path === "/setup") {
			if (!(isLoopback(remoteAddress) && isLoopbackHostHeader(host))) {
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response
					.status(403)
					.end(JSON.stringify({ ok: false, error: "访问密码只能在运行它的那台机器上设置（或启动时带 --password）" }));
				return;
			}
			if (password) {
				response.setHeader("Location", "/");
				response.status(303).end();
				return;
			}
			sendHtmlPage(
				response,
				renderSetupPage({ ...(options.brandName ? { brandName: options.brandName } : {}), ...(host ? { host } : {}) }),
			);
			return;
		}
		/**
		 * HTTP 面的同源门禁。
		 *
		 * WS 握手一直有这道门，**HTTP 面以前一条都没有** —— 回环地址在 `decide()` 里是无条件放行的，
		 * 于是浏览器里任何一个网页都能对 `http://127.0.0.1:<port>` 发 no-cors POST：
		 *   `<script>fetch('http://127.0.0.1:25257/api/terminal/start',{method:'POST',mode:'no-cors'})</script>`
		 * no-cors 的请求**不带 cookie 也能到达服务端**，所以 `SameSite=Lax` 挡不住它；
		 * 不带 body 的端点（起终端、停终端、启动订阅登录…）照样会被执行。
		 *
		 * 规则：同源（Origin 与 Host 一致）直接放行；跨源必须在白名单里；
		 * 不带 Origin 的放行（curl / 脚本 / 老客户端不发这个头）。
		 */
		if (isCrossOriginRejected({ origin, host, policy: options.originPolicy, local: isLoopback(remoteAddress) })) {
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.status(403).end(JSON.stringify({ ok: false, error: "跨站请求被拒绝：Origin 不在允许的来源里" }));
			return;
		}
		const authorization = request.headers.authorization;
		const cookie = request.headers.cookie;
		const decision = decide({
			password,
			// 复用上面已经解析好的 host（同源校验那段也要用）
			host,
			remoteAddress,
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
			/**
			 * 没设密码：远程一律不开放，**而且不能由远程把密码定下来**。
			 *
			 * 以前这个「设置访问密码」页对谁都渲染 —— 等于「谁先扫到这个端口谁就把密码定成自己的」，
			 * 端口一暴露就被人接管。现在只有**本机**能设：远程只拿到一句「先在本机设好」。
			 */
			const local = isLoopback(remoteAddress);
			if (
				wantsLoginPage(request.method, typeof request.headers.accept === "string" ? request.headers.accept : undefined)
			) {
				const page = renderSetupPage({
					...(options.brandName ? { brandName: options.brandName } : {}),
					...(local ? {} : { locked: true }),
				});
				sendHtmlPage(response, page);
				return;
			}
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.status(403).end(
				JSON.stringify({
					ok: false,
					error: local
						? "还没设访问密码：先用浏览器打开一次设置密码，或启动时带 --password"
						: "还没设访问密码：只能在本机（127.0.0.1）打开设置它，或启动时带 --password",
				}),
			);
			return;
		}
		const accept = request.headers.accept;
		if (wantsLoginPage(request.method, typeof accept === "string" ? accept : undefined)) {
			sendHtmlPage(response, renderLoginPage(options.brandName ? { brandName: options.brandName } : {}));
			return;
		}
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		response.status(401).end(JSON.stringify({ ok: false, error: "未登录或登录已过期" }));
	};
}
