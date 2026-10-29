/**
 * 插件（插件包 / 本机扩展）的 HTTP 路由。
 *
 * 跟技能面板同一套理由走 HTTP 而不是快照：这是「按需查目录」的数据，
 * 塞进每一帧快照只会让所有客户端一直驼着它。
 *
 *   GET  /api/plugins        列表（全局 + 项目作用域、状态、资源构成、诊断）
 *   POST /api/plugins        { action, source?, scope? }
 *                            action: install | remove | update | enable | disable
 *
 * 工作区由宿主给（`workspaceOf`）：项目作用域读的就是当前这个项目的 `.pi/settings.json`，
 * 和会话加载时用的是同一个 cwd。
 */
import type { Express } from "express";
import type { PluginAction, PluginScope, PluginStore } from "../engine/pi-plugins.js";

const ACTIONS: PluginAction[] = ["install", "remove", "update", "enable", "disable"];

export function registerPluginRoutes(
	app: Express,
	options: {
		/** 按**当前引擎**取插件后端：切到 claude 就看 claude 的插件开关，不再看 pi 的 packages */
		storeFor: (engine: string) => PluginStore;
		/** 现在跑的是哪个引擎（每次请求现读：切引擎后立刻换口径） */
		engineOf: () => string;
		workspaceOf: () => string | null;
	},
): void {
	const { storeFor, engineOf, workspaceOf } = options;
	const workspace = () => workspaceOf() ?? process.cwd();
	const store = () => storeFor(engineOf());

	app.get("/api/plugins", async (_request, response) => {
		response.json(await store().view(workspace()));
	});

	app.post("/api/plugins", async (request, response) => {
		const body = request.body as { action?: unknown; source?: unknown; scope?: unknown } | undefined;
		const action = ACTIONS.includes(body?.action as PluginAction) ? (body?.action as PluginAction) : null;
		if (!action) {
			response.status(400).json({ error: { code: "plugins.bad_action", message: "不认识的插件操作" } });
			return;
		}
		const source = typeof body?.source === "string" ? body.source : undefined;
		const scope: PluginScope | undefined =
			body?.scope === "project" ? "project" : body?.scope === "global" ? "global" : undefined;
		const result = await store().act({ workspace: workspace(), action, source, scope });
		// 操作失败但列表本身读得出来：照常 200 回列表 + actionError，界面不需要分辨两种 400
		response.json(result);
	});
}
