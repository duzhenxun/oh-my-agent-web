/**
 * 临时对话（pi 的 `--no-session`）与派生分支（pi 的 `/fork`）。
 *
 * 两条链路的**宿主侧**逻辑都在这里：引擎那一半（`SessionManager.inMemory` /
 * `createBranchedSession`）由 pi 自己保证，宿主只负责三件事：
 *   1. 建会话时把 `ephemeral` / `fork` 透给引擎，并把「临时」记在会话元数据上；
 *   2. 派生时改用**引擎分配的会话 id**（`createBranchedSession` 不采纳传入的 id，
 *      不改的话内存 id 和文件 header 里的 id 会分叉，扫盘后侧栏出现重复会话）；
 *   3. 转正 / 派生的前置条件（空会话不落盘、跑着回合不转正、临时对话不能 fork）。
 *
 * 用假引擎跑：它忠实复现了「没落盘就不能 fork」这条真引擎行为。
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { createFakeEngine } from "../../server/engine/fake.ts";
import { createConversationFactory, type ConversationSeed } from "../../server/session/conversation-create.ts";
import { createPersistConversation } from "../../server/session/persist-ephemeral.ts";
import { createForkSession } from "../../server/session/fork-session.ts";
import { createPiSessionOpener } from "../../server/session/pi-opener.ts";
import { createServerState } from "../../server/snapshot/state.ts";

const WORKSPACE = "/tmp/agent-web-ephemeral";

function makeHarness() {
	const engine = createFakeEngine({ chunkDelayMs: 0 });
	const state = createServerState(WORKSPACE, "pi", "allow");
	const notices: { text: string; level: string }[] = [];
	const notice = (text: string, level: "info" | "warn" | "error") => notices.push({ text, level });

	const opener = createPiSessionOpener({
		engine,
		onModel: (model, conversationId) => {
			state.modelByConversation[conversationId] = model;
		},
		onError: (message) => notices.push({ text: message, level: "error" }),
	});

	const conversations = createConversationFactory({
		state,
		engine,
		opener,
		nextId: (prefix) => `${prefix}-${state.conversations.length + 1}`,
		newConversationId: () => `conv-${state.conversations.length + 1}`,
		now: () => 1_700_000_000_000,
		titleChars: 24,
	});

	const create = (seedText: string, workspace?: string, seed?: ConversationSeed) =>
		conversations.create(seedText, workspace, seed);

	const persist = createPersistConversation({
		engine,
		conversations: () => state.conversations,
		register: (input) => opener.register(input),
		refreshSessions: async () => {},
		clearEphemeral: (conversationId) => {
			state.conversations = state.conversations.map((item) => {
				if (item.id !== conversationId) return item;
				const { ephemeral: _temporary, ...rest } = item;
				return rest;
			});
		},
		isBusy: () => false,
		notice,
		pushSnapshot: () => {},
	});

	const fork = createForkSession({
		create,
		conversations: () => state.conversations,
		infoOf: (id) => opener.infoOf(id),
		open: async () => true,
		clientView: { setActive: () => {} },
		notice,
		pushSnapshot: () => {},
		refreshSessions: async () => {},
	});

	return { engine, state, notices, opener, create, persist, fork };
}

test("临时对话：引擎拿到 ephemeral，会话元数据标上 ephemeral，且没有会话文件", async () => {
	const { engine, state, create } = makeHarness();
	const id = await create("新对话", WORKSPACE, { ephemeral: true });

	const conversation = state.conversations.find((item) => item.id === id);
	assert.ok(conversation, "会话要进列表（只是不进历史）");
	assert.equal(conversation.ephemeral, true);
	// 引擎那边必须是「不落盘」的会话：sessionPath = null 就是 pi 的 inMemory 语义
	assert.equal(engine.sessions().get(id)?.sessionPath, null);
	// 反过来，普通会话照旧有文件
	const normalId = await create("普通对话", WORKSPACE);
	assert.equal(engine.sessions().get(normalId)?.sessionPath, `fake-sessions/${normalId}.jsonl`);
	assert.equal(state.conversations.find((item) => item.id === normalId)?.ephemeral, undefined);
});

test("保存为正式对话：拿到文件路径、清掉临时标记；空会话不落盘", async () => {
	const { state, engine, create, persist } = makeHarness();

	// 空会话：一个字没说，不该在历史里多出个空行
	const emptyId = await create("新对话", WORKSPACE, { ephemeral: true });
	const emptyResult = await persist(emptyId);
	assert.equal(emptyResult.ok, false);
	assert.equal(state.conversations.find((item) => item.id === emptyId)?.ephemeral, true, "失败时标记要留着");

	// 说过话的会话：转正后标记消失、会话文件出现
	const id = await create("新对话", WORKSPACE, { ephemeral: true });
	engine.sessions().get(id)?.transcript.push({ role: "user", text: "你好", ts: 1 });
	const result = await persist(id);
	assert.deepEqual(result, { ok: true });
	assert.equal(state.conversations.find((item) => item.id === id)?.ephemeral, undefined);
	assert.equal(engine.sessions().get(id)?.sessionPath, `fake-sessions/${id}.jsonl`);
});

test("保存为正式对话：跑着回合时拒绝（不把一轮对话拦腰砍断）", async () => {
	const { create, engine } = makeHarness();
	const id = await create("新对话", WORKSPACE, { ephemeral: true });
	engine.sessions().get(id)?.transcript.push({ role: "user", text: "你好", ts: 1 });

	const persist = createPersistConversation({
		engine,
		conversations: () => [{ id, title: "t", createdAt: 0, updatedAt: 0, workspace: WORKSPACE, ephemeral: true }],
		register: () => {},
		refreshSessions: async () => {},
		clearEphemeral: () => {},
		isBusy: () => true,
		notice: () => {},
		pushSnapshot: () => {},
	});
	const result = await persist(id);
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.error.code, "session.busy");
});

test("派生分支：新会话复制历史、原会话不动，且改用引擎分配的 id", async () => {
	const { engine, state, create, fork } = makeHarness();
	const sourceId = await create("原对话", WORKSPACE);
	const transcript = engine.sessions().get(sourceId)?.transcript as { role: string; text: string; ts: number }[];
	transcript.push({ role: "user", text: "第一问", ts: 1 });
	transcript.push({ role: "assistant", text: "第一答", ts: 2 });
	transcript.push({ role: "user", text: "第二问", ts: 3 });

	// 从「第一答」（fake 的 entry id 是 `fake-<会话>-<序号>`）派生
	const result = await fork(sourceId, `fake-${sourceId}-1`);
	assert.ok(result.ok, "派生要成功");
	const forkedId = result.ok ? result.conversationId : "";

	const forked = engine.sessions().get(forkedId);
	assert.ok(forked, "新会话已经建出来");
	// **引擎确实换了个 id**（pi 的 `createBranchedSession` 行为）：宿主必须改用它，
	// 否则引擎表里只有那个没人用的 id，下一条消息就是 `engine.no_session`（曾经的 bug）。
	assert.notEqual(forkedId, `conv-2`, "派生会话的 id 是引擎分配的，不是请求里的那个");
	// 截断点包含在内：第一问 + 第一答，第二问不在
	assert.deepEqual(
		forked.transcript.map((message) => message.text),
		["第一问", "第一答"],
	);
	// 历史已经读回宿主：新会话界面上不是一片空白
	assert.deepEqual(
		(state.messages[forkedId] ?? []).map((message) =>
			message.blocks.map((block) => (block.kind === "text" ? block.text : "")).join(""),
		),
		["第一问", "第一答"],
	);
	// 最关键的回归：在派生会话上继续发消息，引擎得认得它（“engine.no_session” 就是用户看到的那条错）
	const events: { type: string; code?: string }[] = [];
	await engine.sendMessage(forkedId, "接着聊", (event: { type: string; code?: string }) => events.push(event));
	assert.equal(
		events.some((event) => event.code === "engine.no_session"),
		false,
		"派生会话在引擎里必须存在（否则发消息就是 engine.no_session）",
	);
	// 原会话一个字不动
	assert.equal(engine.sessions().get(sourceId)?.transcript.length, 3);
	// 新会话进列表、并成为当前会话
	assert.ok(state.conversations.some((item) => item.id === forkedId));
	assert.equal(state.activeId, forkedId);
	// 标题带「分支 · 」前缀，侧栏里一眼看得出它是派生的
	assert.match(state.conversations.find((item) => item.id === forkedId)?.title ?? "", /^分支 · /);
});

test("派生分支：临时对话没有会话文件，必须明确拒绝（不是静默失败）", async () => {
	const { create, fork, notices } = makeHarness();
	const ephemeralId = await create("新对话", WORKSPACE, { ephemeral: true });
	const result = await fork(ephemeralId, `fake-${ephemeralId}-0`);
	assert.equal(result.ok, false);
	assert.equal(result.ok === false && result.error.code, "session.ephemeral");
	assert.ok(notices.length === 0, "这条拒绝走错误码，不该额外弹一条提示");
});
