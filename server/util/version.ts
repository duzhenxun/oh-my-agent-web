/**
 * 版本号（界面右下角那行 `web v0.1.0 · pi v1.3.0` 要显示的两个数）。
 *
 * 为什么要真读而不是写死：
 *   - `package.json` 的 version 是发版的事实源，写死必然对不上；
 *   - 引擎版本来自它自己的 `package.json`（ADR-0003：只有 server/engine 能碰 SDK，
 *     读它的版本也在那里做，见 `pi-sdk.ts` 的 `version()`）。
 *
 * 这里只解决「web 自己的版本」：从当前模块所在目录一路往上找 `package.json`。
 * 开发态（server/…）与构建后（dist/server/…）层级不同，所以是「往上找」而不是写死相对路径。
 */
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";

const PACKAGE_NAME = "agentweb";

let cached: string | null = null;

/** web 版本；找不到就回 `"unknown"`（界面照常显示，不因为读不到文件就整块消失） */
export function webVersion(fromUrl: string = import.meta.url): string {
	if (cached !== null) return cached;
	let dir = dirname(fromUrl.startsWith("file:") ? new URL(fromUrl).pathname : fromUrl);
	for (let depth = 0; depth < 5; depth += 1) {
		try {
			const parsed = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
				name?: unknown;
				version?: unknown;
			};
			if (parsed.name === PACKAGE_NAME && typeof parsed.version === "string") {
				cached = parsed.version;
				return cached;
			}
		} catch {
			// 这一层没有 / 读不了 → 继续往上
		}
		const parent = dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	cached = "unknown";
	return cached;
}
