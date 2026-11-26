/**
 * 本地语音识别的 HTTP 路由（配合 `bridge.ts`）。
 *
 * 为什么不是 WebSocket：浏览器每 ~300ms POST 一块 PCM，响应里顺带带回「当前 partial」，
 * 就够了 —— 不用新开一条通道、不用动鉴权/反代，出错也好查。
 *
 *   GET  /api/asr/status   状态（idle / starting / authorizing / ready / missing / error）
 *   POST /api/asr/install  已废弃：本地识别并进 Agent Computer，不再单独装 ASRBridge
 *   POST /api/asr/start    开一句新的（清掉上一句残留）
 *   POST /api/asr/chunk    送 16k 单声道 int16 PCM，返回 { text }（最新 partial）
 *   POST /api/asr/end      说完：等 final，返回 { text }
 */
import express, { type ErrorRequestHandler, type Express, type Response } from "express";
import { findHelperApp, helperDownloadUrl } from "../computer/paths.js";
import type { AsrService } from "./service.js";

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

/** 一块最多 512KB（320ms 的 16k 单声道 int16 才 10KB，给足余量） */
const MAX_CHUNK_BYTES = 512 * 1024;

export const asrRawErrorHandler: ErrorRequestHandler = (error, _req, res, _next) => {
	const tooLarge = (error as { type?: string })?.type === "entity.too.large";
	res.status(tooLarge ? 413 : 400).json({ error: tooLarge ? "语音块太大" : "语音块无效" });
};

/**
 * 面板上「还没装」时给前端的提示。
 *
 * 合并后它指向 **Agent Computer**（语音识别和电脑控制现在是同一个 helper），
 * 不再是已经删掉的 ASRBridge.app。`canAutoInstall` 保留原来的含义 ——
 * **这台机器支不支持本地识别**（只有 macOS 有 SFSpeechRecognizer）——
 * 不等于「服务端能代装」：服务端已经不再代装了，前端拿去当平台开关用。
 */
type AsrInstallHint = { downloadUrl: string; appPath: string; canAutoInstall: boolean };

function asrInstallHint(): AsrInstallHint {
	return {
		downloadUrl: helperDownloadUrl(),
		appPath: findHelperApp() ?? "（未安装）Agent Computer.app",
		canAutoInstall: process.platform === "darwin",
	};
}

function notReady(res: Response, bridge: AsrService): void {
	res.status(503).json(bridge.current());
}

export function registerAsrRoutes(app: Express, bridge: AsrService, _log?: Logger): void {
	app.get("/api/asr/status", (request, response) => {
		// 默认**只读状态**（打开设置面板不该顺带拉起一个会弹系统授权的进程）；
		// `?start=1` 才真的启动。开始听写时 `/api/asr/start` 本来就会拉起。
		const status = request.query.start === "1" ? bridge.ensureStarted() : bridge.current();
		// 没装时顺带把「去哪儿下、装到哪儿」告诉前端：面板直接给按钮，用户不用去翻 README
		response.json({ ...status, install: status.state === "missing" ? asrInstallHint() : null });
	});

	// 云端识别：能选哪些引擎、现在是谁、哪家配好了密钥。
	// 为什么不直接把选项写死在前端：引擎是服务端 stt.json 决定的，而且「千问整段」和
	// 「千问实时（边说边出字）」是两个 provider、两个模型、两种价格 —— 选错了体验完全不一样。
	app.get("/api/asr/engines", (_request, response) => {
		response.json(bridge.cloudEngines());
	});

	// 切引擎：写回 stt.json（保留别家的密钥），下一句生效
	app.post("/api/asr/engine", (request, response) => {
		const body = (request.body ?? {}) as { provider?: unknown; model?: unknown };
		const provider = typeof body.provider === "string" ? body.provider.trim() : "";
		if (!provider) {
			response.status(400).json({ error: "缺 provider" });
			return;
		}
		const model = typeof body.model === "string" ? body.model : undefined;
		try {
			response.json(bridge.selectCloud({ provider, model }));
		} catch (error) {
			response.status(400).json({ error: error instanceof Error ? error.message : String(error) });
		}
	});

	app.post("/api/asr/install", (_request, response) => {
		// 保留这个路由只是为了老前端不撞 404：本地识别已经没有独立安装包了
		response.status(410).json({
			ok: false,
			message: "本地识别已经并进 Agent Computer：装好并打开它即可，不再需要单独安装 ASRBridge",
			...asrInstallHint(),
		});
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

	app.post(
		"/api/asr/chunk",
		express.raw({ type: () => true, limit: MAX_CHUNK_BYTES }),
		async (request, response) => {
			if (bridge.current().state !== "ready") {
				notReady(response, bridge);
				return;
			}
			const bytes = Buffer.isBuffer(request.body) ? request.body : Buffer.alloc(0);
			response.json({ text: await bridge.pushAudio(bytes) });
		},
	);

	app.post("/api/asr/end", async (_request, response) => {
		if (bridge.current().state !== "ready") {
			notReady(response, bridge);
			return;
		}
		response.json({ text: await bridge.endUtterance() });
	});
}
