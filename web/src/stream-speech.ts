/**
 * 流式朗读的切句器：把不断增长的正文切成「可以马上念」的句子。
 *
 * 为什么不在最后整条念：用户要的是「边出字边听到」，等到回合结束再合成，
 * 长回复要干等十几秒。这里只做纯文本切分（可回归），播放顺序由调用方排队。
 *
 * 三条硬规则：
 *   - 代码块整段不念（念出来是灾难），**跨快照的未闭合代码块也要认**：先进入 fence 状态、
 *     等闭合的反引号到了再继续；
 *   - 只在句末（。！？；!?; 或换行）切，标点一起念完再切，避免把半句话切开；
 *   - 一句话太长（模型不爱用句号）就退到逗号处切，最多 `MAX_UNIT` 字，别让人等太久。
 */
import { stripMarkdownForSpeech } from "./tts.ts";

/** 单段最长字数：再长就先按逗号断开，保证第一句能尽快出声 */
const MAX_UNIT = 90;
/** 太短的片段（如「好。」）攒着和下一句一起念，避免一顿一顿 */
const MIN_UNIT = 4;
/** 句末：中英文标点或换行 */
const SENTENCE_END = /[。！？；!?;…]|\n/;

/** 一段太长（模型不写句号）：退到逗号处切开，剩下不够长的留给下一拍 */
function packLong(text: string): { pieces: string[]; rest: string } {
	const pieces: string[] = [];
	let rest = text;
	while (rest.length > MAX_UNIT) {
		const window = rest.slice(0, MAX_UNIT);
		const comma = Math.max(window.lastIndexOf("，"), window.lastIndexOf(","), window.lastIndexOf("、"));
		if (comma < MIN_UNIT) break;
		pieces.push(rest.slice(0, comma + 1));
		rest = rest.slice(comma + 1);
	}
	return { pieces, rest };
}

/** 切一段「安全文本」（不含代码块）：句末切分 + 长句退到逗号 */
function cutUnits(text: string): { units: string[]; rest: string } {
	const units: string[] = [];
	let rest = text;
	for (;;) {
		const end = rest.search(SENTENCE_END);
		if (end === -1) break;
		const candidate = rest.slice(0, end + 1);
		if (candidate.trim().length >= MIN_UNIT) {
			const packed = packLong(candidate);
			if (packed.pieces.length === 0) {
				units.push(candidate);
				rest = rest.slice(end + 1);
				continue;
			}
			units.push(...packed.pieces);
			rest = packed.rest + rest.slice(end + 1);
			continue;
		}
		// 「好。」这类过短：和后面一句一起念；后面还没出完整句子就先攒着
		const next = rest.slice(end + 1).search(SENTENCE_END);
		if (next === -1) break;
		const combined = rest.slice(0, end + 1 + next + 1);
		const packed = packLong(combined);
		if (packed.pieces.length === 0) {
			units.push(combined);
			rest = rest.slice(combined.length);
			continue;
		}
		units.push(...packed.pieces);
		rest = packed.rest;
	}
	const packed = packLong(rest);
	units.push(...packed.pieces);
	return { units, rest: packed.rest };
}

export type StreamReader = {
	/** 喂入「到目前为止的全文」，返回这一拍新切出来、可以念的句子 */
	push(fullText: string): string[];
	/** 回合结束：把剩下的半句也吐出来（代码块里没闭合的部分照旧丢掉） */
	flush(): string[];
	reset(): void;
	/** 这一轮已经吐出过几句（判断要不要退回整条重念） */
	readonly spoken: number;
};

export function createStreamReader(): StreamReader {
	let offset = 0;
	let pending = "";
	let inFence = false;
	let spoken = 0;

	const toSpeech = (raw: string): string => {
		const body = stripMarkdownForSpeech(raw, Infinity).trim();
		// 只剩标点 / 分隔符：没有可念的内容，丢掉（否则会念一串停顿）
		if (body === "" || !/[\p{L}\p{N}]/u.test(body)) return "";
		return body;
	};

	const emit = (raw: string): string[] => {
		const { units, rest } = cutUnits(raw);
		pending = rest;
		const out: string[] = [];
		for (const unit of units) {
			const body = toSpeech(unit);
			if (body !== "") out.push(body);
		}
		spoken += out.length;
		return out;
	};

	return {
		get spoken() {
			return spoken;
		},
		push(fullText: string): string[] {
			// 校正帧可能比上一帧短：已经念过的收不回来，游标不退，绝不重念。
			if (fullText.length <= offset) return [];
			const chunk = fullText.slice(offset);
			offset = fullText.length;
			let buffer = pending + chunk;
			pending = "";
			const out: string[] = [];
			for (;;) {
				if (inFence) {
					const close = buffer.indexOf("```");
					// 代码块还没闭合：整段都可能是代码，先不念（内容直接丢，闭合后再继续）
					if (close === -1) return out;
					inFence = false;
					buffer = buffer.slice(close + 3);
					continue;
				}
				const open = buffer.indexOf("```");
				if (open === -1) {
					out.push(...emit(buffer));
					return out;
				}
				out.push(...emit(buffer.slice(0, open)));
				inFence = true;
				buffer = buffer.slice(open + 3);
			}
		},
		flush(): string[] {
			const raw = inFence ? "" : pending;
			pending = "";
			inFence = false;
			const body = toSpeech(raw);
			if (body === "") return [];
			spoken += 1;
			return [body];
		},
		reset(): void {
			offset = 0;
			pending = "";
			inFence = false;
			spoken = 0;
		},
	};
}
