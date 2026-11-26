/**
 * 引擎可用性 / 安装的 HTTP 路由（配合 `engine-install.ts`，ADR-0052）。
 *
 *   GET  /api/engines          五个引擎各自装没装、装在哪、能不能一键装
 *   POST /api/engines/install  装一个（`{ name }`）—— **只有用户点了按钮才会走到这里**
 *
 * 为什么用 HTTP 而不是塞进快照：这两个动作（装包、探测模块）都**不该**跟着每帧快照跑，
 * 而且只在「打开引擎面板 / 点了安装」时才需要。与 ASR 那条安装路由同一套做法。
 *
 * 两条纪律：
 *   1. **不主动探测**：`GET` 只读，不会去 spawn 任何引擎（问版本要起子进程，见 engine-versions.ts）；
 *   2. **串行安装**：同一个前缀上并发跑 npm 会互相踩，后来的请求直接拒绝。
 */
import type { Express } from "express";
import { ENGINE_KEYS, ENGINE_SPECS, isEngineKey } from "./engine-specs.js";
import { engineStatus, installEngine, type EngineStatus } from "./engine-install.js";

type Logger = {
	info?: (message: string, ctx?: Record<string, unknown>) => void;
	warn: (message: string, ctx?: Record<string, unknown>) => void;
};

/** pi 也在列表里（它是默认引擎）；顺序：pi 打头，其余按注册表 */
const ALL_ENGINES = ["pi", ...ENGINE_KEYS] as const;

export function registerEngineRoutes(app: Express, options: { dataDir: string; log?: Logger }): void {
	/** 正在装的引擎：同一时刻只允许一个（npm 会写同一个 prefix） */
	let installing: string | null = null;

	app.get("/api/engines", (_request, response) => {
		response.json({
			engines: ALL_ENGINES.map((name) => engineStatus(name, { dataDir: options.dataDir })),
			installing,
		});
	});

	app.post("/api/engines/install", async (request, response) => {
		const body = request.body as { name?: unknown } | undefined;
		const name = typeof body?.name === "string" ? body.name : "";
		if (!isEngineKey(name) && name !== "pi") {
			response.status(400).json({ ok: false, message: `没有这个引擎：${name || "(空)"}` });
			return;
		}
		if (installing !== null) {
			response.status(409).json({ ok: false, message: `正在装 ${installing}，等它装完再装下一个` });
			return;
		}
		if (!ENGINE_SPECS[name].packages.length) {
			// dsh 这种没有公开包的：不装，只说去哪儿
			response.status(400).json({ ok: false, message: `不能替你装：${ENGINE_SPECS[name].guide.join("；")}` });
			return;
		}

		installing = name;
		options.log?.info?.("开始安装引擎", { engine: name });
		try {
			const outcome = await installEngine(name, {
				dataDir: options.dataDir,
				log: (line) => options.log?.info?.(`[engine:${name}] ${line}`),
			});
			if (!outcome.ok) {
				options.log?.warn("引擎安装失败", { engine: name, message: outcome.message });
				// 失败不给 200：前端按状态码区分；body 里始终有可读的原因与备用引导
				response.status(502).json(outcome);
				return;
			}
			// 装完把最新的状态一起带回去，前端不用再请求一次
			response.status(200).json({ ...outcome, status: engineStatus(name, { dataDir: options.dataDir }) });
		} finally {
			installing = null;
		}
	});
}

/** 给启动日志/诊断用：当前有哪些引擎可用（只读，不 spawn） */
export function describeEngines(dataDir: string): EngineStatus[] {
	return ALL_ENGINES.map((name) => engineStatus(name, { dataDir }));
}
