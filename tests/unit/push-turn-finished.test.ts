/**
 * 回合结束的推送文案（`server/push/push.ts` 的 `notifyTurnFinished`）。
 *
 * 设计约定：排版按手机锁屏来定 —— 第一行项目名、第二行会话名，**不加「回合完成」这种套话**
 * （通知出现本身就代表完成了）。
 *
 * 但这个约定有个前提：通知出现 == 成功。以前 `turn-finish` 把 `failed` 写死成 false，
 * 而推送那边压根不读这个字段，于是**失败 / 被停掉的回合和正常完成在锁屏上一模一样**。
 * 现在只在「不是正常完成」时加一个语言中立的前缀。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import {
	brandNameOf,
	notifyTurnFinished,
	projectNameOf,
	type PushPayload,
	type PushPayloadSource,
	type PushStore,
	type PushSubscriptionView,
} from "../../server/push/push.ts";

/**
 * 假 store：一台设备，`send` 收到「按订阅算」的文案时**就地解析一次**，
 * 这样断言看到的就正好是那条通知真正的标题 / 正文。
 */
const fakeStore = (subscription: Partial<PushSubscriptionView> = {}): { store: PushStore; sent: PushPayload[] } => {
	const sent: PushPayload[] = [];
	const device: PushSubscriptionView = { endpoint: "https://push.example/abc", createdAt: 0, ...subscription };
	const store = {
		publicKey: async () => "",
		list: async () => [device],
		add: async () => ({ ok: true as const, total: 1 }),
		remove: async () => ({ ok: true as const, total: 0 }),
		setBrandName: async () => ({ ok: true as const, total: 1 }),
		send: async (payload: PushPayloadSource) => {
			sent.push(typeof payload === "function" ? payload(device) : payload);
			return { sent: 1, failed: 0 };
		},
	} as PushStore;
	return { store, sent };
};

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));

test("正常完成：不加任何前缀（保持「不加套话」的约定）", async () => {
	const { store, sent } = fakeStore();
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录", workspace: "/w/proj" });
	await flush();
	assert.equal(sent[0]?.body, "重构登录");
});

test("出错：正文带 ❌ 前缀（锁屏上不再和成功长得一样）", async () => {
	const { store, sent } = fakeStore();
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录", failed: true });
	await flush();
	assert.equal(sent[0]?.body, "❌ 重构登录");
});

test("被用户停掉：正文带 ⏹ 前缀", async () => {
	const { store, sent } = fakeStore();
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录", interrupted: true });
	await flush();
	assert.equal(sent[0]?.body, "⏹ 重构登录");
});

test("会话名空：回落成「会话」，前缀仍然有效", async () => {
	const { store, sent } = fakeStore();
	notifyTurnFinished(store, { conversationId: "c1", title: "   ", failed: true });
	await flush();
	assert.equal(sent[0]?.body, "❌ 会话");
});

test("拿不到项目名：标题回落成这台设备自己的界面自称", async () => {
	const { store, sent } = fakeStore({ brandName: "我的智能体" });
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录", workspace: "" });
	await flush();
	assert.equal(sent[0]?.title, "我的智能体");
});

test("没有项目名、设备也没改过名：标题仍是产品默认名（不出现空标题）", async () => {
	const { store, sent } = fakeStore();
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录" });
	await flush();
	assert.equal(sent[0]?.title, "oh-my-agent-web");
});

test("有项目名：标题依然以项目名为主，不被设备改名顶掉", async () => {
	const { store, sent } = fakeStore({ brandName: "我的智能体" });
	notifyTurnFinished(store, { conversationId: "c1", title: "重构登录", workspace: "/w/proj" });
	await flush();
	assert.equal(sent[0]?.title, "proj");
});

test("自称只有空白：按没改过处理（不把空白当名字推上锁屏）", () => {
	assert.equal(brandNameOf({ endpoint: "e", createdAt: 0, brandName: "   " }), "oh-my-agent-web");
	assert.equal(brandNameOf(undefined), "oh-my-agent-web");
	assert.equal(brandNameOf({ endpoint: "e", createdAt: 0, brandName: "  我的  " }), "我的");
});

test("projectNameOf：项目名优先，其次才是给进来的回落值", () => {
	assert.equal(projectNameOf("/w/proj", "备用名"), "proj");
	assert.equal(projectNameOf(undefined, "备用名"), "备用名");
	assert.equal(projectNameOf("", undefined), "oh-my-agent-web");
});
