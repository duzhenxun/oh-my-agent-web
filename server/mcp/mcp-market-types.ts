/**
 * MCP 市场的公共类型：源清单、条目形状、返回结果。
 *
 * 单独一个文件是因为「抓取与缓存」（`mcp-market.ts`）与「各源的映射」
 * （`mcp-market-sources.ts`）互相引用这几个类型，放谁那儿都会成环。
 */
import type { McpServerConfig } from "./pi-mcp-config.js";

export type McpMarketSource = "registry" | "smithery" | "github";
export const MARKET_SOURCES: { id: McpMarketSource; label: string; hint: string }[] = [
	{ id: "registry", label: "官方 MCP 注册中心", hint: "registry.modelcontextprotocol.io（npm / PyPI 包与远程地址）" },
	{ id: "smithery", label: "Smithery", hint: "smithery.ai 托管的远程服务器（可能要登录授权）" },
	{ id: "github", label: "官方参考服务器", hint: "modelcontextprotocol/servers 仓库里的那几个" },
];

export type MarketEntry = {
	/** 稳定的 key（源 + 原名），前端用它当 React key 与「已添加」判据 */
	id: string;
	name: string;
	title: string;
	description: string;
	source: McpMarketSource;
	homepage?: string;
	/** 包名（npm / PyPI），列表上显示这个 */
	pkg?: string;
	downloads?: number;
	verified?: boolean;
	/** 一键添加会写进 mcp.json 的那一段 */
	config: McpServerConfig;
	/** 需要用户自己补的环境变量（注册中心会明确给出） */
	needsEnv?: string[];
	/** 添加后还要做什么（比如去 OAuth 登录），显示在卡片上 */
	note?: string;
};

export type MarketResult = {
	ok: boolean;
	source: McpMarketSource;
	entries: MarketEntry[];
	error?: string;
	/** 命中的是磁盘缓存（过期/失败回退时会在 error 里说明） */
	cached?: boolean;
};
