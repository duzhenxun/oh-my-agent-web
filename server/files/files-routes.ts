/**
 * 文件浏览的 HTTP 路由（M4）——从 index.ts 抽出（400 行护栏）。
 *
 *   `GET /api/files/list?path=<相对路径>` → 列一层目录（懒惰展开）
 *   `GET /api/files/read?path=<相对路径>` → 只读预览（≤512KB，二进制给标记）
 *
 * `workspaceOf()` 返回**当前会话**的工作区（多项目：文件树跟着当前会话走，ADR-0021 §3）。
 */
import { createReadStream, realpathSync, statSync } from "node:fs";
import type { Express } from "express";
import { listDirectory, parseRange, readPreview, readRaw, resolveMediaFile } from "./file-service.js";
import { searchFiles } from "./file-search.js";
import { checkoutBranch, readGitBranches } from "./git-info.js";

export function registerFileRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	app.get("/api/files/list", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		// 隐藏文件由界面的「眼睛」按钮显式打开（?hidden=1）
		const result = await listDirectory(root, relPath, { showHidden: request.query.hidden === "1" });
		if (!result.ok) {
			response.status(400).json({ error: { code: "files.list_failed", message: result.error } });
			return;
		}
		response.json(result);
	});

	// markdown 图片用：直接回字节（只放行图片/PDF 白名单，仍受工作区约束）
	app.get("/api/files/raw", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await readRaw(root, relPath);
		if (!result.ok) {
			response.status(result.tooLarge ? 413 : 400).json({ error: { code: "files.raw_failed", message: result.error } });
			return;
		}
		response.setHeader("Content-Type", result.mime);
		response.setHeader("Cache-Control", "private, max-age=60");
		response.send(result.bytes);
	});

	/**
	 * 视频 / 音频：**流式 + Range**（拖动进度条、边下边播都靠它）。
	 * 只让白名单里的媒体类型通过；大小上限 4GB；路径同样受工作区约束。
	 */
	app.get("/api/files/media", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const file = await resolveMediaFile(root, relPath);
		if (!file.ok) {
			response.status(file.tooLarge ? 413 : 400).json({ error: { code: "files.media_failed", message: file.error } });
			return;
		}
		const range = parseRange(request.headers.range, file.size);
		response.setHeader("Content-Type", file.mime);
		response.setHeader("Accept-Ranges", "bytes");
		response.setHeader("Cache-Control", "private, max-age=600");
		if (range) {
			response.status(206);
			response.setHeader("Content-Range", `bytes ${range.start}-${range.end}/${file.size}`);
			response.setHeader("Content-Length", String(range.end - range.start + 1));
		} else {
			response.setHeader("Content-Length", String(file.size));
		}
		if (request.method === "HEAD") {
			response.end();
			return;
		}
		createReadStream(file.path, range ? { start: range.start, end: range.end } : undefined)
			.on("error", () => response.destroy())
			.pipe(response);
	});

	/** 文件名搜索（放大镜）：只匹配名字，不做内容搜索 */
	app.get("/api/files/search", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const query = typeof request.query.q === "string" ? request.query.q : "";
		const result = await searchFiles(root, query);
		if (!result.ok) {
			response.status(400).json({ error: { code: "files.search_failed", message: result.error } });
			return;
		}
		response.json(result);
	});

	/** 当前项目的 git 信息（分支名 + 本地分支清单；不是仓库就 isRepo=false） */
	app.get("/api/files/git", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response.json({ isRepo: false, branch: null, branches: [] });
			return;
		}
		response.json(await readGitBranches(root));
	});

	/**
	 * 切分支：`{ root, branch, force? }` → `git checkout <branch>`。
	 * 只接受**本地已有分支**；工作区有未提交改动时先 409 回一份改动清单（`files.dirty_worktree`），
	 * 界面确认后带 `force: true` 再发一次。冲突时 git 会拒绝，报错原样回给界面。
	 */
	app.post("/api/files/git/checkout", async (request, response) => {
		const body = request.body as { root?: unknown; branch?: unknown; force?: unknown } | undefined;
		const root = rootOf(body?.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		if (typeof body?.branch !== "string" || body.branch.trim() === "") {
			response.status(400).json({ error: { code: "files.no_branch", message: "没有指定要切换的分支" } });
			return;
		}
		const result = await checkoutBranch(root, body.branch, { force: body.force === true });
		if (!result.ok) {
			if (result.dirty) {
				response.status(409).json({
					error: {
						code: "files.dirty_worktree",
						message: `工作区有 ${result.dirty.total} 个未提交改动`,
						files: result.dirty.files,
						total: result.dirty.total,
					},
				});
				return;
			}
			response.status(400).json({ error: { code: "files.checkout_failed", message: result.message } });
			return;
		}
		response.json({ ...(await readGitBranches(root)), branch: result.branch });
	});

	app.get("/api/files/read", async (request, response) => {
		const root = rootOf(request.query.root, options.workspaceOf());
		if (!root) {
			response
				.status(409)
				.json({ error: { code: "files.no_workspace", message: "还没有打开会话（不知道是哪个项目）" } });
			return;
		}
		const relPath = typeof request.query.path === "string" ? request.query.path : "";
		const result = await readPreview(root, relPath);
		if (!result.ok) {
			response.status(400).json({ error: { code: "files.read_failed", message: result.error } });
			return;
		}
		response.json(result);
	});
}

/**
 * 文件根目录：默认是当前会话的工作区；「在文件中打开」某个项目时传 root 覆盖。
 * 校验：必须是存在的目录（realpath）。不做工作区包含检查 —— 因为根目录本身就是工作区，
 * 一旦允许换根，"包含于工作区"就退化成"包含于自己"，没有意义；真正的边界是**只读**。
 */
function rootOf(raw: unknown, fallback: string | null): string | null {
	if (typeof raw !== "string" || !raw.startsWith("/")) return fallback;
	try {
		const real = realpathSync(raw);
		return statSync(real).isDirectory() ? real : fallback;
	} catch {
		return fallback;
	}
}
