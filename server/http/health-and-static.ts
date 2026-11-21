/**
 * HTTP 的「非 API」部分（从 index.ts 抽出：400 行护栏）：健康检查 + 前端静态资源。
 */
import express, { type Express } from "express";
import { PROTOCOL_VERSION, type EngineName } from "../protocol.js";
import { webVersion } from "../util/version.js";

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
	// 压缩 + 缓存头由 index.ts 在**注册 API 路由之前**挂（见那里的注释）：
	// 在这里挂只会覆盖它之后注册的路由，`/api/rpc` 那些大包就永远压不到。

	app.get("/api/health", (_request, response) => {
		const counts = options.counts();
		response.json({
			ok: true,
			protocolVersion: PROTOCOL_VERSION,
			// 跑着的这个进程的版本（aw status 用它和磁盘上的 package.json 对比）
			version: webVersion(),
			workspace: options.workspace,
			engine: options.engine,
			// 会话事实源是 pi 的会话存储（ADR-0021 §2）→ 报它的数量
			sessions: counts.sessions,
			conversations: counts.conversations,
		});
	});

	if (options.webDist) {
		/**
		 * `/index.html` 与 `/` 一律 `no-store`。
		 *
		 * 为什么：`index.html` 里写着带哈希的资源名，**它自己不能缓存** —— 否则改完前端、
		 * 用户刷新一次仍拿到旧 HTML，进而加载旧 JS/CSS（实测踩过：界面上还显示已经删掉的浮动
		 * 麦克风按钮，看起来像「改了没生效」）。带哈希的 assets 仍然长缓存（见 immutableAssets）。
		 */
		app.use((request, response, next) => {
			if (request.path === "/" || request.path === "/index.html") {
				response.setHeader("Cache-Control", "no-store, must-revalidate");
			}
			next();
		});
		app.use(express.static(options.webDist));
		return;
	}
	app.get("/", (_request, response) => {
		response
			.type("text/plain")
			.send(`agent-web 服务已启动\n\n前端开发态请用：npm run dev（vite 在 http://127.0.0.1:${options.devWebPort}）\n`);
	});
}
