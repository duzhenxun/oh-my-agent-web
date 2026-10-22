/**
 * 流式回合的「实时数字」：已生成多少 token、最近几秒跑多快（token/s）。
 *
 * 为什么放前端算：
 *   - 正文走 `message_delta` 增量（ADR-0004 §3），快照不逐字推 —— 服务端**没有**
 *     逐字的推送点，而这两种数字要的就是「一直变」，所以采样点只能在收增量的这一侧；
 *   - token 数在流式期间拿不到真值（引擎的 usage 只在一条消息**结束**时完整），
 *     窗口内只能按字符估算；结束后的真实用量照旧由消息尾注显示，这个估算不落盘。
 *
 * 采样用**定时器**而不是「每个 delta 都记账」：一段回复可能几千个 delta，
 * 每个都扫一遍全文是 O(n²)；每 250ms 量一次既够闪，也只采样几十次。
 */
import { useEffect, useRef, useState } from "react";

/** 采样间隔：≈4 次/秒（再快也只是数字抖，人眼看不出差别） */
export const LIVE_TICK_MS = 250;
/** 速率的滑动窗口：取最近 4 秒 —— 太短会跳，太长会被「停下来想事」拖住不降 */
export const LIVE_RATE_WINDOW_MS = 4000;

/** 一条采样：这一刻累计生成了多少 token */
export type StreamSample = { ts: number; tokens: number };

/**
 * 纯函数：字符数 → token 估算。
 *
 * 中日韩/全角字符大约 1 字 1 token，拉丁字母与符号大约 4 字符 1 token；
 * 混排时按两类分别累计再加起来，比「字数 ÷ 4」靠谱得多（中文会被低估四倍）。
 */
export function estimateTokens(text: string): number {
	let wide = 0;
	let narrow = 0;
	for (let index = 0; index < text.length; index += 1) {
		// 0x2E80 之后是 CJK 部首 / 假名 / 汉字 / 全角符号（含 emoji 代理对的一半，量级上算宽字符）
		if (text.charCodeAt(index) >= 0x2e80) wide += 1;
		else narrow += 1;
	}
	return wide + Math.round(narrow / 4);
}

/**
 * 纯函数：滑动窗口内的速率（token/秒）。
 *
 * 窗口里锚点越老、末点越新 → 生成停下时（tokens 不再涨、末点继续前移）
 * 速率会自己衰减到 0，不需要额外判定「是不是卡住了」。
 */
export function liveRate(samples: readonly StreamSample[], now = Date.now(), windowMs = LIVE_RATE_WINDOW_MS): number {
	const from = now - windowMs;
	const inWindow = samples.filter((sample) => sample.ts >= from);
	if (inWindow.length < 2) return 0;
	const first = inWindow[0];
	const last = inWindow[inWindow.length - 1];
	if (!first || !last) return 0;
	// 至少攒够一个采样间隔再报数：否则第一条样本会把速率放大成几千
	const span = (last.ts - first.ts) / 1000;
	if (span * 1000 < LIVE_TICK_MS) return 0;
	const delta = last.tokens - first.tokens;
	return delta > 0 ? delta / span : 0;
}

/** 纯函数：速率文案（`223.4 t/s`）；0 表示这几秒没在吐字，显示「—」而不是假的 0.0 */
export function formatRate(rate: number): string {
	if (!Number.isFinite(rate) || rate <= 0) return "—";
	const value = rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10;
	return `${value} t/s`;
}

/**
 * 挂着就等于「这条消息正在流式输出」：每 250ms 量一次，返回累计 token 与窗口速率。
 *
 * `text` 是这条消息**已生成的全部内容**（正文 + 思考）：思考也是模型吐出来的 token，
 * 不算进去的话，模型闷头想事的十几秒里数字会一动不动 —— 看着像卡了。
 */
export function useLiveStats(text: string): { tokens: number; rate: number } {
	const samples = useRef<StreamSample[]>([]);
	const latest = useRef(text);
	const [, bump] = useState(0);
	// 渲染时只把最新内容记进 ref，真正的估算放到定时器里做（避免每个 delta 都全量扫一遍）
	latest.current = text;

	useEffect(() => {
		const tick = () => {
			const now = Date.now();
			const list = samples.current;
			list.push({ ts: now, tokens: estimateTokens(latest.current) });
			// 只留一个窗口（多留一条边界样本，窗口刚好铺满时还能算出速率）
			const cutoff = now - LIVE_RATE_WINDOW_MS - LIVE_TICK_MS;
			while (list.length > 2 && (list[0]?.ts ?? 0) < cutoff) list.shift();
			bump((value) => value + 1);
		};
		tick(); // 先量一次：挂上的第一帧就有数，不用等 250ms
		const timer = setInterval(tick, LIVE_TICK_MS);
		return () => {
			clearInterval(timer);
			samples.current = [];
		};
	}, []);

	return { tokens: samples.current[samples.current.length - 1]?.tokens ?? 0, rate: liveRate(samples.current) };
}
