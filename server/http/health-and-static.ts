/**
 * HTTP 的「非 API」部分（从 index.ts 抽出：400 行护栏）：健康检查 + 前端静态资源。
 */
import express, { type Express } from "express";
import { PROTOCOL_VERSION, type EngineName } from "../protocol.js";

export function registerHealthAndStatic(
	app: Express,
	options: {
		workspace: string;
		engine: EngineName;
		webDist: string | null;
		devWebPort: number;
		counts: () => { sessions: number; conversations: number };
	},
): void {
	app.get("/api/health", (_request, response) => {
		const counts = options.counts();
		response.json({
			ok: true,
			protocolVersion: PROTOCOL_VERSION,
			workspace: options.workspace,
			engine: options.engine,
			// 会话事实源是 pi 的会话存储（ADR-0021 §2）→ 报它的数量
			sessions: counts.sessions,
			conversations: counts.conversations,
		});
	});

	if (options.webDist) {
		app.use(express.static(options.webDist));
		return;
	}
	app.get("/", (_request, response) => {
		response
			.type("text/plain")
			.send(`agent-web 服务已启动\n\n前端开发态请用：npm run dev（vite 在 http://127.0.0.1:${options.devWebPort}）\n`);
	});
}
