/**
 * 目录浏览（「新建项目」用）：**只读列目录**，不创建、不删除任何东西。
 *
 * 与文件面板的区别：这里要能走出当前工作区（新建项目就是要在别处选目录），
 * 所以只做「绝对路径 + 存在 + 是目录」的校验，且只返回**目录名**（不返回文件、不返回内容）。
 */
import { realpathSync, statSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { Express } from "express";

export type DirEntry = { name: string; path: string };

export function registerDirRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	app.get("/api/fs/dirs", async (request, response) => {
		const raw =
			typeof request.query.path === "string" && request.query.path.startsWith("/")
				? request.query.path
				: (options.workspaceOf() ?? process.env.HOME ?? "/");
		let real: string;
		try {
			real = realpathSync(raw);
			if (!statSync(real).isDirectory()) throw new Error("not a directory");
		} catch {
			response.status(400).json({ error: { code: "fs.bad_path", message: "不是可用的目录" } });
			return;
		}
		let entries: DirEntry[] = [];
		try {
			const items = await readdir(real, { withFileTypes: true });
			entries = items
				.filter((item) => item.isDirectory() && !item.name.startsWith(".") && item.name !== "node_modules")
				.map((item) => ({ name: item.name, path: join(real, item.name) }))
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 500);
		} catch {
			response.status(403).json({ error: { code: "fs.unreadable", message: "这个目录读不了（权限）" } });
			return;
		}
		response.json({ path: real, parent: real === "/" ? null : dirname(real), entries });
	});
}
