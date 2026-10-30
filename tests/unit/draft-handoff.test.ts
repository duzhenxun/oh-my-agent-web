/**
 * 输入框草稿按会话各存一份（`web/src/store.ts` 的 `handoffDraft` / `forgetDraft`）。
 *
 * 用户 2026-10-30 报的 bug：「输入框输入文字后，再切会话时，原来会话的输入内容带过来」——
 * 以前 `draft` 全局只有一份，切会话一个字都不动，A 里没发出去的半句话会原样出现在 B 的输入框里
 * （更危险的是照常按下回车就发给了 B）。修法是「各存各的，回来还在」：
 * 切走时存回原来那一格，切回来时再取出来。
 *
 * 这里只测纯逻辑（`store` 是模块级单例，不渲染组件）：
 * 串味、丢字、同一条会话重复交接、会话没了之后草稿跟着消失。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { forgetDraft, getAppState, handoffDraft, setAppState, setDraft } from "../../web/src/store.ts";
import type { Snapshot } from "../../web/src/types.ts";

/** 只造 `handoffDraft` 会用到的那一小块快照（`active.conversationId`） */
function fakeSnapshot(conversationId: string | null): Snapshot {
	return { active: { conversationId, messages: [], hasMoreBefore: false } } as unknown as Snapshot;
}

function openConversation(conversationId: string | null): void {
	setAppState({ snapshot: fakeSnapshot(conversationId), pendingActive: null, newSession: null });
}

/** 模拟真实的一次「切到这条会话」：先交接草稿，再让快照把视图切过去（顺序跟 `ws.ts` 一致） */
function enter(conversationId: string | null): void {
	handoffDraft(conversationId);
	openConversation(conversationId);
}

const draft = () => getAppState().draft;

describe("切会话时的草稿交接", () => {
	it("A 里打的半句话不会串到 B，切回 A 还在", () => {
		enter("conv-a");
		setDraft("再检查一下这个系统有没有会导致卡的地方");

		enter("conv-b");
		assert.equal(draft(), "", "切到 B 时输入框必须是空的");

		enter("conv-a");
		assert.equal(draft(), "再检查一下这个系统有没有会导致卡的地方", "切回 A 要恢复它自己那份");
	});

	it("两条会话各写一段，各回各的（互不覆盖）", () => {
		enter("conv-p");
		setDraft("P 的草稿");
		enter("conv-q");
		setDraft("Q 的草稿");
		enter("conv-p");
		assert.equal(draft(), "P 的草稿");
		enter("conv-q");
		assert.equal(draft(), "Q 的草稿");
	});

	it("同一条会话重复交接（重连后重新声明「我在看哪条」）不动输入框", () => {
		enter("conv-a");
		setDraft("正在写的东西");
		enter("conv-a");
		assert.equal(draft(), "正在写的东西", "同一条会话之间不该清空或覆盖");
	});

	it("「新会话界面」是独立一格：不记到上一条会话头上，也不丢", () => {
		enter("conv-a");
		setDraft("A 的字");
		enter(null); // 点「新会话」：新会话界面从它自己那一格开始（这里是空）
		assert.equal(draft(), "", "新会话界面从空输入框开始");

		setDraft("还没发出去的新问题");
		enter("conv-a"); // 又点回 A
		assert.equal(draft(), "A 的字");

		enter(null); // 再进新会话界面
		assert.equal(draft(), "还没发出去的新问题", "刚才在「新会话界面」写的还应该在");
	});
});

describe("会话没了之后的草稿", () => {
	it("forgetDraft 之后那一格就空了（id 被复用时不会凭空顶出旧话）", () => {
		enter("conv-gone");
		setDraft("马上要删掉的会话里的字");
		enter("conv-other");

		forgetDraft("conv-gone");
		enter("conv-gone");
		assert.equal(draft(), "", "删掉的会话不该再带回它的草稿");
	});

	it("空草稿不留档：切走再切回来就是空，不会留着上一次的残影", () => {
		enter("conv-empty");
		setDraft("");
		enter("conv-a");
		enter("conv-empty");
		assert.equal(draft(), "");
	});
});
