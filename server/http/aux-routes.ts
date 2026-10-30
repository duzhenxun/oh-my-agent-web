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
		log: (message: string, meta?: Record<string, unknown>) => void;
	},
): void {
	registerSessionRoutes(app, { deleteSession: options.deleteSession });
	registerPushRoutes(app, { store: options.pushStore });
	registerFileRoutes(app, { workspaceOf: options.workspaceOf });
	registerTerminalRoutes(app, { workspaceOf: options.workspaceOf });
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
	registerImportRoutes(app, {
		store: options.providerStore,
		onChange: options.onChange,
		...(options.builtinProviders ? { builtinProviders: options.builtinProviders } : {}),
	});
	if (options.probeModel) {
		registerProbeRoutes(app, { probeModel: options.probeModel, log: options.log });
	}
	registerCatalogRoutes(app, {
		store: options.providerStore,
		...(options.builtinProviders ? { builtinProviders: options.builtinProviders } : {}),
		catalog: createCatalogLookup(),
		testModel: (input) => testModel(input),
	});
}
