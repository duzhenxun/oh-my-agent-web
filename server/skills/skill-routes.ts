/**
 * 技能相关的 HTTP 路由（P8）：走 HTTP 而不是 WS，因为这是「按需查询的目录数据」，
 * 不属于会话状态，放进快照只会让每一帧都驼着 76 个技能。
 *
 *   GET  /api/skills                 列表（含启停状态与文件清单）
 *   POST /api/skills/enabled         { ids: string[], enabled: boolean } 批量启停
 *   GET  /api/skills/:id/file?path=  读技能里的文件（只读预览）
 */
import type { Express } from "express";
import { createSkillStore, type SkillStore } from "./skill-store.js";

export function registerSkillRoutes(app: Express, options: { skills?: SkillStore; onChange?: () => void } = {}): void {
	const skills = options.skills ?? createSkillStore();
	app.get("/api/skills", async (_request, response) => {
		response.json({ skills: await skills.list() });
	});

	app.post("/api/skills/enabled", async (request, response) => {
		const body = request.body as { ids?: unknown; enabled?: unknown } | undefined;
		const ids = Array.isArray(body?.ids) ? body.ids.filter((item): item is string => typeof item === "string") : [];
		if (ids.length === 0) {
			response.status(400).json({ error: { code: "skills.no_ids", message: "没有指定要操作的技能" } });
			return;
		}
		const enabled = body?.enabled === true;
		const result = await skills.setEnabled(ids, enabled);
		options.onChange?.();
		response.json({ ...result, skills: await skills.list() });
	});

	app.get("/api/skills/:id/file", async (request, response) => {
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await skills.readFile(request.params.id, relPath);
		if (!result.ok) {
			response.status(400).json({ error: { code: "skills.read_failed", message: result.error } });
			return;
		}
		response.json(result);
	});
}
