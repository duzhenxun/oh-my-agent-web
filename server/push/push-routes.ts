/**
 * 推送的 HTTP 路由（设置面板用）。
 *
 *   GET  /api/push/key          取 VAPID 公钥（前端订阅要用）
 *   POST /api/push/subscribe    存订阅
 *   POST /api/push/unsubscribe  删订阅
 *   POST /api/push/brand        存这台设备的界面自称（设置 → 外观 改名后同步过来）
 *   POST /api/push/test         给自己推一条测试通知
 */
import type { Express } from "express";
import { type PushStore } from "./push.js";
import { BRAND_NAME } from "../brand.js";

/** 界面自称的长度上限：web 侧是 24（`brand-name.ts`），这里留宽一点，不跟客户端卡得一样紧 */
const BRAND_NAME_LIMIT = 40;

type Body = {
	endpoint?: unknown;
	keys?: unknown;
	clientId?: unknown;
};

/** 没有别名的老订阅：按推送网关猜一个（Apple / Chrome-FCM），总比一串域名好认 */
function defaultName(host: string): string {
	if (host.includes("push.apple.com")) return "Apple 设备（Safari）";
	if (host.includes("googleapis.com") || host.includes("fcm")) return "Chrome 设备";
	return host;
}

/** 清洗界面自称：折空白、截长（不做空串回落：空串就是「没改过 / 改回默认」的意思） */
function sanitizeBrand(raw: string): string {
	return raw.replace(/\s+/g, " ").trim().slice(0, BRAND_NAME_LIMIT).trim();
}

/**
 * 订阅里的「界面自称」：**只有传了字符串才动**。
 *
 * 区分“没传”与“传了空串”很重要：没传（老客户端、只重新订阅）应该保留用户改过的名字，
 * 传空串才是“改回默认名”。
 */
function brandNamePatch(raw: unknown): { brandName?: string } {
	return typeof raw === "string" ? { brandName: sanitizeBrand(raw) } : {};
}

export function registerPushRoutes(app: Express, options: { store: PushStore }): void {
	app.get("/api/push/key", async (_request, response) => {
		response.json({ publicKey: await options.store.publicKey() });
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
			...(typeof (body as { name?: unknown })?.name === "string" &&
			String((body as { name: string }).name).trim() !== ""
				? {
						name: String((body as { name: string }).name)
							.trim()
							.slice(0, 40),
					}
				: {}),
			...brandNamePatch((body as { brandName?: unknown })?.brandName),
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
					// 老订阅没存名字：按推送服务商推一个像人话的默认名（用户可再改名）
					name: item.name ?? defaultName(host),
					// 这台设备的界面自称（没改过 = null，界面显示默认名即可）
					brandName: item.brandName ?? null,
					createdAt: item.createdAt,
					lastSentAt: item.lastSentAt ?? null,
					lastStatus: item.lastStatus ?? null,
					clientId: item.clientId ?? null,
				};
			}),
		});
	});

	app.post("/api/push/brand", async (request, response) => {
		const body = request.body as { endpoint?: unknown; brandName?: unknown } | undefined;
		const endpoint = typeof body?.endpoint === "string" ? body.endpoint : "";
		if (endpoint === "" || typeof body?.brandName !== "string") {
			response.status(400).json({ error: { code: "push.bad_request", message: "缺少 endpoint 或 brandName" } });
			return;
		}
		// 空串是合法的：改名改回默认就是「清掉这台设备的名字」
		response.json(await options.store.setBrandName(endpoint, sanitizeBrand(String(body.brandName))));
	});

	app.post("/api/push/test", async (request, response) => {
		const body = request.body as { endpoints?: unknown } | undefined;
		const endpoints = Array.isArray(body?.endpoints)
			? body.endpoints.filter((item): item is string => typeof item === "string")
			: undefined;
		// 标题里的应用名按**每台设备**算：它可能就是被改名过的那一个
		const result = await options.store.send(
			(subscription) => ({
				title: `${sanitizeBrand(subscription.brandName ?? "") || BRAND_NAME} 测试推送`,
				body: "如果你看到这条，说明订阅与推送链路都通了。",
				url: "/",
				tag: "agent-web-test",
			}),
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
