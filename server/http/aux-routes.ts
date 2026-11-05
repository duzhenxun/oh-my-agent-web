/**
 * 「非会话状态」的 HTTP 路由统一注册入口（从 index.ts 抽出来：400 行护栏）。
 * 里面都是按需查询的目录数据：技能（P8）与模型导入（ADR-0026 B）。
 */
import type { Express } from "express";
import type { ProviderStore } from "../providers/provider-store.js";
import type { ProviderAuthPort } from "../engine/port.js";
import { registerCatalogRoutes, registerImportRoutes } from "../providers/import-routes.js";
import { registerProbeRoutes } from "../providers/probe-routes.js";
import { registerSubscriptionRoutes } from "../providers/subscription-routes.js";
import { createCatalogLookup } from "../providers/catalog.js";
import { testModel } from "../providers/model-test.js";
import { registerSkillRoutes } from "../skills/skill-routes.js";
import { registerPluginRoutes } from "../plugins/plugin-routes.js";
import type { PluginStore } from "../engine/pi-plugins.js";
import { registerMcpRoutes } from "../mcp/mcp-routes.js";
import type { McpMarket } from "../mcp/mcp-market.js";
import type { McpStore } from "../mcp/mcp-store.js";
import { registerProjectActions, registerTerminalRoutes } from "../terminal/terminal-routes.js";
import { registerDirRoutes } from "../files/dir-routes.js";
import { registerPickPathRoutes } from "../files/pick-path-routes.js";
import { registerFileRoutes } from "../files/files-routes.js";
import { registerSessionRoutes, type SessionDeleteResult } from "../sessions/session-routes.js";
import type { PushStore } from "../push/push.js";
import { registerPushRoutes } from "../push/push-routes.js";

export function registerAuxRoutes(
	app: Express,
	options: {
		providerStore: ProviderStore;
		onChange: () => void | Promise<void>;
		workspaceOf: () => string | null;
		projects: () => import("../protocol.js").PiProject[];
		/** 删会话：引擎原生删除 or 文件改名（`purge` 为真时真删），由 runtime 决定 */
		deleteSession: (id: string, options?: { purge?: boolean }) => Promise<SessionDeleteResult>;
		/**
		 * 「完整历史」/「系统提示词」（只有 pi 给得出）：路由不在这里拼逻辑，
		 * 只把 runtime 的结果翻成 HTTP —— 会话文件、引擎句柄都只有 runtime 知道。
		 */
		sessionHistory?: (id: string) => Promise<{ ok: true; html: string } | { ok: false; code: string; message: string }>;
		sessionSystemPrompt?: (
			id: string,
		) => Promise<{ ok: true; prompt: string } | { ok: false; code: string; message: string }>;
		pushStore: PushStore;
		/** 订阅服务（OAuth）：引擎不实现就不传，界面上那一块自然不出现 */
		providerAuth?: ProviderAuthPort;
		/**
		 * 插件 / MCP：**按当前引擎**取后端（pi / codex / claude / opencode / dsh 各一份）。
		 * 以前这里是一个固定的 pi store —— 切到 codex 之后面板还在读写 pi 的配置。
		 */
		engineOf: () => string;
		pluginStoreFor?: (engine: string) => PluginStore;
		mcpStoreFor?: (engine: string) => McpStore;
		/** MCP 市场（公开注册中心）：网络不通时面板里市场那块会自己说失败原因 */
		mcpMarket?: McpMarket;
		/** 给界面推一条提示（登录成功/失败） */
		notify: (text: string, level?: "info" | "warn" | "error") => void;
		/** 内置 provider 池（官方内置 provider 的模型/端点由引擎目录提供） */
		builtinProviders?: () => Promise<import("../providers/provider-store.js").BuiltinProvider[]>;
		/**
		 * 模型测速：交给当前引擎真跑一个最小回合（只有实现了 probeModel 的引擎能测）。
		 * 不给就不挂这条路由 —— 界面按 `capabilities.modelProbe` 决定画不画按钮。
		 */
		probeModel?: (modelId: string) => Promise<import("../engine/port.js").ModelProbeResult>;
		/**
		 * 引擎**当前**报上来的模型 id（`provider/model`）。
		 *
		 * 只用来回答一个问题：这个模型引擎现在跑得起来吗？跑得起来就把逐模型测试交给引擎
		 * （`probeModel`），跑不起来就沿用旧的「工作台直连 HTTP」—— 后者能给出更准的
		 * 「还没配 key」提示，而不是一句引擎侧的报错。
		 */
		engineModels?: () => { id: string }[];
		log: (message: string, meta?: Record<string, unknown>) => void;
	},
): {
	/** 终端输出订阅（交给 WS 通道：与 SSE 共用同一份监听器表） */
	watchTerminal: (id: string, listener: (chunk: string) => void) => (() => void) | null;
} {
	registerSessionRoutes(app, {
		deleteSession: options.deleteSession,
		...(options.sessionHistory
			? {
					sessionHistory: async (id: string) => {
						const result = await options.sessionHistory?.(id);
						if (!result) return { ok: false as const, error: { code: "engine.unsupported", message: "没有接入「完整历史」" } };
						return result.ok ? { ok: true as const, value: result.html } : { ok: false as const, error: { code: result.code, message: result.message } };
					},
				}
			: {}),
		...(options.sessionSystemPrompt
			? {
					sessionSystemPrompt: async (id: string) => {
						const result = await options.sessionSystemPrompt?.(id);
						if (!result)
							return { ok: false as const, error: { code: "engine.unsupported", message: "没有接入「系统提示词」" } };
						return result.ok ? { ok: true as const, value: result.prompt } : { ok: false as const, error: { code: result.code, message: result.message } };
					},
				}
			: {}),
	});
	registerPushRoutes(app, { store: options.pushStore });
	registerFileRoutes(app, { workspaceOf: options.workspaceOf });
	const terminal = registerTerminalRoutes(app, { workspaceOf: options.workspaceOf });
	registerProjectActions(app, { workspaceOf: options.workspaceOf });
	registerDirRoutes(app, { workspaceOf: options.workspaceOf });
	registerPickPathRoutes(app);
	registerSkillRoutes(app);
	if (options.pluginStoreFor) {
		registerPluginRoutes(app, {
			storeFor: options.pluginStoreFor,
			engineOf: options.engineOf,
			workspaceOf: options.workspaceOf,
		});
	}
	if (options.mcpStoreFor && options.mcpMarket) {
		registerMcpRoutes(app, {
			storeFor: options.mcpStoreFor,
			engineOf: options.engineOf,
			market: options.mcpMarket,
			workspaceOf: options.workspaceOf,
		});
	}
	registerSubscriptionRoutes(app, {
		providerAuth: options.providerAuth,
		notify: options.notify,
		log: options.log,
		refresh: async () => {
			await options.onChange();
		},
	});
	// 「填入模型信息」与导入共用一份 models.dev 缓存（10 分钟），不各拉一次
	const catalogLookup = createCatalogLookup();
	registerImportRoutes(app, {
		store: options.providerStore,
		onChange: options.onChange,
		...(options.builtinProviders ? { builtinProviders: options.builtinProviders } : {}),
		catalog: catalogLookup,
	});
	if (options.probeModel) {
		registerProbeRoutes(app, { probeModel: options.probeModel, log: options.log });
	}
	registerCatalogRoutes(app, {
		store: options.providerStore,
		...(options.builtinProviders ? { builtinProviders: options.builtinProviders } : {}),
		catalog: catalogLookup,
		testModel: (input) => testModel(input),
		// 凭证不在工作台手里（环境变量 / 引擎自己的登录）时，逐模型测试交给引擎自己跑
		...(options.probeModel ? { probeModel: options.probeModel } : {}),
		...(options.engineModels ? { engineModels: options.engineModels } : {}),
	});

	return { watchTerminal: terminal.watchTerminal };
}
