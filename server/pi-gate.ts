/**
 * 「pi 都没装」时的兜底页面 —— ADR-0052 §4。
 *
 * 为什么需要单独一个文件：pi 是以 **模块** 被 `server/index.ts` 静态 import 的
 * （`engine/pi-sdk.ts`），所以「没有 pi」的时候整个服务根本起不来 —— 连一个能弹出
 * 「点一下安装」的界面都没有。这里就是那个界面：自己只用 node 内置的 http，
 * 不 import 任何 pi 相关的东西，专门负责把 pi 装好。
 *
 * 只在这一种情况下被 `cli.ts` 拉起来，装完之后照常启动真正的服务。
 *
 * 装的落点与其它引擎一致：`<dataDir>` 这个 npm prefix（`install.sh` 同款），
 * 不碰系统全局、不用 sudo。
 */
import { createServer } from "node:http";
import { BRAND_NAME } from "./brand.js";
import { engineStatus, installEngine, piModulePath } from "./engine/engine-install.js";

const PAGE = (brand: string, engineWord: string) => `<!doctype html>
<html lang="zh-CN"><head><meta charset="utf-8"><title>${brand} · 安装 ${engineWord}</title>
<meta name="viewport" content="width=device-width,initial-scale=1">
<style>
  :root { color-scheme: dark; }
  body { margin:0; min-height:100vh; display:grid; place-items:center; background:#141414; color:#e8e8e8;
         font:15px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif; }
  .card { width:min(560px,92vw); padding:32px; border-radius:16px; background:#1d1d1f; border:1px solid #2c2c2e; }
  h1 { margin:0 0 8px; font-size:20px; }
  p { margin:12px 0; color:#a1a1a6; }
  code { background:#000; padding:2px 6px; border-radius:6px; color:#e8e8e8; }
  button { margin-top:8px; padding:10px 20px; border-radius:10px; border:0; background:#4f7cff; color:#fff;
           font-size:15px; cursor:pointer; }
  button[disabled] { background:#3a3a3c; cursor:default; }
  .ok { color:#4ade80; } .err { color:#f87171; } .log { white-space:pre-wrap; font-size:12px; color:#6b6b70;
        max-height:180px; overflow:auto; margin-top:12px; }
</style></head>
<body><div class="card">
  <h1>还差一步：装一下 ${engineWord}</h1>
  <p>${brand} 的默认智能体是 <b>${engineWord}</b>，但这台机器上没有找到它。</p>
  <p>点下面的按钮，我会把它装到 <code>~/.oh-my-agent-web</code>（你自己的 npm 目录，不碰系统、不用 sudo）：</p>
  <button id="go">安装 ${engineWord}</button>
  <div id="out"></div>
</div>
<script>
  const go = document.getElementById('go'), out = document.getElementById('out');
  go.onclick = async () => {
    go.disabled = true; out.innerHTML = '<p>正在安装，需要联网，通常 1–2 分钟…</p>';
    try {
      const response = await fetch('/api/engines/install', {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'pi' }),
      });
      const body = await response.json();
      out.innerHTML = response.ok
        ? '<p class="ok">' + body.message + '</p><p>关掉这个页面，重新打开 ${brand} 即可。</p>'
        : '<p class="err">' + body.message + '</p>';
    } catch (error) {
      out.innerHTML = '<p class="err">安装请求失败：' + error.message + '</p>';
    } finally { go.disabled = false; }
  };
</script>
</body></html>`;

export type PiGateOptions = {
	port: number;
	host: string;
	dataDir: string;
	/** 打开浏览器（由 cli.ts 传进来：它已经有跨平台的 openBrowser，且尊重 TTY / --no-open） */
	openUrl?: (url: string) => void;
	log?: (line: string) => void;
};

/**
 * 启动兜底页面服务。返回后进程就停在这里 —— 真正的服务要等用户把 pi 装完再启动。
 */
export function startPiGate(options: PiGateOptions): Promise<void> {
	const log = options.log ?? (() => {});
	const server = createServer((request, response) => {
		const url = request.url ?? "/";
		if (request.method === "GET" && (url === "/" || url.startsWith("/?"))) {
			response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
			response.end(PAGE(BRAND_NAME, "Pi Agent"));
			return;
		}
		if (request.method === "GET" && url === "/api/engines") {
			response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
			response.end(JSON.stringify({ engines: [engineStatus("pi", { dataDir: options.dataDir })] }));
			return;
		}
		if (request.method === "POST" && url === "/api/engines/install") {
			void (async () => {
				const outcome = await installEngine("pi", { dataDir: options.dataDir, log });
				if (outcome.ok) log(`pi 已装好：${outcome.path ?? "(入口待重启确认)"}`);
				else log(`pi 安装失败：${outcome.message}`);
				response.writeHead(outcome.ok ? 200 : 502, { "content-type": "application/json; charset=utf-8" });
				response.end(JSON.stringify(outcome));
			})();
			return;
		}
		response.writeHead(404, { "content-type": "text/plain; charset=utf-8" });
		response.end("not found");
	});

	// 只听本机：这是个「装机页面」，不该让局域网里的人点得到
	return new Promise<void>((resolve, reject) => {
		server.once("error", reject);
		server.listen(options.port, "127.0.0.1", () => {
			const url = `http://127.0.0.1:${options.port}`;
			log(`${BRAND_NAME} 还没装 Pi Agent（默认智能体）。先装它：${url}`);
			options.openUrl?.(url);
			resolve();
		});
	});
}

/** 当前这份安装里有没有 pi 模块（没有 → 该走兜底页面而不是启动服务） */
export function piMissing(): boolean {
	return piModulePath() === null;
}
