/**
 * 本地语音识别的 HTTP 路由（配合 `bridge.ts`）。
 *
 * 为什么不是 WebSocket：浏览器每 ~300ms POST 一块 PCM，响应里顺带带回「当前 partial」，
 * 就够了 —— 不用新开一条通道、不用动鉴权/反代，出错也好查。
 *
 *   GET  /api/asr/status   桥的状态（starting / authorizing / ready / missing / error）
 *   POST /api/asr/install  装一份本地识别程序（没装时才用得上）
 *   POST /api/asr/start    开一句新的（清掉上一句残留）
 *   POST /api/asr/chunk    送 16k 单声道 int16 PCM，返回 { text }（最新 partial）
 *   POST /api/asr/end      说完：等 final，返回 { text }
 */
import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import type { AsrBridge } from "./bridge.js";
import { asrInstallHint, installAsrApp } from "./install.js";

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

/** 一块最多 512KB（320ms 的 16k 单声道 int16 才 10KB，给足余量） */
const MAX_CHUNK_BYTES = 512 * 1024;

export const asrRawErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
	const tooLarge = (error as { type?: string })?.type === "entity.too.large";
	res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "语音块太大" : "语音块无效" });
};

function notReady(res: Response, bridge: AsrBridge): void {
	res.status(503).json(bridge.current());
}

export function registerAsrRoutes(app: Express, bridge: AsrBridge, log?: Logger): void {
	app.get("/api/asr/status", (request, response) => {
		// 默认**只读状态**（打开设置面板不该顺带拉起一个会弹系统授权的进程）；
		// `?start=1` 才真的启动。开始听写时 `/api/asr/start` 本来就会拉起。
		const status = request.query.start === "1" ? bridge.ensureStarted() : bridge.current();
		// 没装时顺带把「去哪儿下、装到哪儿」告诉前端：面板直接给按钮，用户不用去翻 README
		response.json({ ...status, install: status.state === "missing" ? asrInstallHint() : null });
	});

	app.post("/api/asr/install", async (_request, response) => {
		const result = await installAsrApp(log);
		// 失败不给 200：前端按状态码判断；body 里始终有可读的 message 和下载链接兜底
		response.status(result.ok ? 200 : 502).json(result);
	});

	app.post("/api/asr/start", (_request, response) => {
		const status = bridge.ensureStarted();
		if (status.state !== "ready") {
			notReady(response, bridge);
			return;
		}
		bridge.startUtterance();
		response.json({ ok: true });
	});

	app.post("/api/asr/chunk", express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }), (request, response) => {
		if (bridge.current().state !== "ready") {
			notReady(response, bridge);
			return;
		}
		const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
		bridge.pushAudio(bytes);
		response.json({ text: bridge.latestText() });
	});

	app.post("/api/asr/end", async (_request, response) => {
		if (bridge.current().state !== "ready") {
			notReady(response, bridge);
			return;
		}
		response.json({ text: await bridge.endUtterance() });
	});
}
