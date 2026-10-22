/**
 * 登录 / 登出端点（ADR-0031 修订）：自建登录页把密码 POST 到这里。
 *
 * 为什么单独成文件、且**注册在鉴权中间件之前**：密码都还没校验，不能要求先有 cookie。
 * 这两个端点自己只做三件事 —— 比对密码（常量时间）、节流失败次数、种/清 cookie。
 *
 * 登录成功后的 cookie 有效期 **7 天**（`AUTH_COOKIE_MAX_AGE`），且每次通过鉴权的访问都会
 * 顺延一次；7 天不访问才需要重新输密码。
 */
import express, { type Express, type Request } from "express";
import { BRAND_NAME } from "../brand.js";
import { CLEAR_AUTH_COOKIE, authCookieHeader, effectiveAddress, samePassword } from "./auth.js";
import { renderLoginPage } from "./login-page.js";

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

export function registerAuthRoutes(app: Express, options: { password: string | null; brandName?: string }): void {
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
			const password = options.password;
			const html = acceptsHtml(request);
			// 没设密码 = 不开放远程（与本机直连无关：本机根本不需要登录）
			if (!password) {
				response.setHeader("Content-Type", "text/plain; charset=utf-8");
				response.status(403).end("未设置 AGENT_WEB_PASSWORD：本服务不开放远程访问\n");
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

	app.post("/api/auth/logout", (_request, response) => {
		response.setHeader("Set-Cookie", CLEAR_AUTH_COOKIE);
		response.status(204).end();
	});
}
