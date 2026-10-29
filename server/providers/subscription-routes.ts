/**
 * 订阅服务（OAuth）的 HTTP 路由。
 *
 * 和 provider 配置（models.json / auth.json 的 API key）是两条路：这里是「用你的
 * ChatGPT Plus/Pro、Claude Pro/Max 订阅额度」，凭据由**引擎自己**写进 auth.json，
 * 宿主只做三件事：把引擎要问的话搬给浏览器、把浏览器的答案搬回去、登录完重载模型表。
 *
 * 为什么用 SSE 而不是走 WS：一条登录可能挂着十分钟（设备码），单独一条流更容易
 * 取消（浏览器关标签页 → `close` → abort → SDK 的 login 拒绝），也不用给协议加新帧。
 */
import { randomUUID } from "node:crypto";
import type { Express, Request, Response } from "express";
import type { ProviderAuthEvent, ProviderAuthPort } from "../engine/port.js";

/** 引擎正在等用户回话的一句提问（token 由宿主发，用户带回来时用来配对） */
type PendingPrompt = {
	provider: string;
	resolve: (value: string) => void;
	reject: (error: Error) => void;
};

/**
 * 进程内的配对表。单用户工作台，一个进程一份就够；
 * token 用 `provider-uuid` 形状，回来时校验前缀，别的 provider 的 token 用不了。
 */
const pendingPrompts = new Map<string, PendingPrompt>();

function errorMessage(cause: unknown): string {
	return cause instanceof Error ? cause.message : String(cause);
}

export function registerSubscriptionRoutes(
	app: Express,
	options: {
		/** 引擎不实现订阅服务时传 undefined：列表返回空，登录/登出直接 501 */
		providerAuth: ProviderAuthPort | undefined;
		notify: (text: string, level?: "info" | "warn" | "error") => void;
		/** 登录 / 登出后：重载模型表 + 重推快照（宿主装配） */
		refresh: () => Promise<void>;
		log?: (message: string, meta?: Record<string, unknown>) => void;
	},
): void {
	const providerAuth = options.providerAuth;

	// GET /api/subscriptions —— 界面上一张卡片一条
	app.get("/api/subscriptions", async (_request: Request, response: Response) => {
		if (!providerAuth) {
			response.json({ providers: [] });
			return;
		}
		try {
			response.setHeader("cache-control", "no-store");
			response.json({ providers: await providerAuth.list() });
		} catch (cause) {
			options.log?.("订阅服务列表读取失败", { message: errorMessage(cause) });
			response.status(500).json({ error: { message: errorMessage(cause) } });
		}
	});

	// GET /api/subscriptions/:provider/login —— 登录全过程（SSE）
	app.get("/api/subscriptions/:provider/login", async (request: Request, response: Response) => {
		const provider = String(request.params.provider ?? "");
		if (!providerAuth) {
			response.status(501).json({ error: { message: "当前引擎不支持订阅登录" } });
			return;
		}

		const abort = new AbortController();
		/** 本次登录发出的 token：取消/结束时统一 reject，否则 SDK 的 login 挂在那里不退 */
		const tokens = new Set<string>();
		let closed = false;

		const rejectAll = (reason: Error) => {
			for (const token of tokens) {
				pendingPrompts.get(token)?.reject(reason);
				pendingPrompts.delete(token);
			}
			tokens.clear();
		};

		request.on("close", () => {
			closed = true;
			abort.abort();
			rejectAll(new Error("登录已取消"));
		});

		response.status(200);
		response.setHeader("content-type", "text/event-stream; charset=utf-8");
		response.setHeader("cache-control", "no-cache, no-transform");
		response.setHeader("connection", "keep-alive");
		response.setHeader("x-accel-buffering", "no");
		response.flushHeaders?.();

		const send = (payload: unknown) => {
			if (closed) return;
			response.write(`data: ${JSON.stringify(payload)}\n\n`);
		};

		/** 问用户一句话：发一个 token 给前端，拿到答复再 resolve */
		const ask = (): { token: string; promise: Promise<string> } => {
			const token = `${provider}-${randomUUID()}`;
			tokens.add(token);
			const promise = new Promise<string>((resolve, reject) => {
				pendingPrompts.set(token, {
					provider,
					resolve: (value) => {
						tokens.delete(token);
						pendingPrompts.delete(token);
						resolve(value);
					},
					reject: (error) => {
						tokens.delete(token);
						pendingPrompts.delete(token);
						reject(error);
					},
				});
			});
			return { token, promise };
		};

		// 设备码流程可能挂十几分钟：中间件和代理都会嫌长时间没字节
		const heartbeat = setInterval(() => {
			if (!closed) response.write(": ping\n\n");
		}, 25_000);

		try {
			await providerAuth.login(provider, {
				prompt: async (prompt) => {
					const request = ask();
					send(
						prompt.type === "select"
							? {
									type: "select_request",
									token: request.token,
									message: prompt.message,
									options: prompt.options ?? [],
								}
							: {
									type: "prompt_request",
									token: request.token,
									message: prompt.message,
									placeholder: prompt.placeholder ?? null,
									secret: prompt.type === "secret",
								},
					);
					return request.promise;
				},
				notify: (event: ProviderAuthEvent) => {
					// `auth_url` 在前端叫 `auth`，其余原样转发
					send(
						event.type === "auth_url"
							? { type: "auth", url: event.url, instructions: event.instructions ?? null }
							: event,
					);
				},
				signal: abort.signal,
			});
			await options.refresh();
			options.notify(`订阅服务「${provider}」已连接`, "info");
			options.log?.("订阅登录成功", { provider });
			send({ type: "success" });
		} catch (cause) {
			if (abort.signal.aborted) {
				send({ type: "cancelled" });
			} else {
				options.log?.("订阅登录失败", { provider, message: errorMessage(cause) });
				send({ type: "error", message: errorMessage(cause) });
			}
		} finally {
			clearInterval(heartbeat);
			rejectAll(new Error("登录已结束"));
			if (!closed) response.end();
		}
	});

	// POST /api/subscriptions/:provider/login —— 用户把授权码 / 回调地址交回来
	app.post("/api/subscriptions/:provider/login", (request: Request, response: Response) => {
		const provider = String(request.params.provider ?? "");
		const body = (request.body ?? {}) as { token?: unknown; code?: unknown };
		const token = typeof body.token === "string" ? body.token : "";
		const code = typeof body.code === "string" ? body.code : "";
		if (!token || !code.trim()) {
			response.status(400).json({ error: { message: "token 和 code 都要有" } });
			return;
		}
		const pending = pendingPrompts.get(token);
		if (!pending || pending.provider !== provider) {
			response.status(404).json({ error: { message: "这次登录已经没有在等这个答复了（可能已超时，重试一次）" } });
			return;
		}
		pending.resolve(code.trim());
		response.json({ ok: true });
	});

	// POST /api/subscriptions/:provider/logout —— 只删 OAuth 凭据，不动同名 provider 的 API key
	app.post("/api/subscriptions/:provider/logout", async (request: Request, response: Response) => {
		const provider = String(request.params.provider ?? "");
		if (!providerAuth) {
			response.status(501).json({ error: { message: "当前引擎不支持订阅登录" } });
			return;
		}
		try {
			await providerAuth.logout(provider);
			await options.refresh();
			options.notify(`已退出订阅服务「${provider}」`, "info");
			options.log?.("订阅登出", { provider });
			response.json({ ok: true });
		} catch (cause) {
			options.log?.("订阅登出失败", { provider, message: errorMessage(cause) });
			response.status(500).json({ error: { message: errorMessage(cause) } });
		}
	});
}
