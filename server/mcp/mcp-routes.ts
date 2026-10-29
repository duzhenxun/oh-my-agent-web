/**
 * MCP 面板的 HTTP 路由。
 *
 * 跟技能 / 插件面板同一套理由走 HTTP 而不是快照：这是「按需查配置」的数据。
 *
 *   GET  /api/mcp          清单（项目 + 全局，含启用状态、暴露方式、配置路径、测试结果）
 *   GET  /api/mcp/market   市场：?source=registry|smithery|github&q=&refresh=1
 *   POST /api/mcp          { action, ... }
 *      action: add | parse | remove | set-enabled | set-scope-enabled | set-exposure | test
 *
 * 添加有三种来源（`server/mcp/mcp-store.ts` 的 `parseAddInput` 归一）：
 *   `text`（粘的一整段）/ `config`（市场卡片）/ `command`|`url`（旧的单行字段）。
 *
 * 工作区由宿主给（`workspaceOf`）：项目作用域读的就是这个项目的 `.pi/mcp.json`，
 * 和会话启动时用的是同一个 cwd。
 */
import type { Express } from "express";
import { MARKET_SOURCES, type McpMarket, type McpMarketSource } from "./mcp-market.js";
import { MCP_EXPOSURES, type McpExposure, type McpScope, type McpServerConfig } from "./pi-mcp-config.js";
import type { McpAction, McpStore } from "./mcp-store.js";

const ACTIONS: McpAction[] = [
	"add",
	"parse",
	"remove",
	"set-enabled",
	"set-scope-enabled",
	"set-exposure",
	"test",
	// OAuth：起登录 / 轮询 / 取消（spawn 的是 pi 自己的 `mcp login`，凭据写 mcp-auth.json）
	"login",
	"login-status",
	"login-cancel",
];

export function registerMcpRoutes(
	app: Express,
	options: {
		/** 按**当前引擎**取 MCP 后端：切到 codex 就读 codex 的 config.toml，不再读 pi 的 mcp.json */
		storeFor: (engine: string) => McpStore;
		/** 现在跑的是哪个引擎（切引擎时 runtime 会换，所以每次请求都现读） */
		engineOf: () => string;
		market: McpMarket;
		workspaceOf: () => string | null;
	},
): void {
	const { storeFor, engineOf, market, workspaceOf } = options;
	const workspace = () => workspaceOf() ?? process.cwd();
	const store = () => storeFor(engineOf());

	app.get("/api/mcp", async (_request, response) => {
		response.json(await store().view(workspace()));
	});

	app.get("/api/mcp/market", async (request, response) => {
		const rawSource = typeof request.query.source === "string" ? request.query.source : "";
		const source = MARKET_SOURCES.some((item) => item.id === rawSource) ? (rawSource as McpMarketSource) : "registry";
		const query = typeof request.query.q === "string" ? request.query.q : "";
		response.json(await market.list({ source, query, refresh: request.query.refresh === "1" }));
	});

	app.post("/api/mcp", async (request, response) => {
		const body = request.body as Record<string, unknown> | undefined;
		const action = ACTIONS.includes(body?.action as McpAction) ? (body?.action as McpAction) : null;
		if (!action) {
			response.status(400).json({ error: { code: "mcp.bad_action", message: "不认识的 MCP 操作" } });
			return;
		}
		const text = (value: unknown) => (typeof value === "string" ? value : undefined);
		const result = await store().act({
			workspace: workspace(),
			action,
			name: text(body?.name),
			scope:
				body?.scope === "project"
					? ("project" as McpScope)
					: body?.scope === "global"
						? ("global" as McpScope)
						: undefined,
			enabled: typeof body?.enabled === "boolean" ? body.enabled : undefined,
			exposure: MCP_EXPOSURES.includes(body?.exposure as McpExposure) ? (body?.exposure as McpExposure) : undefined,
			text: text(body?.text),
			// 市场卡片：只搬 command / args / url / headers 这些「能跑起来」的字段，
			// 其余（比如卡片自己的 note / downloads）不属于配置
			config: toConfig(body?.config),
			command: text(body?.command),
			url: text(body?.url),
			description: text(body?.description),
		});
		// 操作失败但清单本身读得出来：照常 200 回列表 + actionError，界面不需要分辨两种 400
		response.json(result);
	});
}

/** 只保留 `McpServerConfig` 里认的键：别人的卡片字段不许漏进 mcp.json */
function toConfig(value: unknown): McpServerConfig | undefined {
	if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
	const raw = value as Record<string, unknown>;
	const config: Record<string, unknown> = {};
	for (const key of ["type", "command", "args", "env", "cwd", "url", "headers", "description", "timeout"]) {
		if (raw[key] !== undefined) config[key] = raw[key];
	}
	return Object.keys(config).length > 0 ? (config as McpServerConfig) : undefined;
}
