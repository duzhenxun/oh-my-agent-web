/**
 * 「非会话状态」的 HTTP 路由统一注册入口（从 index.ts 抽出来：400 行护栏）。
 * 里面都是按需查询的目录数据：技能（P8）与模型导入（ADR-0026 B）。
 */
import type { Express } from "express";
import type { ProviderStore } from "../providers/provider-store.js";
import { registerCatalogRoutes, registerImportRoutes } from "../providers/import-routes.js";
import { createCatalogLookup } from "../providers/catalog.js";
import { testModel } from "../providers/model-test.js";
import { registerSkillRoutes } from "../skills/skill-routes.js";
import { registerProjectActions, registerTerminalRoutes } from "../terminal/terminal-routes.js";
import { registerDirRoutes } from "../files/dir-routes.js";
import { registerFileRoutes } from "../files/files-routes.js";
import { registerSessionRoutes } from "../sessions/session-routes.js";
import type { PushStore } from "../push/push.js";
import { registerPushRoutes } from "../push/push-routes.js";

export function registerAuxRoutes(
	app: Express,
	options: {
		providerStore: ProviderStore;
		onChange: () => void;
		workspaceOf: () => string | null;
		projects: () => import("../protocol.js").PiProject[];
		pushStore: PushStore;
	},
): void {
	registerSessionRoutes(app, { projects: options.projects });
	registerPushRoutes(app, { store: options.pushStore });
	registerFileRoutes(app, { workspaceOf: options.workspaceOf });
	registerTerminalRoutes(app, { workspaceOf: options.workspaceOf });
	registerProjectActions(app, { workspaceOf: options.workspaceOf });
	registerDirRoutes(app, { workspaceOf: options.workspaceOf });
	registerSkillRoutes(app);
	registerImportRoutes(app, { store: options.providerStore, onChange: options.onChange });
	registerCatalogRoutes(app, {
		store: options.providerStore,
		catalog: createCatalogLookup(),
		testModel: (input) => testModel(input),
	});
}
