/**
 * 「非会话状态」的 HTTP 路由统一注册入口（从 index.ts 抽出来：400 行护栏）。
 * 里面都是按需查询的目录数据：技能（P8）与模型导入（ADR-0026 B）。
 */
import type { Express } from "express";
import type { ProviderStore } from "../providers/provider-store.js";
import { registerImportRoutes } from "../providers/import-routes.js";
import { registerSkillRoutes } from "../skills/skill-routes.js";

export function registerAuxRoutes(app: Express, options: { providerStore: ProviderStore; onChange: () => void }): void {
	registerSkillRoutes(app);
	registerImportRoutes(app, { store: options.providerStore, onChange: options.onChange });
}
