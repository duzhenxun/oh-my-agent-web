/**
 * 界面提示牌（ADR-0013）：分级 + 同码去重 + 条数上限。
 *
 * 从 runtime 拆出来（ADR-0010 的 400 行护栏第四次咬人）：提示是独立职责 ——
 * 「怎么显示一条提示」不该和「会话怎么跑」混在一个文件里，也便于单独测去重窗口。
 */
import type { Notice } from "../protocol.js";

export type NoticeSink = {
	/** 返回 Notice 表示真的推送了；返回 null 表示被去重窗口吃掉了 */
	push: (text: string, level: Notice["level"]) => Notice | null;
	all: () => Notice[];
};

export type NoticeSinkOptions = {
	now: () => number;
	nextId: (prefix: string) => string;
	/** 同 level+同文本 在这个窗口内只推一次（默认 5s） */
	dedupeMs?: number;
	/** 最多保留多少条（默认 20；界面只显示最近几条） */
	max?: number;
	/** 真正推给界面 */
	onNotice: (notice: Notice) => void;
};

export function createNoticeSink(options: NoticeSinkOptions): NoticeSink {
	const dedupeMs = options.dedupeMs ?? 5000;
	const max = options.max ?? 20;
	const recent = new Map<string, number>();
	let notices: Notice[] = [];

	return {
		push(text, level) {
			const key = `${level}:${text}`;
			const ts = options.now();
			const last = recent.get(key);
			if (last !== undefined && ts - last < dedupeMs) return null;
			recent.set(key, ts);

			const notice: Notice = { id: options.nextId("notice"), level, text, ts };
			notices = [...notices, notice].slice(-max);
			options.onNotice(notice);
			return notice;
		},
		all: () => notices,
	};
}
