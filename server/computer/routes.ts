/**
 * `/api/computer`：电脑控制的状态、设置、Skill 启停。
 *
 *   GET  /status            helper 与权限状态，Skill 是否启用
 *   GET  /settings          读取设置（来自 helper 的 settings.json / allow-protected.txt）
 *   PUT  /settings          写入设置（只改提交的键）
 *   POST /skill  {enabled}  启用或禁用 Skill（写入 / 改名 ~/.agents/skills/agent-computer）
 *   GET  /apps?query=微信   已安装应用模糊搜索（给「解除保护的应用」输入框做联想）
 */
import express, { type Response } from "express";
import { getComputerStatus } from "./status.js";
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

	return router;
}
