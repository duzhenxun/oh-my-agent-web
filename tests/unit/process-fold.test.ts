/**
 * 「过程」（思考段 + 工具卡）展不展开（web/src/process-fold.ts）。
 *
 * 守住用户 2026-11-02 要的那个行为：**跑着的时候铺开、跑完自动收起，屏幕上只留最后结果**。
 * 顺手把几条容易被改坏的边界固定下来：
 *   - 这一轮以工具调用收尾（插队 / 被打断，没有最终正文）→ **也照样收起**（用户 2026-11-03：
 *     以前留了个“不收”的例外，结果历史里这些回合永远是摊开的）；
 *   - 关掉「跑完自动折叠」→ 交回那两个「默认展开思考块 / 工具卡」开关；
 *   - 手动点开过的**已结束**消息不许被重渲染折叠回去（但跑完那一下要作废手动状态）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	foldLayout,
	hidesNarration,
	isNarrationText,
	isTurnRunning,
	processView,
	shouldForgetManual,
} from "../../web/src/process-fold.ts";

const base = {
	running: false,
	autoCollapse: true,
	autoFoldRunning: false,
	defaultOpen: false,
	manual: null,
};

describe("这一轮还在跑吗", () => {
	it("还在流式且没写 endedAt = 在跑", () => {
		assert.equal(isTurnRunning({ live: true, endedAt: undefined }), true);
	});

	it("写了 endedAt = 跑完了（哪怕 live 还没收尾）", () => {
		assert.equal(isTurnRunning({ live: true, endedAt: 1_700_000_000_000 }), false);
	});

	it("历史消息（live=false）从来不算在跑", () => {
		assert.equal(isTurnRunning({ live: false, endedAt: undefined }), false);
	});
});

describe("过程区怎么展", () => {
	it("跑着 + 没勾「跑时自动折叠」（默认）→ 完整铺开", () => {
		assert.equal(processView({ ...base, running: true }), "all");
	});

	it("跑着的时候点收起就是一行，再点开回到完整时间线", () => {
		assert.equal(processView({ ...base, running: true, manual: true }), "all");
		assert.equal(processView({ ...base, running: true, manual: false }), "collapsed");
	});

	it("「跑时自动折叠」关着（默认）→ 跑着完整铺开（用户 2026-11-02：「没勾上这个，应展开才对吧」）", () => {
		assert.equal(processView({ ...base, running: true, autoFoldRunning: false }), "all");
	});

	it("「跑时自动折叠」勾上 → 跑着就收成那行秒表（只剩实时动作行）", () => {
		assert.equal(processView({ ...base, running: true, autoFoldRunning: true }), "collapsed");
	});

	it("跑时折叠也受手动优先：点开看全部，再点回收起", () => {
		const folded = { ...base, running: true, autoFoldRunning: true };
		assert.equal(processView({ ...folded, manual: true }), "all");
		assert.equal(processView({ ...folded, manual: false }), "collapsed");
	});

	it("「跑时折叠」不影响跑完那一刻（两个时段各管各的）", () => {
		assert.equal(processView({ ...base, running: false, autoFoldRunning: true }), "collapsed");
		assert.equal(
			processView({ ...base, running: false, autoFoldRunning: true, autoCollapse: false, defaultOpen: false }),
			"collapsed",
		);
	});

	it("跑完自动收起（默认设置，有最终答案）", () => {
		assert.equal(processView({ ...base, running: false }), "collapsed");
	});

	it("以工具调用收尾（插队 / 被打断的回合）也照样收起（用户 2026-11-03）", () => {
		// 以前这里摊开（“收起来只剩一行按钮”），结果这些回合在历史里永远是打开的
		assert.equal(processView({ ...base, autoCollapse: true }), "collapsed");
		assert.equal(processView({ ...base, autoCollapse: true, defaultOpen: true }), "collapsed");
	});

	it("关掉「跑完自动折叠」→ 交回两个默认展开开关", () => {
		const off = { ...base, autoCollapse: false };
		assert.equal(processView({ ...off, defaultOpen: true }), "all");
		assert.equal(processView({ ...off, defaultOpen: false }), "collapsed");
	});

	it("手动优先：已结束的消息点开就得一直开着", () => {
		assert.equal(processView({ ...base, manual: true }), "all");
		assert.equal(processView({ ...base, manual: false }), "collapsed");
	});
});

describe("跑完那一下作废手动状态", () => {	it("上一帧在跑、这一帧不跑 → 作废（跑完自动收起）", () => {
		assert.equal(shouldForgetManual(true, false), true);
	});

	it("一直没在跑 / 一直在跑 → 不动（跑完之后用户点开不能被抹掉）", () => {
		assert.equal(shouldForgetManual(false, false), false);
		assert.equal(shouldForgetManual(true, true), false);
	});
});

describe("折叠收到哪里", () => {
	/** 用户 2026-11-02 截图里的形状：说明 → 动手 → 说明 → 动手 → 最终结论 */
	const withNarration = [
		{ kind: "text", text: "我先看当前项目的依赖版本。" },
		{ kind: "process" },
		{ kind: "text", text: "版本并不一致，我再确认运行中的实例。" },
		{ kind: "process" },
		{ kind: "text", text: "现在的版本" },
	] as const;

	it("中间的说明也进折叠：只留最后一段结论在外面", () => {
		const layout = foldLayout(withNarration);
		assert.equal(layout.firstProcessAt, 1);
		assert.equal(layout.lastAnswerAt, 4);
		assert.equal(layout.hasAnswer, true);
		assert.deepEqual([0, 1, 2, 3].map(layout.insideFold), [true, true, true, true]);
		assert.equal(layout.insideFold(4), false);
	});

	it("以工具收尾（最后动手之后没结论）→ 按钮还在；说明是否藏要看跑没跑完（见 hidesNarration）", () => {
		const layout = foldLayout([
			{ kind: "process" },
			{ kind: "text", text: "查到了，接下来跑一下" },
			{ kind: "process" },
		]);
		assert.equal(layout.hasAnswer, false);
		// insideFold 只管「结论之前」：这里最后一句非空正文（index 1）仍算 lastAnswerAt，所以 0 在范围内；
		// 1 本身不藏于 insideFold，是 hidesNarration 在「跑完且无结论」时把它收掉
		assert.deepEqual([0, 1, 2].map(layout.insideFold), [true, false, false]);
	});

	it("空白正文不算结论（流式末尾常见的只有换行的 text 块）", () => {
		const layout = foldLayout([{ kind: "process" }, { kind: "text", text: "  \n  " }]);
		assert.equal(layout.lastAnswerAt, -1);
		assert.equal(layout.hasAnswer, false);
	});

	it("错误块算结论：最后一屏是报错时，报错要留在外面", () => {
		const layout = foldLayout([{ kind: "text", text: "我试一下" }, { kind: "process" }, { kind: "error" }]);
		assert.equal(layout.lastAnswerAt, 2);
		assert.equal(layout.hasAnswer, true);
		assert.equal(layout.insideFold(1), true);
		assert.equal(layout.insideFold(2), false);
	});

	it("压根没动手（普通问答）→ 没有折叠，正文一句都不能藏", () => {
		const layout = foldLayout([
			{ kind: "text", text: "第一段" },
			{ kind: "text", text: "第二段" },
		]);
		assert.equal(layout.firstProcessAt, -1);
		assert.equal(layout.hasAnswer, false);
		assert.deepEqual([0, 1].map(layout.insideFold), [false, false]);
	});
});

describe("哪一段正文用「叙述」字号（同一片过程里必须统一）", () => {
	// 用户 2026-11-02 的截图：同一条消息里两句过程说明，一句 16.8px、一句 14px
	const segments = [
		{ kind: "process", groups: [{ thinking: { text: "想" } }] },
		{ kind: "text", text: "我去找所有拼 XmYs 的耗时格式化函数" },
		{ kind: "process", groups: [{ thinking: null }] },
		{ kind: "text", text: "现在把格式化函数抽到可测的公共模块" },
		{ kind: "process", groups: [{ thinking: { text: "想" } }] },
		{ kind: "text", text: "改好了。" },
	] as const;

	it("跑完：只有整轮最后那段结论算正文，前面两段都是叙述（不再大小不一）", () => {
		const layout = foldLayout(segments);
		assert.equal(layout.lastProcessAt, 4);
		assert.equal(layout.lastAnswerAt, 5);
		const narration = segments.map((_, index) =>
			isNarrationText({
				index,
				lastAnswerAt: layout.lastAnswerAt,
				lastProcessAt: layout.lastProcessAt,
				running: false,
			}),
		);
		// 过程段（0/2/4）不走这个判断；正文段 1/3 是叙述，5 是结论
		assert.deepEqual(
			[1, 3].map((index) =>
				isNarrationText({
					index,
					lastAnswerAt: layout.lastAnswerAt,
					lastProcessAt: layout.lastProcessAt,
					running: false,
				}),
			),
			[true, true],
		);
		assert.equal(
			isNarrationText({
				index: 5,
				lastAnswerAt: layout.lastAnswerAt,
				lastProcessAt: layout.lastProcessAt,
				running: false,
			}),
			false,
		);
		assert.equal(narration.length, segments.length);
	});

	it("跑着的时候：全部当叙述（还没有「最终答案」这回事，别让同一句中途跳字号）", () => {
		const layout = foldLayout(segments);
		for (const index of [1, 3, 5]) {
			assert.equal(
				isNarrationText({
					index,
					lastAnswerAt: layout.lastAnswerAt,
					lastProcessAt: layout.lastProcessAt,
					running: true,
				}),
				true,
			);
		}
	});

	it("结论之后又去动手了（这一轮以工具收尾）→ 最后那句也不是结论，仍算叙述", () => {
		const tailProcess = [
			{ kind: "process", groups: [{ thinking: { text: "想" } }] },
			{ kind: "text", text: "我先跑一下测试" },
			{ kind: "process", groups: [{ thinking: null }] },
		] as const;
		const layout = foldLayout(tailProcess);
		assert.equal(layout.hasAnswer, false);
		assert.equal(
			isNarrationText({
				index: 1,
				lastAnswerAt: layout.lastAnswerAt,
				lastProcessAt: layout.lastProcessAt,
				running: false,
			}),
			true,
		);
	});

	it("纯文字回复（没动手）→ 正文就是正文", () => {
		const layout = foldLayout([{ kind: "text", text: "只有一句话" }] as const);
		assert.equal(layout.firstProcessAt, -1);
		assert.equal(layout.lastProcessAt, -1);
		assert.equal(
			isNarrationText({
				index: 0,
				lastAnswerAt: layout.lastAnswerAt,
				lastProcessAt: layout.lastProcessAt,
				running: false,
			}),
			false,
		);
	});
});

describe("哪一段说明要藏进折叠（hidesNarration）", () => {
	const collapsed = { view: "collapsed" as const, hasProcess: true };

	it("铺开时一律不藏", () => {
		assert.equal(
			hidesNarration({ view: "all", running: false, hasProcess: true, hasAnswer: true, insideFold: true }),
			false,
		);
	});

	it("收起时：结论之前的说明藏起来，结论本身不藏", () => {
		assert.equal(hidesNarration({ ...collapsed, running: false, hasAnswer: true, insideFold: true }), true);
		assert.equal(hidesNarration({ ...collapsed, running: false, hasAnswer: true, insideFold: false }), false);
	});

	it("跑完但没结论（插队 / 打断在工具上）：说明也一起藏，不再留在屏幕上", () => {
		assert.equal(hidesNarration({ ...collapsed, running: false, hasAnswer: false, insideFold: false }), true);
	});

	it("还在跑：说明一律留着（那时候它就是「现在在干什么」）", () => {
		assert.equal(hidesNarration({ ...collapsed, running: true, hasAnswer: false, insideFold: false }), false);
		assert.equal(hidesNarration({ ...collapsed, running: true, hasAnswer: true, insideFold: true }), true);
	});

	it("没有过程的消息（用户消息 / 纯文字回复）永远不藏，哪怕折叠是收起状态", () => {
		// 回归：2026-11-03 用户消息整条消失，就是因为「跑完且无结论」分支没看有没有过程
		for (const running of [false, true]) {
			assert.equal(
				hidesNarration({ view: "collapsed", running, hasProcess: false, hasAnswer: false, insideFold: false }),
				false,
			);
		}
	});
});
