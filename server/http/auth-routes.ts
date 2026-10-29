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
 */
import express, { type Express, type Request } from "express";
import { BRAND_NAME } from "../brand.js";
import { CLEAR_AUTH_COOKIE, authCookieHeader, effectiveAddress, samePassword } from "./auth.js";
import { renderLoginPage } from "./login-page.js";

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
			// 已经有密码：这是「改密码」的事，不归这个端点管（否则谁都能把密码改掉）
			if (options.getPassword()) {
				reject(409, "已经设置过访问密码了，直接用密码登录");
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

	app.post("/api/auth/logout", (_request, response) => {
		response.setHeader("Set-Cookie", CLEAR_AUTH_COOKIE);
		response.status(204).end();
	});
}
