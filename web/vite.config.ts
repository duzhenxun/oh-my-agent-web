import react from "@vitejs/plugin-react";
import { request as httpRequest } from "node:http";
import { defineConfig, type Plugin } from "vite";
import { mermaidSlim } from "./mermaid-slim-plugin.ts";

/**
 * 前端构建/开发配置（ADR-0007：开发期 Vite 直接监听 25257，反代到内部后端 25258）。
 *
 * 生产期由后端自己监听 25257 并提供构建产物 —— 两种方式对外都是同一个地址：
 * `/` 是应用、`/api` 与 `/login` 归后端。`devAuthGate` 把「未登录先给登录页」
 * 这件事也从生产搬了过来（生产是后端在 `GET /` 上直接渲染登录页）。
 *
 * root 显式设为 web/：脚本从仓库根用 `--config web/vite.config.ts` 调用，cwd 是仓库根。
 * fs.allow 需要放开仓库根：`web/src/types.ts` 是 `server/protocol.ts` 的 shim（跨目录导入协议单源）。
 */
const BACKEND_PORT = process.env.AGENT_WEB_BACKEND_PORT ?? "25258";
const BACKEND_HOST = "127.0.0.1";

/**
 * Vite 自己的 Host 校验（防 DNS rebinding）—— 它跟工作台的准入**是两套东西**。
 *
 * `server/http/auth.ts` 那边已经不按域名白名单卡人了：目标不是本机（隧道 / 反向代理 / 自建域名）
 * 的请求一律交给**密码门**，`--allow-host` 只在少见场景才需要。可 Vite 还在拿 Host 头比对，
 * 于是用隧道访问 dev 会先被它挡下来：
 *   Blocked request. This host ("agent.xs25.cn") is not allowed.
 * 开发态对外由隧道 / 反代负责，准入由后端密码兜底，所以这里默认放开；
 * 想收紧就设 `AGENT_WEB_DEV_ALLOWED_HOSTS=a.com,b.com`（逗号分隔，改为白名单）。
 */
function devAllowedHosts(): string[] | true {
	const list = (process.env.AGENT_WEB_DEV_ALLOWED_HOSTS ?? "")
		.split(",")
		.map((item) => item.trim())
		.filter(Boolean);
	return list.length > 0 ? list : true;
}

/**
 * 问后端：这次请求「是否已登录」（把浏览器的 Host / Cookie / 来源原样带过去，判断与真实请求一致）。
 *
 * 为什么不用 `fetch`：`Host` 是 forbidden header，fetch 带不过去；而后端正是靠 Host
 * 区分「本机直连」和「隧道 / 反代打进来」—— 探活不带 Host 的话，远程用户会被判成本机免密，
 * 这个门就形同虚设。所以这里用 `node:http` 手工发，只走回环，超时 1.5 秒就当「问不出来」。
 */
function probeAuthStatus(input: {
	host: string | undefined;
	cookie: string | undefined;
	forwardedFor: string | undefined;
}): Promise<number | null> {
	return new Promise((resolve) => {
		const request = httpRequest(
			{
				host: BACKEND_HOST,
				port: Number(BACKEND_PORT),
				path: "/api/health",
				method: "GET",
				timeout: 1500,
				headers: {
					...(input.host ? { host: input.host } : {}),
					...(input.cookie ? { cookie: input.cookie } : {}),
					...(input.forwardedFor ? { "x-forwarded-for": input.forwardedFor } : {}),
				},
			},
			(response) => {
				response.resume(); // 只关心状态码，body 丢掉
				resolve(response.statusCode ?? null);
			},
		);
		request.on("timeout", () => {
			request.destroy();
			resolve(null);
		});
		request.on("error", () => resolve(null));
		request.end();
	});
}

/** 是不是「拿页面」的导航请求（fetch/XHR 的 Accept 里没有 text/html，静态资源同理） */
function wantsDocument(method: string | undefined, url: string, accept: unknown): boolean {
	if (method !== "GET" && method !== "HEAD") return false;
	if (typeof accept !== "string" || !accept.includes("text/html")) return false;
	// 只拦应用入口：/api、/login、/@vite、静态资源都不该走这次判断
	return url === "/" || url.startsWith("/?") || url === "/index.html";
}

/**
 * 开发态的准入：**未登录时把页面请求 302 到 `/login`**（那张自包含的登录页由后端渲染）。
 *
 * 为什么需要：生产态未登录时 `GET /` 由后端直接给登录页，**端到端只有一张十几 KB 的 HTML**；
 * 而开发态 `GET /` 是 Vite 给的，浏览器会先拉起整个 SPA（几百个模块），请求打出去全是 401，
 * 客户端再跳登录页 —— 走隧道 / 手机网络时，为了输一个密码要等几十秒（用户 2026-10-30 报「挺慢」）。
 *
 * 代价：每个导航请求多一次回环探活（约 1ms）。只对 `GET /` 这一个路径生效。
 */
function devAuthGate(): Plugin {
	return {
		name: "agent-web-dev-auth-gate",
		apply: "serve",
		configureServer(server) {
			server.middlewares.use((request, response, next) => {
				if (!wantsDocument(request.method, request.url ?? "/", request.headers.accept)) return next();
				void (async () => {
					const status = await probeAuthStatus({
						host: request.headers.host,
						cookie: request.headers.cookie,
						forwardedFor: request.socket.remoteAddress,
					});
					// 401 = 没登录 / 过期；403 = 远程但服务端还没设密码（登录页会给出「去本机设」的说明）
					if (status === 401 || status === 403) {
						response.writeHead(302, { location: "/login", "cache-control": "no-store" });
						response.end();
						return;
					}
					// 200 = 已登录；null = 后端没起来（让 /api 的反代自己报错，别把页面也拦死）
					next();
				})();
			});
		},
	};
}

export default defineConfig({
	root: "web",
	// mermaidSlim 只在 build 生效：把用不到的图型和 elkjs/cytoscape/katex 换成空壳（ADR-0040）
	// 完整版构建：OH_MY_AGENT_WEB_MERMAID_FULL=1；单独保留某项：OH_MY_AGENT_WEB_MERMAID_KEEP=mindmap,katex
	plugins: [react(), mermaidSlim(), devAuthGate()],
	build: {
		outDir: "dist",
		emptyOutDir: true,
	},
	server: {
		port: 25257,
		strictPort: true,
		// 隧道 / 自建域名访问 dev 时放行（见 devAllowedHosts 的注释）
		allowedHosts: devAllowedHosts(),
		fs: { allow: [".."] },
		proxy: {
			"/api": { target: `http://${BACKEND_HOST}:${BACKEND_PORT}`, xfwd: true },
			// 独立登录页（`server/http/login-page.ts` 渲染的那张）也归后端：
			// 开发态 `GET /` 是 Vite 给的，未登录时必须有条路能拿到服务端的登录页
			"/login": { target: `http://${BACKEND_HOST}:${BACKEND_PORT}`, xfwd: true },
		},
	},
});
