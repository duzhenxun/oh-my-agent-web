/**
 * 「过程」（思考段 + 工具卡 + 中间的说明）这一块到底怎么展。
 *
 * 为什么抽成纯函数：这块的判断改过几回方向（先「跑着不铺、只留一行实时动作」，
 * 再到「跑着铺开、跑完才收」，再到现在「跑着只留最新一组」——用户 2026-11-02），而现在它同时要被
 * 「跑着呢 / 跑完了 / 有没有最终结果 / 两个默认展开开关 / 用户手点过没有」五个输入决定 ——
 * 埋在组件里就只能靠肉眼验，错了也很难发现。
 *
 * 三态说明（用户 2026-11-02：**跑着只显示最新一组的文案（命令由末尾状态行报），像替换那样；
 * 跑完自动收起来只留最后结果；
 * 点展开时再显示全部**）：
 *   1. **跑着 → 只画最新一组**：从最后那段思考开始（连带它的说明与工具）到底部，换组就地替换，
 *      不往上堆 —— 长任务里十几个组堆下来，正在干的那一组反而被挤到屏幕外；
 *   2. **跑完 → 收起**：**最后一段结论之前的全部**（思考、工具卡、以及中间那几段说明文字）收成
 *      一行「N 段思考 · N 次工具 · 耗时 X」，外面只留最后的输出；点那一行展开完整时间线；
 *   3. **收起会把人看空 → 不收起**：这一轮以工具调用收尾（最后动手之后没有结论）时，
 *      收起来屏幕上就只剩一行按钮。
 *
 * 关于「中间的说明」：2026-10-30 曾经刻意留在外面（“A 不行改用 B”是可信度来源），
 * 2026-11-02 用户改主意了 —— 跑的时候看得见就行，跑完只要最后的结果。
 */

export type ProcessFold = {
	/** 这一轮还在跑（没写 endedAt） */
	running: boolean;
	/** 最后一次动手之后还有正文 / 错误块 = 这一轮有最终结果 */
	hasAnswer: boolean;
	/** 设置里「跑完自动折叠思考与工具调用」 */
	autoCollapse: boolean;
	/** 「默认展开思考块」「默认展开工具卡」任一为开 */
	defaultOpen: boolean;
	/** 用户对**这条消息**的手动选择；null = 没点过 */
	manual: boolean | null;
};

/**
 * 过程区的三种展法：
 *   - `tail`：**只画最新一组**（跑着的时候，换组就地替换，不往上堆）；
 *   - `all`：完整时间线（手动点开 / 没结论 / 关掉自动折叠）；
 *   - `collapsed`：跑完收成一行。
 */
export type ProcessView = "tail" | "all" | "collapsed";

/** 这一轮还在跑吗：`live` 是这条消息还在流式，`endedAt` 一旦写上就表示回合结束 */
export function isTurnRunning(input: { live: boolean; endedAt: number | undefined }): boolean {
	return input.live && input.endedAt === undefined;
}

type FoldSegment = {
	kind: "process" | "text" | "error";
	text?: string;
	/** 过程段里按「一段思考 + 它的工具」分好的组（只看第一组是不是思考开头） */
	groups?: readonly { thinking: unknown | null }[];
};

export type FoldLayout = {
	/** 第一段过程（思考/工具）的下标：折叠按钮就长在这里；-1 = 这一轮压根没动手 */
	firstProcessAt: number;
	/** 最后一段「结论」（非空正文或错误块）的下标；-1 = 只有过程、没有结论 */
	lastAnswerAt: number;
	/** 折叠之后外面还留得下结论（= 结论在最后一次动手之后）；false 就不该收，收了只剩一行按钮 */
	hasAnswer: boolean;
	/** 收起时这个下标要不要跟过程一起进折叠（最后一个结论之前的全部） */
	insideFold: (index: number) => boolean;
};

/**
 * 算出「折叠到哪里」：**最后一个结论之前的一切都进折叠**（思考、工具、中间那几段说明）。
 *
 * 为什么不是「只收思考和工具」：那一版跑完屏幕上会剩下「我先看一下…」「本地和全局的版本不一致…」
 * 这类过程性说明，最后的结论反而被麦在中间（用户 2026-11-02 的截图就是这个问题）。
 * 空白正文不算结论（流式末尾常见一个只有换行的 text 块）。
 */
export function foldLayout(segments: readonly FoldSegment[]): FoldLayout {
	let firstProcessAt = -1;
	let lastProcessAt = -1;
	let lastAnswerAt = -1;
	segments.forEach((segment, index) => {
		if (segment.kind === "process") {
			if (firstProcessAt < 0) firstProcessAt = index;
			lastProcessAt = index;
			return;
		}
		if (segment.kind === "error" || (segment.text ?? "").trim() !== "") lastAnswerAt = index;
	});
	const hasProcess = firstProcessAt >= 0;
	return {
		firstProcessAt,
		lastAnswerAt,
		hasAnswer: hasProcess && lastAnswerAt > lastProcessAt,
		insideFold: (index) => hasProcess && index < lastAnswerAt,
	};
}

/**
 * 过程区怎么展（手动优先 → 跑着只画最新一组 → 没结论就摊开 → 关掉自动折叠才看两个默认开关）。
 *
 * 「跑着只画最新一组」是用户 2026-11-02 的要求：长任务里十几个组一路往上堆，
 * 正在干的那一组反而被挤在屏幕外；只画最新的那一组、换组时就地替换，看着才像个秒表。
 * 历史组没丢：点折叠行就展开完整时间线。
 */
export function processView(input: ProcessFold): ProcessView {
	if (input.manual !== null) {
		if (input.manual) return "all";
		return input.running ? "tail" : "collapsed";
	}
	if (input.running) return "tail";
	if (!input.hasAnswer) return "all";
	return !input.autoCollapse && input.defaultOpen ? "all" : "collapsed";
}

/**
 * 最新一组的起点（`tail` 模式从这里画到最后）。
 *
 * 组的边界在「新开一段思考」：思考 + 它后面的说明 + 它引发的工具算一组。
 * 注意段和组不是一一对应：中间没有说话时，一个过程段里会挤好几组（想 → 工具 → 想 → 工具），
 * 所以返回的是 { 段下标, 组下标 }，不光是一个下标。
 * 一次思考都没有（直接调工具）时退到最后一个过程段的开头；再没有就 null（纯文字回复）。
 */
export function lastGroupStart(segments: readonly FoldSegment[]): { segmentIndex: number; groupIndex: number } | null {
	let anchor: { segmentIndex: number; groupIndex: number } | null = null;
	let lastProcess: { segmentIndex: number; groupIndex: number } | null = null;
	segments.forEach((segment, segmentIndex) => {
		if (segment.kind !== "process") return;
		lastProcess = { segmentIndex, groupIndex: 0 };
		(segment.groups ?? []).forEach((group, groupIndex) => {
			if ((group.thinking ?? null) !== null) anchor = { segmentIndex, groupIndex };
		});
	});
	return anchor ?? lastProcess;
}

/**
 * 回合刚结束的那一帧，要不要把手动状态作废。
 *
 * 「跑完自动收起」是这一版的核心，所以跑着的时候点开看过（或手动收起来过）都不该阻止它收。
 * 但**已经跑完**的消息再点开就得一直开着 —— 所以只有「上一帧在跑、这一帧不在跑」这一下才清。
 */
export function shouldForgetManual(previousRunning: boolean, running: boolean): boolean {
	return previousRunning && !running;
}
