/**
 * 「过程」（思考段 + 工具卡）展不展开（web/src/process-fold.ts）。
 *
 * 守住用户 2026-11-02 要的那个行为：**跑着的时候铺开、跑完自动收起，屏幕上只留最后结果**。
 * 顺手把几条容易被改坏的边界固定下来：
 *   - 这一轮以工具调用收尾（没有最终正文）→ 跑完也不能收，否则屏幕上只剩一行按钮；
 *   - 关掉「跑完自动折叠」→ 交回那两个「默认展开思考块 / 工具卡」开关；
 *   - 手动点开过的**已结束**消息不许被重渲染折叠回去（但跑完那一下要作废手动状态）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { foldLayout, isTurnRunning, lastGroupStart, processView, shouldForgetManual } from "../../web/src/process-fold.ts";

const base = { running: false, hasAnswer: true, autoCollapse: true, defaultOpen: false, manual: null };

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
	it("跑着的时候只画最新一组（换组就地替换）", () => {
		assert.equal(processView({ ...base, running: true }), "tail");
	});

	it("跑着的时候点开就是完整时间线，再点回最新一组", () => {
		assert.equal(processView({ ...base, running: true, manual: true }), "all");
		assert.equal(processView({ ...base, running: true, manual: false }), "tail");
	});

	it("跑完自动收起（默认设置，有最终答案）", () => {
		assert.equal(processView({ ...base, running: false }), "collapsed");
	});

	it("收不起来就不会收：以工具调用收尾（没有最终答案）时摊开", () => {
		assert.equal(processView({ ...base, hasAnswer: false }), "all");
	});

	it("关掉「跑完自动折叠」→ 交回两个默认展开开关", () => {
		const off = { ...base, autoCollapse: false };
		assert.equal(processView({ ...off, defaultOpen: true }), "all");
		assert.equal(processView({ ...off, defaultOpen: false }), "collapsed");
	});

	it("手动优先：已结束的消息点开就得一直开着", () => {
		assert.equal(processView({ ...base, manual: true }), "all");
		assert.equal(processView({ ...base, hasAnswer: false, manual: false }), "collapsed");
	});
});

describe("最新一组从哪里开始", () => {
	const thinking = { thinking: { text: "想" } };
	const lead = { thinking: null };

	it("组的边界在「新开一段思考」：它后面的说明和工具都算这一组", () => {
		const segments = [
			{ kind: "process", groups: [thinking] },
			{ kind: "text", text: "第一组说明" },
			{ kind: "process", groups: [lead] },
			{ kind: "process", groups: [thinking] },
			{ kind: "text", text: "第二组说明" },
			{ kind: "process", groups: [lead] },
		] as const;
		assert.deepEqual(lastGroupStart(segments), { segmentIndex: 3, groupIndex: 0 });
	});

	it("同一段里挤了好几组（想 → 工具 → 想 → 工具，中间没说话）→ 只从最后那段思考开始画", () => {
		const segments = [{ kind: "process", groups: [thinking, lead, thinking, lead] }] as const;
		assert.deepEqual(lastGroupStart(segments), { segmentIndex: 0, groupIndex: 2 });
	});

	it("一次思考都没有 → 最后一个过程段的开头", () => {
		const segments = [
			{ kind: "process", groups: [lead] },
			{ kind: "text", text: "说明" },
			{ kind: "process", groups: [lead, lead] },
		] as const;
		assert.deepEqual(lastGroupStart(segments), { segmentIndex: 2, groupIndex: 0 });
	});

	it("压根没动手 → null（纯文字回复不需要折叠）", () => {
		assert.equal(lastGroupStart([{ kind: "text", text: "第一段" }, { kind: "text", text: "第二段" }]), null);
	});
});

describe("跑完那一下作废手动状态", () => {
	it("上一帧在跑、这一帧不跑 → 作废（跑完自动收起）", () => {
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

	it("以工具收尾（最后动手之后没结论）→ 不该收，否则屏幕上只剩一行按钮", () => {
		const layout = foldLayout([{ kind: "process" }, { kind: "text", text: "查到了，接下来跑一下" }, { kind: "process" }]);
		assert.equal(layout.hasAnswer, false);
		assert.equal(layout.insideFold(1), false); // 最后那段说明不在任何结论之前？它在，但不该藏（hasAnswer=false 时根本不会进入收起状态）
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
		const layout = foldLayout([{ kind: "text", text: "第一段" }, { kind: "text", text: "第二段" }]);
		assert.equal(layout.firstProcessAt, -1);
		assert.equal(layout.hasAnswer, false);
		assert.deepEqual([0, 1].map(layout.insideFold), [false, false]);
	});
});
