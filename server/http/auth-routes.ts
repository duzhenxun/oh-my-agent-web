/**
 * 登录 / 登出端点（ADR-0031 修订）：自建登录页把密码 POST 到这里。
 *
 * 为什么单独成文件、且**注册在鉴权中间件之前**：密码都还没校验，不能要求先有 cookie。
 * 这两个端点自己只做三件事 —— 比对密码（常量时间）、节流失败次数、种/清 cookie。
 *
 * 登录成功后的 cookie 有效期 **7 天**（`AUTH_COOKIE_MAX_AGE`），且每次通过鉴权的访问都会
 * 顺延一次；7 天不访问才需要重新输密码。
 *
 * `/api/auth/setup`：**还没设过密码时**才开放，用来在页面上设第一个密码（设完就种 cookie 进入）。
 * 已经有密码时一律 409 —— 否则谁都能把密码改掉。
 *
 * `/api/auth/password`（GET 状态 / POST 设置或修改）：**只认本机**（对端回环 + Host 回环）。
 * 这是「设置 → 远程」里那个密码输入框用的。之所以要单独一条而不是复用 `/setup`：
 * `/setup` 只管“第一个密码”，已经有密码时 409；而用户要的是“本机随时能改”。
 * 密码落盘在 `<dataDir>/password`（`~/.oh-my-agent-web/password`），改完立即生效、不用重启。
 */
import express, { type Express, type Request } from "express";
import { BRAND_NAME } from "../brand.js";
import { isLoopbackHostHeader, isSameOrigin } from "../util/origin.js";
import {
	CLEAR_AUTH_COOKIE,
	authCookieHeader,
	effectiveAddress,
	isAuthenticatedCookie,
	isLoopback,
	samePassword,
} from "./auth.js";
import { renderLoginPage, renderSetupPage } from "./login-page.js";

/** 密码长度上下限：设密码时挡一下手滑（登录只比对，不做长度限制） */
const MIN_PASSWORD_CHARS = 4;
const MAX_PASSWORD_CHARS = 200;

/** 失败节流窗口与上限：同一来源 10 分钟内失败 20 次就从这里起拒收（挡在线爆破） */
const FAILURE_WINDOW_MS = 10 * 60_000;
const MAX_FAILURES = 20;
const MAX_TRACKED_SOURCES = 512;

type Attempt = { count: number; resetAt: number };

function addressOf(request: Request): string {
	const forwarded = request.headers["x-forwarded-for"];
	return (
		effectiveAddress(request.socket.remoteAddress, typeof forwarded === "string" ? forwarded : undefined) ?? "unknown"
	);
}

function acceptsHtml(request: Request): boolean {
	const accept = request.headers.accept;
	return typeof accept === "string" && accept.includes("text/html");
}

/**
 * 「真正在本机上」：对端是回环 **且** Host 也是回环。
 *
 * 为什么两个都要：同机反代 / 隧道打过来的连接对端也是 127.0.0.1（见 `auth.ts` 的注释），
 * 只看对端就等于「用域名访问的人也能改密码」。密码管理只应该发生在运行服务的这台机器上。
 */
function isLocalRequest(request: Request): boolean {
	const host = request.headers.host;
	return isLoopback(addressOf(request)) && isLoopbackHostHeader(typeof host === "string" ? host : undefined);
}

/**
 * 浏览器跨站请求：挡一道。
 *
 * 这些端点注册在鉴权中间件**之前**，所以 `authMiddleware` 里那道 HTTP 同源门禁管不到它们。
 * 不拦的话，任何网页都能对你本机的 `http://127.0.0.1:<port>/api/auth/setup` 发一个
 * 表单 POST —— 本机免密 + 表单是简单请求（不触发预检）就能把密码定成攻击者的。
 * 带 Origin 且与 Host 不同源 → 拒；不带 Origin（curl / 脚本 / 老客户端）→ 放行。
 */
function crossSite(request: Request): boolean {
	const origin = request.headers.origin;
	const host = request.headers.host;
	if (typeof origin !== "string" || origin === "") return false;
	return !isSameOrigin(origin, typeof host === "string" ? host : undefined);
}

export function registerAuthRoutes(
	app: Express,
	options: {
		/** 每次现取：密码可以在运行中被设上（见 /api/auth/setup） */
		getPassword: () => string | null;
		/** 落盘 + 立即生效（由 `createPasswordStore` 提供） */
		setPassword: (password: string) => Promise<void>;
		brandName?: string;
	},
): void {
	const brandName = options.brandName ?? BRAND_NAME;
	const attempts = new Map<string, Attempt>();

	/**
	 * 独立登录页：一张自包含 HTML（`login-page.ts`），不依赖前端构建产物。
	 *
	 * 为什么需要这条路径（生产态未登录时直接 `GET /` 就给这张页，用不上它）：
	 *   - **开发态 `GET /` 是 Vite 给的**，服务端渲染的登录页永远出不来。前端一拿 401 就跳到这里，
	 *     于是「未登录」只花一张十几 KB 的静态页，而不是把整个 SPA（几百个模块）拉起来 ——
	 *     走隧道 / 手机网络上这是 **几秒 vs 几十秒**的差别；
	 *   - 中途过期时也能直接指过来，不必经过一次空壳启动。
	 *
	 * 没设密码时给的是「设密码」页（远程只显示「去本机设」），与 `GET /` 的兜底一致。
	 */
	app.get("/login", (request, response) => {
		const password = options.getPassword();
		// 已经登录的人打开登录页 → 直接回应用。少了这一条，登录页在 `/login` 上刷新自己
		// 就会「登录成功后又看到登录框」，看着像没登录上（用户 2026-10-30 实测遇到）。
		if (isAuthenticatedCookie(request.headers.cookie, password)) {
			response.status(303).setHeader("Location", "/").end();
			return;
		}
		response.setHeader("Content-Type", "text/html; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		if (password) {
			response.status(200).end(renderLoginPage({ brandName }));
			return;
		}
		const host = request.headers.host;
		response.status(200).end(
			renderSetupPage({
				brandName,
				...(typeof host === "string" ? { host } : {}),
				// 只有真的在本机才给设置表单（远程先在本机设好，不能让「谁先打开谁定密码」）
				...(isLocalRequest(request) ? {} : { locked: true }),
			}),
		);
	});

	/** 失败计数（顺手清掉过期的，避免 Map 只增不减） */
	function noteFailure(address: string, now: number): void {
		const current = attempts.get(address);
		if (!current || now > current.resetAt) {
			if (attempts.size >= MAX_TRACKED_SOURCES) {
				for (const [key, value] of attempts) if (now > value.resetAt) attempts.delete(key);
			}
			attempts.set(address, { count: 1, resetAt: now + FAILURE_WINDOW_MS });
			return;
		}
		current.count += 1;
	}

	function throttled(address: string, now: number): boolean {
		const current = attempts.get(address);
		if (!current) return false;
		if (now > current.resetAt) {
			attempts.delete(address);
			return false;
		}
		return current.count >= MAX_FAILURES;
	}

	app.post(
		"/api/auth/login",
		express.urlencoded({ extended: false, limit: "2kb" }),
		express.json({ limit: "2kb" }),
		(request, response) => {
			const password = options.getPassword();
			const html = acceptsHtml(request);
			// 没设密码：还没开始远程访问（引导访客去设置页）
			if (!password) {
				const error = "还没设访问密码：先设置一个再登录";
				if (html) {
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.setHeader("Cache-Control", "no-store");
					response.status(409).end(renderLoginPage({ brandName, error }));
					return;
				}
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response.status(409).end(JSON.stringify({ ok: false, error }));
				return;
			}
			const address = addressOf(request);
			const now = Date.now();
			if (throttled(address, now)) {
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.status(429).end(JSON.stringify({ ok: false, error: "尝试次数过多，请稍后再试" }));
				return;
			}
			const body = request.body as { password?: unknown } | undefined;
			const submitted = typeof body?.password === "string" ? body.password : "";
			if (submitted === "" || !samePassword(submitted, password)) {
				noteFailure(address, now);
				const error = "密码不正确";
				if (html) {
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.setHeader("Cache-Control", "no-store");
					response.status(401).end(renderLoginPage({ brandName, error }));
					return;
				}
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response.status(401).end(JSON.stringify({ ok: false, error }));
				return;
			}
			attempts.delete(address);
			response.setHeader("Set-Cookie", authCookieHeader(password));
			// 无 JS 的表单提交：种完 cookie 直接跳回首页（不采信任何外部传入的 next，避免开放重定向）
			if (html) {
				response.redirect(303, "/");
				return;
			}
			response.setHeader("Cache-Control", "no-store");
			response.status(204).end();
		},
	);

	app.post(
		"/api/auth/setup",
		express.urlencoded({ extended: false, limit: "2kb" }),
		express.json({ limit: "2kb" }),
		async (request, response) => {
			const html = acceptsHtml(request);
			const reject = (status: number, error: string) => {
				if (html) {
					response.setHeader("Content-Type", "text/html; charset=utf-8");
					response.setHeader("Cache-Control", "no-store");
					response.status(status).end(renderLoginPage({ brandName, error }));
					return;
				}
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response.status(status).end(JSON.stringify({ ok: false, error }));
			};
			// 跨站表单能把密码定成别人的（见 crossSite 注释）——先拦下
			if (crossSite(request)) {
				reject(403, "跨站请求被拒绝：密码只能在本机页面上设置");
				return;
			}
			// 已经有密码：这是「改密码」的事，不归这个端点管（否则谁都能把密码改掉）
			if (options.getPassword()) {
				reject(409, "已经设置过访问密码了，直接用密码登录");
				return;
			}
			/**
			 * **第一个密码只能在本机定**（或启动时 `-P`）。
			 *
			 * 不拦的话：端口一暴露，谁先扫到谁设一个自己的密码，等于直接接管这台机器
			 * （能跑 shell、能读项目文件）。这里用**真实来源**判定：本机反代带过来的
			 * `X-Forwarded-For` 会被 `addressOf` 取最右边那个（可信值），所以经反代进来的远程
			 * 访问会被认成远程，不会因为对端是 127.0.0.1 就当成「本机」。
			 */
			if (!isLoopback(addressOf(request))) {
				reject(403, "还没设访问密码：只能在本机（127.0.0.1）设置它，或启动时带 --password");
				return;
			}
			const address = addressOf(request);
			const now = Date.now();
			if (throttled(address, now)) {
				reject(429, "请求过于频繁，请稍后再试");
				return;
			}
			const body = request.body as { password?: unknown } | undefined;
			const submitted = typeof body?.password === "string" ? body.password.trim() : "";
			// 空白字符会破坏「密码存一行」的落盘格式，一律不收
			if (submitted.length < MIN_PASSWORD_CHARS) {
				noteFailure(address, now);
				reject(400, `密码至少 ${MIN_PASSWORD_CHARS} 位`);
				return;
			}
			if (submitted.length > MAX_PASSWORD_CHARS) {
				reject(400, `密码最多 ${MAX_PASSWORD_CHARS} 位`);
				return;
			}
			try {
				await options.setPassword(submitted);
			} catch {
				reject(500, "密码保存失败（数据目录不可写？）");
				return;
			}
			attempts.delete(address);
			response.setHeader("Set-Cookie", authCookieHeader(submitted));
			if (html) {
				response.redirect(303, "/");
				return;
			}
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.status(200).end(JSON.stringify({ ok: true }));
		},
	);

	/**
	 * 访问密码的状态与修改（「设置 → 远程」里的那个输入框）。
	 *
	 * 只认本机：远程（含隧道 / 同机反代）一律 403 —— 密码只能在运行服务的这台机器上定。
	 * GET 只回「设没设」这个布尔值，**绝不回显密码本身**。
	 */
	app.get("/api/auth/password", (request, response) => {
		// 跨站页面不该能探到「这台机器有没有设密码」——一并挡掉
		if (crossSite(request) || !isLocalRequest(request)) {
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.status(403).end(JSON.stringify({ ok: false, error: "只能在运行服务的这台机器上查看" }));
			return;
		}
		response.setHeader("Content-Type", "application/json; charset=utf-8");
		response.setHeader("Cache-Control", "no-store");
		response.status(200).end(JSON.stringify({ ok: true, set: Boolean(options.getPassword()) }));
	});

	app.post(
		"/api/auth/password",
		express.urlencoded({ extended: false, limit: "2kb" }),
		express.json({ limit: "2kb" }),
		async (request, response) => {
			const reject = (status: number, error: string) => {
				response.setHeader("Content-Type", "application/json; charset=utf-8");
				response.setHeader("Cache-Control", "no-store");
				response.status(status).end(JSON.stringify({ ok: false, error }));
			};
			if (crossSite(request)) {
				reject(403, "跨站请求被拒绝：密码只能在本机页面上设置");
				return;
			}
			if (!isLocalRequest(request)) {
				reject(403, "访问密码只能在运行服务的这台机器上（127.0.0.1）设置");
				return;
			}
			const address = addressOf(request);
			const now = Date.now();
			if (throttled(address, now)) {
				reject(429, "请求过于频繁，请稍后再试");
				return;
			}
			const body = request.body as { password?: unknown } | undefined;
			const submitted = typeof body?.password === "string" ? body.password.trim() : "";
			// 空白字符会破坏「密码存一行」的落盘格式，一律不收
			if (submitted.length < MIN_PASSWORD_CHARS) {
				noteFailure(address, now);
				reject(400, `密码至少 ${MIN_PASSWORD_CHARS} 位`);
				return;
			}
			if (submitted.length > MAX_PASSWORD_CHARS) {
				reject(400, `密码最多 ${MAX_PASSWORD_CHARS} 位`);
				return;
			}
			try {
				await options.setPassword(submitted);
			} catch {
				reject(500, "密码保存失败（数据目录不可写？）");
				return;
			}
			attempts.delete(address);
			// 顺手给本机也种上 cookie：改完密码不用重新登录（本机本来也免密码，这里只是保持一致）
			response.setHeader("Set-Cookie", authCookieHeader(submitted));
			response.setHeader("Content-Type", "application/json; charset=utf-8");
			response.setHeader("Cache-Control", "no-store");
			response.status(200).end(JSON.stringify({ ok: true, set: true }));
		},
	);

	app.post("/api/auth/logout", (_request, response) => {
		response.setHeader("Set-Cookie", CLEAR_AUTH_COOKIE);
		response.status(204).end();
	});
}
