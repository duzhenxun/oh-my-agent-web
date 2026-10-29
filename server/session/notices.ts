/**
 * 界面提示牌（ADR-0013）：分级 + 同码去重 + 条数上限。
 *
 * 从 runtime 拆出来（ADR-0010 的 400 行护栏第四次咬人）：提示是独立职责 ——
 * 「怎么显示一条提示」不该和「会话怎么跑」混在一个文件里，也便于单独测去重窗口。
 */
import type { Notice } from "../protocol.js";

type NoticeSink = {
	/**
	 * 返回 Notice 表示真的推送了；返回 null 表示被去重窗口吃掉了。
	 * 传了 `key` 且已有同 key 的提示 → **原地替换**（保留 id），不会在对话流里再堆一行。
	 */
	push: (text: string, level: Notice["level"], noticeKey?: string, conversationId?: string) => Notice | null;
	all: () => Notice[];
};

type NoticeSinkOptions = {
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
		push(text, level, noticeKey, conversationId) {
			// 去重键带上会话：两个会话在同一秒报同一句话，是两条各自要看的提示，不能互相吞掉
			const key = `${level}:${conversationId ?? ""}:${text}`;
			const ts = options.now();
			const last = recent.get(key);
			if (last !== undefined && ts - last < dedupeMs) return null;
			recent.set(key, ts);

			// 同 key 原地替换：保留 id 与位置，只换文案/级别/时间戳
			const existing = noticeKey ? notices.find((notice) => notice.key === noticeKey) : undefined;
			const notice: Notice = {
				id: existing?.id ?? options.nextId("notice"),
				level,
				text,
				ts,
				...(noticeKey ? { key: noticeKey } : {}),
				...(conversationId ? { conversationId } : {}),
			};
			notices = existing
				? notices.map((item) => (item.id === existing.id ? notice : item))
				: [...notices, notice].slice(-max);
			options.onNotice(notice);
			return notice;
		},
		all: () => notices,
	};
}
