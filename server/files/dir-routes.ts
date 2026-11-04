/**
 * 目录浏览（「新建项目」用）：**只读列目录**，不创建、不删除任何东西。
 *
 * 与文件面板的区别：这里要能走出当前工作区（新建项目就是要在别处选目录），
 * 所以只做「绝对路径 + 存在 + 是目录」的校验，且只返回**目录名**（不返回文件、不返回内容）。
 */
import { realpathSync, statSync } from "node:fs";
import { readdir, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import type { Express } from "express";
import { isIgnoredEntry } from "./file-service.js";
import { normalizePathInput } from "../util/paths.js";

export type DirEntry = { name: string; path: string };

/**
 * Windows 上的盘符列表（`C:` → `C:\`）。
 *
 * 为什么必须有：Windows 没有 `/` 这种唯一的树根 —— 到了 `C:\` 就**上不去了**，
 * 用户想选 `D:\code` 时界面里根本没有入口（`/api/fs/dirs` 的「上级目录」在盘根是 null）。
 * 其它平台返回空数组，前端只在非空时显示这一行。
 */
function windowsDrives(): DirEntry[] {
	if (process.platform !== "win32") return [];
	const drives: DirEntry[] = [];
	for (let code = "A".charCodeAt(0); code <= "Z".charCodeAt(0); code += 1) {
		const name = `${String.fromCharCode(code)}:`;
		try {
			// 没插盘的 A:/B:、断开映射的网络盘会抛错 —— 跳过，不要让一个坏盘拖垮整个列表
			if (statSync(`${name}\\`).isDirectory()) drives.push({ name, path: `${name}\\` });
		} catch {
			/* 没有这个盘 */
		}
	}
	return drives;
}

/**
 * 这一个条目是不是「能进去的目录」。
 *
 * Windows 上的 junction（`C:\Users\x\Application Data`、`Documents and Settings`）
 * 和目录符号链接在 `Dirent` 里是 **symlink 而不是 directory** —— 只看 `isDirectory()`
 * 会把它们从列表里吞掉；而这类目录恰好是用户目录下最常见的跳转点。
 * 只有遇到 symlink 才多一次 `stat`，普通目录零成本。
 */
async function isDirectoryEntry(parent: string, item: import("node:fs").Dirent): Promise<boolean> {
	if (item.isDirectory()) return true;
	if (!item.isSymbolicLink()) return false;
	try {
		return (await stat(join(parent, item.name))).isDirectory();
	} catch {
		// 断链 / 没权限：当作不可进入
		return false;
	}
}

export function registerDirRoutes(app: Express, options: { workspaceOf: () => string | null }): void {
	app.get("/api/fs/dirs", async (request, response) => {
		// 用户可能是「复制文件地址」粘贴进来的（带引号）、或只写了 `C:` —— 先归一化再判断。
		const asked = typeof request.query.path === "string" ? normalizePathInput(request.query.path) : "";
		// 显式给了路径但不是绝对路径：**说清楚**，不要静默回落成当前工作区
		// （以前的表现就是「跳转按了没反应」，用户以为坏了）
		if (asked !== "" && !isAbsolute(asked)) {
			response.status(400).json({
				error: { code: "fs.not_absolute", message: `请输入绝对路径（例如 C:\\Users\\你的用户名）：${asked}` },
			});
			return;
		}
		const raw = asked !== "" ? asked : (options.workspaceOf() ?? homedir());
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
			const visible = items.filter((item) => !item.name.startsWith(".") && !isIgnoredEntry(item.name));
			const checks = await Promise.all(visible.map((item) => isDirectoryEntry(real, item)));
			entries = visible
				.filter((_item, index) => checks[index] === true)
				.map((item) => ({ name: item.name, path: join(real, item.name) }))
				.sort((a, b) => a.name.localeCompare(b.name))
				.slice(0, 500);
		} catch {
			response.status(403).json({ error: { code: "fs.unreadable", message: "这个目录读不了（权限）" } });
			return;
		}
		response.json({
			path: real,
			parent: real === dirname(real) ? null : dirname(real),
			entries,
			// 盘根处「上级目录」是 null，切盘只能靠这一行（非 Windows 平台上是空数组）
			drives: windowsDrives(),
		});
	});
}
