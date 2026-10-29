/**
 * 技能相关的 HTTP 路由（P8 + 技能市场）。
 *
 * 走 HTTP 而不是 WS，因为这是「按需查询的目录数据」，不属于会话状态，
 * 放进快照只会让每一帧都驼着上百个技能。
 *
 *   GET  /api/skills                 列表（含启停状态与文件清单）
 *   POST /api/skills/enabled         { ids: string[], enabled: boolean } 批量启停
 *   GET  /api/skills/:id/file?path=  读技能里的文件（只读预览）
 *   GET  /api/skills/hub             技能市场：?q=&category=&page=&refresh=1
 *   POST /api/skills/install         { source: "hub" | "git" | "manual", … }
 *                                    hub:    { slug, name? }
 *                                    git:    { repoUrl, skill? }  // 不给 skill = 先列仓库里有什么
 *                                    manual: { name, raw? }
 *   POST /api/skills/remove          { id } 或 { ids: string[] } 删除技能（整目录，可批量）
 *
 * 安装目标固定是 `~/.agents/skills`（`skillStore.dir`），也就是列表里那份 ——
 * 「装到哪」和「看到哪」必须是同一个目录，否则装完看不见，用户会以为没装上。
 */
import type { Express } from "express";
import { HUB_CATEGORIES, createSkillHub, listSkillDirs, type SkillHub } from "./skillhub.js";
import { createSkillInstaller, type SkillInstaller } from "./skill-install.js";
import { createSkillStore, type SkillStore } from "./skill-store.js";

export function registerSkillRoutes(app: Express, options: { skills?: SkillStore; onChange?: () => void } = {}): void {
	const skills = options.skills ?? createSkillStore();
	const skillsRoot = skills.dir;
	const hub: SkillHub = createSkillHub();
	const installer: SkillInstaller = createSkillInstaller({ skillsRoot, hub });

	/** 安装成功后刷新列表：界面一次请求拿到「新列表 + 提示」，不用再打一次 */
	const afterInstall = async (result: { ok: boolean; error?: string }, notice: string) => ({
		...(result.ok ? { notice } : { installError: result.error ?? "安装失败" }),
		skills: await skills.list(),
	});

	app.get("/api/skills", async (_request, response) => {
		response.json({ skills: await skills.list(), root: skillsRoot });
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

	// ---- 技能市场 ----
	app.get("/api/skills/hub", async (request, response) => {
		const query = typeof request.query.q === "string" ? request.query.q : "";
		const rawCategory = typeof request.query.category === "string" ? request.query.category : "";
		const category = HUB_CATEGORIES.some((item) => item.key === rawCategory) ? rawCategory : "";
		const page = Number.parseInt(typeof request.query.page === "string" ? request.query.page : "1", 10) || 1;
		try {
			const result = await hub.search({
				query,
				category,
				page,
				pageSize: 24,
				refresh: request.query.refresh === "1",
			});
			// 已安装的标记：按目录名比（安装时目录名就是 slug / 技能名，见 skill-install.ts）
			const installed = new Set(await listSkillDirs(skillsRoot));
			response.json({
				...result,
				skills: result.skills.map((skill) => ({
					...skill,
					installed: installed.has(skill.slug) || installed.has(skill.name),
				})),
				categories: HUB_CATEGORIES,
			});
		} catch (error) {
			response.status(502).json({
				error: { code: "skills.hub_failed", message: error instanceof Error ? error.message : String(error) },
			});
		}
	});

	app.post("/api/skills/install", async (request, response) => {
		const body = request.body as Record<string, unknown> | undefined;
		const source = body?.source;
		const text = (value: unknown) => (typeof value === "string" ? value : undefined);

		if (source === "hub") {
			const slug = text(body?.slug) ?? "";
			if (slug === "") {
				response.status(400).json({ error: { code: "skills.no_slug", message: "没有指定要装的技能" } });
				return;
			}
			const result = await installer.fromHub({ slug, name: text(body?.name) });
			response.json(await afterInstall(result, `已安装「${text(body?.name) ?? slug}」`));
			return;
		}

		if (source === "git") {
			const repoUrl = text(body?.repoUrl) ?? "";
			const skill = text(body?.skill);
			// 没给 skill = 先看仓库里有什么（两段式），给了才真装
			if (skill === undefined || skill === "") {
				response.json(await installer.listRepo(repoUrl));
				return;
			}
			const result = await installer.fromRepo({ repoUrl, skill, name: text(body?.name) });
			response.json(await afterInstall(result, `已从仓库安装「${skill}」`));
			return;
		}

		if (source === "manual") {
			const name = text(body?.name) ?? "";
			const result = await installer.manual({ name, raw: text(body?.raw) });
			response.json(await afterInstall(result, `已创建「${name}」`));
			return;
		}

		response.status(400).json({ error: { code: "skills.bad_source", message: "不认识的安装方式" } });
	});

	app.post("/api/skills/remove", async (request, response) => {
		const body = request.body as { id?: unknown; ids?: unknown } | undefined;
		// 单个（老的调用点）与批量（左栏多选）都走这一条：删除是「一个目录一个目录地删」，
		// 批量只是循环，没必要再加一个端点
		const ids = Array.isArray(body?.ids)
			? body.ids.filter((item): item is string => typeof item === "string")
			: typeof body?.id === "string"
				? [body.id]
				: [];
		if (ids.length === 0) {
			response.status(400).json({ error: { code: "skills.no_id", message: "没有指定要删除的技能" } });
			return;
		}
		const removed: string[] = [];
		const failures: string[] = [];
		for (const id of ids) {
			const result = await installer.remove(id);
			if (result.ok) removed.push(id);
			else failures.push(`${id}：${result.error ?? "删除失败"}`);
		}
		options.onChange?.();
		response.json({
			...(removed.length > 0
				? { notice: removed.length === 1 ? `已删除「${removed[0]}」` : `已删除 ${removed.length} 个技能` }
				: {}),
			...(failures.length > 0 ? { removeError: failures.join("；") } : {}),
			skills: await skills.list(),
		});
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
