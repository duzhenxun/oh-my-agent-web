/**
 * 版本号的**唯一来源**：本包的 `package.json`。
 *
 * 三处会用到它，必须读同一份、算同一个值：
 *   - 新会话抬头 `web v0.1.0 · pi v1.3.0`（快照里的 `versions.web`）
 *   - `/api/health` 的 `version`（`aw status` 用它判断「跑着的进程是不是旧版」）
 *   - `aw version` / `aw upgrade`
 *
 * 为什么是「从当前模块往上找 package.json」而不是写死相对路径：开发态在 `server/util/`、
 * 构建后在 `dist/server/util/`，层级不同；而且不能写死包名 —— 包名已经改过一次
 * （`agentweb` → `oh-my-agent-web`），写死就会静默退化成 `unknown`（踩过）。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

type PackageMeta = { name: string; version: string; private: boolean };

let cached: PackageMeta | null = null;

/**
 * 读本包的 package.json。
 *
 * 从模块所在目录一路往上找，最多 5 层：`dist/server/util` → `dist/server` → `dist` → 包根。
 * 认「有 name + version 的第一份」即可 —— 起点就在我们自己目录里，先撞到的必然是本包。
 */
export function packageMeta(fromUrl: string = import.meta.url): PackageMeta {
	if (cached) return cached;
	let dir = dirname(fromUrl.startsWith("file:") ? fileURLToPath(fromUrl) : fromUrl);
	for (let depth = 0; depth < 5; depth += 1) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
				private?: unknown;
			};
			if (typeof parsed.name === "string" && typeof parsed.version === "string") {
				cached = { name: parsed.name, version: parsed.version, private: parsed.private === true };
				return cached;
			}
		} catch {
			// 这一层没有 / 读不了 → 继续往上
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	// 读不到也别让界面炸：显示 unknown，其余功能照常
	cached = { name: "oh-my-agent-web", version: "unknown", private: true };
	return cached;
}

/** web 版本；找不到就回 `"unknown"` */
export function webVersion(fromUrl: string = import.meta.url): string {
	return packageMeta(fromUrl).version;
}
