/**
 * 路径解析的小工具（纯函数，便于单测）。
 *
 * 为什么需要它：`server/index.ts` 既可能**由源码运行**（`tsx server/index.ts`，开发态），
 * 也可能**由编译产物运行**（`node dist/server/index.js`，生产态）。两种情况下
 * 「`web/dist` 在哪」的层数不一样，写死相对路径必然有一头是错的（M1 就踩了：
 * 开发态把 webDist 指到了仓库外面，结果静态资源 404）。
 */
import { join } from "node:path";

export function pickExisting(candidates: string[], exists: (path: string) => boolean): string | null {
	for (const candidate of candidates) if (exists(candidate)) return candidate;
	return null;
}

/** web/dist 的候选路径：先是「源码运行」，再是「编译后运行」 */
export function webDistCandidates(serverDir: string): string[] {
	return [join(serverDir, "..", "web", "dist"), join(serverDir, "..", "..", "web", "dist")];
}
