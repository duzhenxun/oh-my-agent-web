/**
 * 日志落文件 + 按大小轮转（ADR-0013 §B）。
 *
 * 为什么需要文件：前台运行时 stdout 会随终端关闭而消失，而排障需要的是**崩溃前**那几行。
 * 为什么不引日志库：这层总共 60 行，而且行为要精确可控（ADR-0008 的依赖预算也不允许）。
 *
 * 轮转：`agent-web.log` 超过上限 → 依次改名 `agent-web.log.1` / `.2` / …，最多保留 keep 个，
 * 最老的被丢弃。同步写（日志量小，换来的是「崩溃时最后一行也落地」）。
 */
import { appendFileSync, existsSync, mkdirSync, renameSync, rmSync, statSync } from "node:fs";
import { dirname, join } from "node:path";

export const DEFAULT_MAX_BYTES = 5 * 1024 * 1024;
export const DEFAULT_KEEP = 3;

export type RotatingFileSinkOptions = {
	file: string;
	maxBytes?: number;
	keep?: number;
	/** 出问题时的回调（日志自己不能把程序搞崩） */
	onError?: (message: string) => void;
};

export type RotatingFileSink = {
	write: (line: string) => void;
	/** 当前文件大小（测试与诊断用） */
	size: () => number;
};

/** 纯函数：决定要保留哪些归档（把最老的挤掉） */
export function archivePlan(keep: number): number[] {
	return Array.from({ length: Math.max(0, keep) }, (_, index) => index + 1);
}

export function createRotatingFileSink(options: RotatingFileSinkOptions): RotatingFileSink {
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const keep = options.keep ?? DEFAULT_KEEP;
	let size = 0;

	try {
		mkdirSync(dirname(options.file), { recursive: true });
		if (existsSync(options.file)) size = statSync(options.file).size;
	} catch (error) {
		options.onError?.(`准备日志文件失败：${error instanceof Error ? error.message : String(error)}`);
	}

	function rotate(): void {
		try {
			// 最老的先删：log.<keep> 没了，然后从 keep-1 往上挪
			const archives = archivePlan(keep);
			rmSync(`${options.file}.${archives[archives.length - 1]}`, { force: true });
			for (let index = archives.length - 1; index > 0; index -= 1) {
				const from = `${options.file}.${index}`;
				if (!existsSync(from)) continue;
				renameSync(from, `${options.file}.${index + 1}`);
			}
			if (existsSync(options.file)) renameSync(options.file, `${options.file}.1`);
			size = 0;
		} catch (error) {
			options.onError?.(`日志轮转失败：${error instanceof Error ? error.message : String(error)}`);
		}
	}

	return {
		write(line) {
			try {
				const payload = `${line}\n`;
				if (size + Buffer.byteLength(payload, "utf8") > maxBytes) rotate();
				appendFileSync(options.file, payload, "utf8");
				size += Buffer.byteLength(payload, "utf8");
			} catch (error) {
				options.onError?.(`写日志失败：${error instanceof Error ? error.message : String(error)}`);
			}
		},
		size: () => size,
	};
}

export function logFileName(dataDir: string): string {
	return join(dataDir, "logs", "agent-web.log");
}
