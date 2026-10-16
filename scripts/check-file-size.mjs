/**
 * 守卫 4：单文件行数上限（ADR-0010 的附加护栏）。
 *
 * 源码文件不超过 400 行。超过通常说明一个文件在干两件事；
 * 拆开永远比三个月后重构便宜。（文档 / 配置 / 锁文件不在范围内。）
 */
import { countLines, isMain, readRepoFile, runGuard, walk } from "./lib/guard-kit.mjs";

export const id = "file-size";
export const describe = `源码单文件不超过 ${400} 行（ADR-0010）`;
export const LIMIT = 400;

const SOURCE_DIRS = ["server", "web/src", "scripts", "tests"];
const EXTENSIONS = [".ts", ".tsx", ".mjs", ".css"];

/** input: { files: [{ path, lines }] } */
export function inspect({ files = [] } = {}) {
	return files
		.filter((file) => file.lines > LIMIT)
		.map((file) => `${file.path} 有 ${file.lines} 行（上限 ${LIMIT}）；拆成职责更小的文件，或先写 ADR 上调上限`);
}

export function collect() {
	const paths = SOURCE_DIRS.flatMap((dir) => walk(dir, EXTENSIONS)).filter((path) => !path.includes("/lib/vendor/"));
	return { files: paths.map((path) => ({ path, lines: countLines(readRepoFile(path)) })) };
}

export const selfTests = [
	{ name: `正好 ${LIMIT} 行应通过`, input: { files: [{ path: "server/a.ts", lines: LIMIT }] }, shouldFail: false },
	{ name: `超过 ${LIMIT} 行应变红`, input: { files: [{ path: "server/b.ts", lines: LIMIT + 1 }] }, shouldFail: true },
	{
		name: "多个文件里只有超限的报错",
		input: {
			files: [
				{ path: "server/c.ts", lines: 10 },
				{ path: "server/d.ts", lines: 900 },
			],
		},
		shouldFail: true,
	},
];

const guard = { id, describe, inspect, collect, selfTests };
if (isMain(import.meta.url)) runGuard(guard);
