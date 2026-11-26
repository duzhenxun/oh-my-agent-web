/**
 * `/api/computer`：电脑控制的状态、设置、Skill 启停。
 *
 *   GET  /status            helper 与权限状态，Skill 是否启用
 *   GET  /settings          读取设置（来自 helper 的 settings.json / allow-protected.txt）
 *   PUT  /settings          写入设置（只改提交的键）
 *   POST /skill  {enabled}  启用或禁用 Skill（写入 / 改名 ~/.agents/skills/agent-computer）
 *   GET  /apps?query=微信   已安装应用模糊搜索（给「解除保护的应用」输入框做联想）
 *   POST /open-privacy {pane} 打开 macOS「隐私与安全性」里对应的那一页（辅助功能 / 屏幕录制）
 */
import { spawn } from "node:child_process";
import express, { type Response } from "express";
import { getComputerStatus, requestComputerAccess } from "./status.js";
import { installHelper, startHelper } from "./install-helper.js";
import { listInstalledApps, searchApps } from "./apps.js";
import { readSettings, writeSettings } from "./settings.js";
import { disableSkill, enableSkill } from "./skill.js";

function failure(res: Response, error: unknown): void {
	res.status(400).json({ error: error instanceof Error ? error.message : String(error) });
}

export function createComputerRouter(): express.Router {
	const router = express.Router();

	router.get("/status", async (_req, res) => {
		try {
			res.json(await getComputerStatus());
		} catch (error) {
			failure(res, error);
		}
	});

	router.get("/settings", (_req, res) => {
		try {
			res.json(readSettings());
		} catch (error) {
			failure(res, error);
		}
	});

	router.put("/settings", (req, res) => {
		try {
			res.json(writeSettings(req.body));
		} catch (error) {
			failure(res, error);
		}
	});

	router.get("/apps", async (req, res) => {
		try {
			const query = typeof req.query.query === "string" ? req.query.query : "";
			const apps = await listInstalledApps();
			// 不带 query 时给前若干个，方便输入框一聚焦就能看到常用候选
			const matched = query.trim() === "" ? apps.slice(0, 12) : searchApps(apps, query);
			res.json({
				apps: matched.map((app) => ({ name: app.name, bundleId: app.bundleId, path: app.path })),
				total: apps.length,
			});
		} catch (error) {
			failure(res, error);
		}
	});

	router.post("/skill", async (req, res) => {
		try {
			if (typeof req.body?.enabled !== "boolean") throw new Error("enabled 必须是布尔值");
			if (req.body.enabled) enableSkill();
			else disableSkill();
			res.json(await getComputerStatus());
		} catch (error) {
			failure(res, error);
		}
	});

	/**
	 * 打开系统设置里对应的权限页（2026-11-24 用户：「引导或者有个按钮点一下自动打开」）。
	 *
	 * 为什么由服务端 `open`，而不是前端 `window.open("x-apple.systempreferences:...")`：
	 * 浏览器/Electron 渲染进程对自定义 scheme 的处理不一致（有的直接静默丢掉），
	 * 而服务端本来就在本机跑，`open` 一条命令最稳。
	 *
	 * 只支持 macOS：那两个 URL scheme 是 Apple 的，别的平台上明确报错而不是假装成功。
	 */
	router.post("/open-privacy", (req, res) => {
		try {
			if (process.platform !== "darwin") throw new Error("「打开系统设置」只在 macOS 上有意义");
			const pane = String(req.body?.pane ?? "");
			const target =
				pane === "accessibility"
					? "x-apple.systempreferences:com.apple.preference.security?Privacy_Accessibility"
					: pane === "screen"
						? "x-apple.systempreferences:com.apple.preference.security?Privacy_ScreenCapture"
						: null;
			if (!target) throw new Error(`pane 只能是 accessibility / screen（收到 ${pane}）`);
			spawn("open", [target], { stdio: "ignore", detached: true }).unref();
			res.json({ ok: true });
		} catch (error) {
			failure(res, error);
		}
	});

	/**
	 * 主动申请权限：会**把 helper 登记进系统设置的那两个列表**并弹一次授权框
	 * （用户 2026-11-24：「添授权时，自动添加到上面」——不想手动点 `+` 去挑可执行文件）。
	 * 前端在「去授权」按钮里先调它，再打开对应的设置页。
	 */
	router.post("/request-access", async (_req, res) => {
		try {
			await requestComputerAccess();
			res.json(await getComputerStatus());
		} catch (error) {
			failure(res, error);
		}
	});

	/**
	 * 一键安装 helper：服务端下载 → 解压 → 装进「应用程序」→ 打开。
	 *
	 * 为什么不让用户从浏览器下载：浏览器会给 zip 打 com.apple.quarantine，
	 * 解压出的 .app 被 Gatekeeper 拦，而新版 macOS 不允许用「右键 → 打开」绕过，
	 * 用户得去「系统设置 → 隐私与安全性」点「仍要打开」—— 四步，每步都像出了事。
	 */
	router.post("/helper/install", async (_req, res) => {
		const result = await installHelper();
		res.status(result.ok ? 200 : 502).json(result);
	});

	/** 启动已装好的 helper：面板上「连接 helper 失败」时那颗按钮用它 */
	router.post("/helper/start", async (_req, res) => {
		const result = await startHelper();
		res.status(result.ok ? 200 : 502).json(result);
	});

	return router;
}
