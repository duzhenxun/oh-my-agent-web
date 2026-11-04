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
 *   3. **以工具收尾（这一轮没有最终结论）也照样收**（用户 2026-11-03）：以前这里留了个例外
 *      （“收起来只剩一行按钮”），结果被插队 / 打断打断的那些回合在历史里**永远是摊开的** ——
 *      用户明明勾了「跑完自动折叠」，重开会话还是满屏思考与工具卡。收起后那一行本身就报了
 *      「N 段思考 · N 次工具 · 耗时」，点开就是完整时间线；错误块仍然留在外面（报错不能被藏）。
 *
 * 关于「中间的说明」：2026-10-30 曾经刻意留在外面（“A 不行改用 B”是可信度来源），
 * 2026-11-02 用户改主意了 —— 跑的时候看得见就行，跑完只要最后的结果。
 */

export type ProcessFold = {
	/** 这一轮还在跑（没写 endedAt） */
	running: boolean;
	/** 设置里「跑完自动折叠思考与工具调用」 */
	autoCollapse: boolean;
	/** 设置里「跑时自动折叠过程」：跑着的时候就收成那行秒表 */
	autoFoldRunning: boolean;
	/** 「默认展开思考块」「默认展开工具卡」任一为开 */
	defaultOpen: boolean;
	/** 用户对**这条消息**的手动选择；null = 没点过 */
	manual: boolean | null;
};

/**
 * 过程区的两种展法（**只有两种**：要么铺开，要么收成一行）：
 *   - `all`：完整时间线（按发生顺序铺着长）；
 *   - `collapsed`：收成顶上那一行「N 段思考 · N 次工具 · 耗时」。
 *
 * 以前还有第三种 `tail`（跑着时只画最新一组、换组就地替换）。用户 2026-11-02 看到设置里
 * 「跑时自动折叠」没勾、过程却还是收着的，直接说「应展开才对吧」—— 那条 `tail` 就是
 * 「没勾也还是折着」的来源，删掉了：勾上=收，不勾=全铺开，没有第三种含糊状态。
 */
export type ProcessView = "all" | "collapsed";

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
	/** 最后一段过程（思考/工具）的下标；-1 = 没动过手。判断「哪句正文是结论」要用它 */
	lastProcessAt: number;
	/** 折叠之后外面还留得下结论（= 结论在最后一次动手之后）；false 就不该收，收了只剩一行按钮 */
	hasAnswer: boolean;
	/**
	 * 收起时这个下标要不要跟过程一起进折叠（最后一个结论之前的全部）。
	 *
	 * 注意「没有结论的回合（以工具 / 思考收尾）怎么收」不在这里 —— 那得看这一轮是否还在跑，
	 * 用 `hidesNarration` 判：跑着的时候说明还是要看得见，跑完了才连说明一起收。
	 */
	insideFold: (index: number) => boolean;
};

/**
 * 算出「折叠到哪里」：**最后一个结论之前的一切都进折叠**（思考、工具、中间那几段说明）。
 *
 * 为什么不是「只收思考和工具」：那一版跑完屏幕上会剩下「我先看一下…」「本地和全局的版本不一致…」
 * 这类过程性说明，最后的结论反而被麦在中间（用户 2026-11-02 的截图就是这个问题）。
 * 空白正文不算结论（流式末尾常见一个只有换行的 text 块）。
 *
 * 没有结论的回合（插队 / 打断把这一轮截在工具调用上）**跑完后也整条进折叠**，这条规则在
 * `hidesNarration`：那一版把说明留在外面，于是“收起来”只收走了思考和工具卡，中间那几段话
 * 还在屏幕上排着，看着还是没收起（用户 2026-11-03）。
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
		lastProcessAt,
		hasAnswer: hasProcess && lastAnswerAt > lastProcessAt,
		insideFold: (index) => hasProcess && index < lastAnswerAt,
	};
}

/**
 * 这一段正文该不该用「叙述」字号（比正文大一档，见 `.md-narration`）？
 *
 * 用户 2026-11-02：「不统一呀，有的大，有的小呢」—— 以前是「只要它是最后一段正文，就当结论」，
 * 而过程里那些说明**轮到自己时都是“最后一段”**：于是同一片过程里，最新那句是 14px 正文，
 * 前面几句是 16.8px 叙述，一眼看上去参差不齐（而且模型一说下一个动作，刚变小那句又变回去）。
 *
 * 现在按语义判：
 *   - **跑着**：还没有「最终答案」这回事，过程里的每句说明都是叙述 → 全部一个字号（不来回跳）；
 *   - **跑完**：只有整轮最后那段结论（且它之后没有又去动手）算正文，其余都是过程叙述。
 * 这样「结论」永远是正文号，「过程里说的话」永远是叙述号，两档不会在同一层里混用。
 */
export function isNarrationText(input: {
	index: number;
	lastAnswerAt: number;
	lastProcessAt: number;
	running: boolean;
}): boolean {
	if (input.running) return true;
	return !(input.index === input.lastAnswerAt && input.lastAnswerAt > input.lastProcessAt);
}

/**
 * 过程区怎么展（手动优先 → 跑着：收 / 全铺开 → 跑完：收 / 交回两个默认开关）。
 *
 * 两种时段各有一个开关，都只有「收 / 不收」两种结果：
 *   - **跑着**：看设置里「跑时自动折叠」
 *     - 勾上 → `collapsed`：只剩那一行秒表 + 底下的实时动作行（正在跑哪条命令）；
 *     - 不勾（默认）→ `all`：完整时间线按发生顺序铺着长（用户 2026-11-02：「没勾上这个，应展开才对吧」）。
 *   - **跑完**：看「跑完自动折叠」（勾上就收 —— **没有「以工具收尾就不收」的例外**，
 *     2026-11-03 去掉了；关掉它才交回两个「默认展开」开关）。
 * 手动点过那条消息时手动优先：点开 = 全铺开，收起 = 一行。
 */
export function processView(input: ProcessFold): ProcessView {
	if (input.manual !== null) return input.manual ? "all" : "collapsed";
	if (input.running) return input.autoFoldRunning ? "collapsed" : "all";
	if (input.autoCollapse) return "collapsed";
	return input.defaultOpen ? "all" : "collapsed";
}

/**
 * 收起时这一段**说明文字**（text）要不要藏？
 *   - `view` 不是 `collapsed`（铺开）：一律画；
 *   - 落在折叠范围内（最后一个结论之前的说明）：藏；
 *   - 这一轮**已经跑完却没有结论**（插队 / 打断截在工具调用上）：说明也一起藏 ——
 *     否则“收起”只收走了思考和工具卡，中间几段叙述还在屏幕上排着，看着还是没收（用户 2026-11-03）。
 *     **跑着的时候不藏**：那时候叙述就是「它现在在干什么」，收掉就没得看了。
 * 错误块不走这个判断：报错永远画在外面（那一行摘要报的是思考/工具，藏进去就没人知道了）。
 */
export function hidesNarration(input: {
	view: ProcessView;
	running: boolean;
	/** 这一条消息有没有过程块（思考 / 工具）。没有 = 用户消息或纯文字回复，正文一句都不能藏 */
	hasProcess: boolean;
	hasAnswer: boolean;
	/** 这一段是否落在 `foldLayout().insideFold` 范围内 */
	insideFold: boolean;
}): boolean {
	if (input.view !== "collapsed") return false;
	// 没有过程 = 没有折叠这回事。2026-11-03 回归：用户消息被误藏，就是因为下面「没结论」分支没看这一点
	if (!input.hasProcess) return false;
	if (input.insideFold) return true;
	return !input.running && !input.hasAnswer;
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
