/**
 * 「这个引擎没有 MCP 面板能力」时的空后端（dsh / 未来新增但没接的引擎）。
 *
 * 为什么要有一个真的空 store 而不是不注册路由：面板要能**说清楚为什么是空的**
 * （「dsh 的 MCP 配置还没接，配置在它自己的 profile 里」），
 * 比一句「没有数据」或者干脆保留 pi 的列表要诚实得多。
 */
import { NO_MCP_CAN, engineMcpView } from "./mcp-engine-shared.js";
import type { McpStore } from "./mcp-store.js";

export function createNoneMcpStore(engine: string, reason: string, paths: string[] = []): McpStore {
	const view = () =>
		engineMcpView({
			engine,
			source: reason,
			servers: [],
			globalPath: paths[0] ?? "",
			projectPath: paths[1] ?? "",
			can: { ...NO_MCP_CAN },
			errors: [reason],
		});
	return {
		async view() {
			return view();
		},
		async act() {
			return { ...view(), actionError: reason };
		},
	};
}
