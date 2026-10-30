/**
 * 提示牌的**会话归属**（`server/session/runtime-services.ts` 的 notice）。
 *
 * 用户报过：「一个会话报的错，在别的会话 / 别的窗口的提示条上也冒出来」。
 * 根因很蠢：`notice` 声明了四个参数（text / level / key / conversationId），
 * 实现只往下沉转了三个 —— `conversationId` 被吃掉，于是所有提示都成了「全局」的。
 *
 * 这条链路现在有三个用户：回合报错（error 事件）、引擎的过程提示（notice 事件）、
 * 审批桥。任何一个把位置传错，表现就是「提示跑到别的会话里」或者「怎么都不显示」。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { EnginePort } from "../../server/engine/port.ts";
import type { Notice } from "../../server/protocol.ts";
import { createRuntimeServices } from "../../server/session/runtime-services.ts";

function makeServices() {
	const pushed: Notice[] = [];
	let seq = 0;
	const services = createRuntimeServices({
		options: {
			// 这两个只被审批桥用；本测试不碰审批
			engine: { setApprovalHandler: () => {} } as unknown as EnginePort,
			rules: {} as never,
		},
		now: () => 1_000,
		nextId: (prefix) => `${prefix}-${++seq}`,
		onNotice: (notice) => pushed.push(notice),
		onPending: () => {},
		isWaitingForUser: () => false,
		modeOf: () => "allow",
	});
	return { services, pushed };
}

describe("notice 的会话归属", () => {
	it("第四个参数 conversationId 必须落到提示上（以前被吃掉 → 所有提示都变全局）", () => {
		const { services, pushed } = makeServices();
		services.notice("这一轮失败了", "error", undefined, "conv-a");
		assert.equal(pushed.length, 1);
		assert.equal(pushed[0]?.conversationId, "conv-a");
	});

	it("不给 conversationId 的提示就是全局的（比如「连不上服务端」）", () => {
		const { services, pushed } = makeServices();
		services.notice("连不上服务端", "error");
		assert.equal(pushed[0]?.conversationId, undefined);
	});

	it("同 key 原地替换（重试 1/2 → 2/2），不会堆成两条", () => {
		const { services, pushed } = makeServices();
		services.notice("正在重试（1/2）", "warn", "engine-retry:conv-a", "conv-a");
		services.notice("正在重试（2/2）", "warn", "engine-retry:conv-a", "conv-a");
		assert.equal(pushed.length, 2); // 每次变更都会推一次（界面按 id 原地换）
		assert.equal(pushed[1]?.id, pushed[0]?.id);
		assert.equal(pushed[1]?.text, "正在重试（2/2）");
		assert.equal(pushed[1]?.conversationId, "conv-a");
	});

	it("同 key 但不同会话 → 各算各的（key 该带会话 id 才安全）", () => {
		const { services, pushed } = makeServices();
		services.notice("重试中", "warn", "engine-retry:conv-a", "conv-a");
		services.notice("重试中", "warn", "engine-retry:conv-b", "conv-b");
		assert.equal(pushed.length, 2);
		assert.notEqual(pushed[0]?.id, pushed[1]?.id);
	});
});
