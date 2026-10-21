/**
 * 推送的 HTTP 路由（设置面板用）。
 *
 *   GET  /api/push/key          取 VAPID 公钥（前端订阅要用）
 *   POST /api/push/subscribe    存订阅
 *   POST /api/push/unsubscribe  删订阅
 *   POST /api/push/test         给自己推一条测试通知
 */
import type { Express } from "express";
import { VAPID_PUBLIC_KEY, type PushStore } from "./push.js";

type Body = {
	endpoint?: unknown;
	keys?: unknown;
	clientId?: unknown;
};

export function registerPushRoutes(app: Express, options: { store: PushStore }): void {
	app.get("/api/push/key", (_request, response) => {
		response.json({ publicKey: VAPID_PUBLIC_KEY });
	});

	app.post("/api/push/subscribe", async (request, response) => {
		const body = request.body as Body | undefined;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		if (endpoint === "") {
			response.status(400).json({ error: { code: "push.no_endpoint", message: "缺少 endpoint" } });
			return;
		}
		const keys = body?.keys as { p256dh?: unknown; auth?: unknown } | undefined;
		const result = await options.store.add({
			endpoint,
			...(typeof keys?.p256dh === "string" && typeof keys.auth === "string"
				? { keys: { p256dh: keys.p256dh, auth: keys.auth } }
				: {}),
			...(typeof body?.clientId === "string" ? { clientId: body.clientId } : {}),
			createdAt: Date.now(),
		});
		response.json(result);
	});

	app.post("/api/push/unsubscribe", async (request, response) => {
		const body = request.body as Body | undefined;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		if (endpoint === "") {
			response.status(400).json({ error: { code: "push.no_endpoint", message: "缺少 endpoint" } });
			return;
		}
		response.json(await options.store.remove(endpoint));
	});

	/** 设备清单（不含 keys，端点只给 host + 尾段，界面上展示用） */
	app.get("/api/push/subscriptions", async (_request, response) => {
		const list = await options.store.list();
		response.json({
			total: list.length,
			devices: list.map((item) => {
				let host = "";
				try {
					host = new URL(item.endpoint).host;
				} catch {
					host = "unknown";
				}
				return {
					endpoint: item.endpoint,
					host,
					name: item.name ?? host,
					createdAt: item.createdAt,
					lastSentAt: item.lastSentAt ?? null,
					lastStatus: item.lastStatus ?? null,
					clientId: item.clientId ?? null,
				};
			}),
		});
	});

	app.post("/api/push/test", async (request, response) => {
		const body = request.body as { endpoints?: unknown } | undefined;
		const endpoints = Array.isArray(body?.endpoints)
			? body.endpoints.filter((item): item is string => typeof item === "string")
			: undefined;
		const result = await options.store.send(
			{
				title: "Agent Web 测试推送",
				body: "如果你看到这条，说明订阅与推送链路都通了。",
				url: "/",
				tag: "agent-web-test",
			},
			endpoints && endpoints.length > 0 ? endpoints : undefined,
		);
		response.json(result);
	});

	app.post("/api/push/rename", async (request, response) => {
		const body = request.body as { endpoint?: unknown; name?: unknown } | undefined;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		const name = typeof body?.name === "string" ? body.name.trim().slice(0, 40) : "";
		if (endpoint === "" || name === "") {
			response.status(400).json({ error: { code: "push.bad_request", message: "缺少 endpoint 或 name" } });
			return;
		}
		response.json(await options.store.rename(endpoint, name));
	});

	app.post("/api/push/delete", async (request, response) => {
		const body = request.body as { endpoint?: unknown } | undefined;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		if (endpoint === "") {
			response.status(400).json({ error: { code: "push.bad_request", message: "缺少 endpoint" } });
			return;
		}
		response.json(await options.store.removeOne(endpoint));
	});

	app.post("/api/push/clear", async (_request, response) => {
		response.json(await options.store.clear());
	});

	app.get("/api/push/count", async (_request, response) => {
		response.json({ total: await options.store.count() });
	});
}
