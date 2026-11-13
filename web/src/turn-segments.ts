/**
 * 把一轮回复的 blocks 切成**按发生顺序**排的渲染单元。
 *
 * 为什么单独成文件：这套切块规则同时被「渲染顺序」「折叠范围」「错误去重」三处依赖，
 * 埋在组件里就只能靠肉眼验（尤其是 2026-11-13 那条「四条一模一样报错要合成一条」），
 * 抽成纯函数后 `tests/unit/error-dedupe.test.ts` 能直接锁住它。
 *
 * 切块规则（用户 2026-10-30：照 codex 那样显示）：
 *   - 连续的思考 / 工具调用成一段「过程」，碰到 thinking 就开新块（后续工具都归它）；
 *   - 第一个 thinking 之前就有工具（少见，但不是不可能）→ 单独成一块，`thinking` 为 null；
 *   - 正文与错误块把过程断开，并留在各自发生的位置 —— 流式期间看到的就是一条时间线。
 */
import type { UiMessage } from "./types.ts";

/** 过程里的一项（思考或工具调用） */
type ProcessItem = Extract<UiMessage["blocks"][number], { kind: "thinking" } | { kind: "tool" }>;
type ToolItem = Extract<ProcessItem, { kind: "tool" }>;
type ErrorItem = Extract<UiMessage["blocks"][number], { kind: "error" }>;

/**
 * 过程里的一小块：**一段思考 + 它后面跟着的那些工具调用**。
 *
 * 为什么要分块：过程一长（五六个思考、十几次工具），扁平地排下来分不清
 * 「哪几次工具是这次想完之后干的」。分块后每段思考前面有编号，读起来是
 * 「想 ① → 试一下 → 再想 ② → 再试」的节奏。
 */
export type ProcessGroupView = {
	key: string;
	thinking: { text: string } | null;
	tools: ToolItem[];
};

/**
 * 一轮回复的一个渲染单元：连续的过程、一段正文、或一个错误块。
 *
 * 「连续」是关键：中间只要插了一段正文，过程就在那里断开 —— 那正是模型
 * 「说一句 → 调工具 → 再说一句」的时间线，不能把它们再缝到一起去。
 */
export type TurnSegment =
	| { kind: "process"; groups: ProcessGroupView[] }
	| { kind: "text"; text: string; index: number }
	| { kind: "error"; block: ErrorItem; index: number };

/** 同一条错误的身份：同 code + 同 message 就是「同一件事又发生了」 */
function errorKey(block: ErrorItem): string {
	return `${block.code}\u0000${block.message}`;
}

export function buildTurnSegments(blocks: UiMessage["blocks"]): {
	segments: TurnSegment[];
	thinkingCount: number;
	toolCount: number;
} {
	const segments: TurnSegment[] = [];
	let current: Extract<TurnSegment, { kind: "process" }> | null = null;
	let thinkingCount = 0;
	let toolCount = 0;
	for (let index = 0; index < blocks.length; index += 1) {
		const block = blocks[index];
		if (!block) continue;
		if (block.kind === "thinking" || block.kind === "tool") {
			if (!current) {
				current = { kind: "process", groups: [] };
				segments.push(current);
			}
			if (block.kind === "thinking") {
				thinkingCount += 1;
				current.groups.push({ key: `think-${index}`, thinking: { text: block.text }, tools: [] });
				continue;
			}
			toolCount += 1;
			const lastGroup = current.groups[current.groups.length - 1];
			if (lastGroup) lastGroup.tools.push(block);
			else current.groups.push({ key: `lead-${index}`, thinking: null, tools: [block] });
			continue;
		}
		// 正文 / 错误块：过程在这里断开
		current = null;
		if (block.kind === "text") {
			segments.push({ kind: "text", text: block.text, index });
			continue;
		}
		segments.push({ kind: "error", block, index });
	}
	/**
	 * 同样的错误只画一条（用户 2026-11-13：「这种出来一条提示就行，不用这么多」）。
	 *
	 * 服务端已经不再为同一条错误追加新块（次数累进 `count`，见 `server/snapshot/messages.ts`
	 * 的 `appendError`），但**历史里旧的会话**仍然可能带着一串重复块，而且不一定是相邻的
	 * （中间还夹着思考与工具卡），所以这里再合一次、次数相加。
	 *
	 * 合并后的那条落在它**最后一次**出现的位置：那才是「到这个时刻已经试了 N 次」的真实时间点。
	 */
	const errorLastAt = new Map<string, number>();
	const errorCounts = new Map<string, number>();
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment || segment.kind !== "error") continue;
		const key = errorKey(segment.block);
		errorLastAt.set(key, index);
		errorCounts.set(key, (errorCounts.get(key) ?? 0) + (segment.block.count ?? 1));
	}
	if (errorLastAt.size === 0) return { segments, thinkingCount, toolCount };
	const merged: TurnSegment[] = [];
	for (let index = 0; index < segments.length; index += 1) {
		const segment = segments[index];
		if (!segment) continue;
		if (segment.kind !== "error") {
			merged.push(segment);
			continue;
		}
		const key = errorKey(segment.block);
		if (errorLastAt.get(key) !== index) continue;
		merged.push({ kind: "error", block: { ...segment.block, count: errorCounts.get(key) ?? 1 }, index });
	}
	return { segments: merged, thinkingCount, toolCount };
}
