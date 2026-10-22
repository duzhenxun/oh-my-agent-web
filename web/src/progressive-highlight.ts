/**
 * 逐行语法高亮的「分批上色」（大文件也能有颜色）。
 *
 * 之前的行为：超过 `MAX_HIGHLIGHT_LINES`（800 行）就整篇不上色 —— 打开一个几千行的
 * JSON / 日志就变成黑白，看起来像「坏了」。正确做法是**边显示边上色**：
 *   1. 第一屏（前 N 行）同步上色，立刻有颜色；
 *   2. 其余用 requestIdleCallback（回退 setTimeout）**一批一批**补上，
 *      每批之间让出主线程，滚动/输入不会被卡住。
 * 高亮结果按行号存成数组，没算到的行是 `undefined` → 渲染时退化成纯文本。
 */
import { useEffect, useState } from "react";

/** 第一批同步上色的行数（一屏多一点，保证打开就有颜色） */
export const EAGER_LINES = 300;
/** 每批补多少行 */
const BATCH = 600;

type IdleHandle = { kind: "idle"; id: number } | { kind: "timer"; id: ReturnType<typeof setTimeout> };

function scheduleIdle(callback: () => void): IdleHandle {
	const idle = (globalThis as { requestIdleCallback?: (cb: () => void, options?: { timeout: number }) => number })
		.requestIdleCallback;
	if (typeof idle === "function") return { kind: "idle", id: idle(callback, { timeout: 500 }) };
	return { kind: "timer", id: setTimeout(callback, 16) };
}

function cancelIdle(handle: IdleHandle): void {
	const cancel = (globalThis as { cancelIdleCallback?: (id: number) => void }).cancelIdleCallback;
	if (handle.kind === "idle") {
		if (typeof cancel === "function") cancel(handle.id);
		return;
	}
	clearTimeout(handle.id);
}

/**
 * @param lines 文件的每一行 —— **必须 memo 过**（引用稳定）。它决定 effect 何时重跑；
 *              每次渲染现造数组（比如内联 `text.split("\n")`）会「高亮 → setState → 重渲染 →
 *              新数组 → 再高亮」无限循环。
 * @param language highlight.js 的语言名（空串 = 不做高亮）
 * @param highlight 单行 → HTML 的函数（由调用方持有 hljs 实例）
 */
export function useProgressiveHighlight(
	lines: string[],
	language: string,
	highlight: (line: string, language: string) => string,
): { html: (string | undefined)[]; done: boolean; total: number } {
	const [state, setState] = useState<{ html: (string | undefined)[]; done: boolean; total: number }>({
		html: [],
		done: true,
		total: 0,
	});

	useEffect(() => {
		const total = lines.length;
		if (total === 0 || language === "") {
			setState({ html: [], done: true, total });
			return;
		}

		// 第一屏同步算（300 行约几毫秒，开文件不卡）
		const html: (string | undefined)[] = Array.from({ length: total }, () => undefined);
		const eager = Math.min(EAGER_LINES, total);
		for (let i = 0; i < eager; i += 1) html[i] = highlight(lines[i] ?? "", language);
		if (eager >= total) {
			setState({ html, done: true, total });
			return;
		}

		// 其余分批补：每批结束后再排下一次，中途文件变了就取消
		let cursor = eager;
		let handle: IdleHandle | null = null;
		let cancelled = false;
		setState({ html: [...html], done: false, total });

		const step = () => {
			if (cancelled) return;
			const end = Math.min(cursor + BATCH, total);
			for (let i = cursor; i < end; i += 1) html[i] = highlight(lines[i] ?? "", language);
			cursor = end;
			const finished = cursor >= total;
			setState({ html: [...html], done: finished, total });
			if (!finished) handle = scheduleIdle(step);
		};

		handle = scheduleIdle(step);
		return () => {
			cancelled = true;
			if (handle) cancelIdle(handle);
		};
	}, [lines, language, highlight]);

	return state;
}
