import { describe, expect, it } from "vitest";
import { PROTOCOL_VERSION, type ServerEvent, type Snapshot } from "../../server/protocol.js";
import { createSender, type OutFrame } from "../../server/snapshot/sender.js";

function makeSnapshot(tag: number): Snapshot {
	return {
		protocolVersion: PROTOCOL_VERSION,
		versions: { web: "0.0.0-test", engine: "1.0.0-test" },
		engine: "fake",
		model: "test/model",
		approvalMode: "ask",
		engineCapabilities: { approvals: true, tools: true, modelSwitch: true, thinkingLevel: true, resume: true },
		providers: [],
		thinkingLevel: null,
		sessionStats: null,
		thinkingLevels: [],
		models: [],
		piProjects: [],
		actions: [],
		settings: {
			quickPhrases: [],
			quickPhrasesEnabled: true,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
			sessionPrefs: { pinned: [], archived: [] },
			defaultModels: {},
		},
		conversations: [],
		active: { conversationId: null, messages: [], hasMoreBefore: false },
		queued: [],
		enabledModels: [],
		runningByConversation: {},
		running: {
			status: "idle",
			conversationId: null,
			turnStartedAt: null,
			streamingText: `tag-${tag}`,
			activeTool: null,
		},
		pendingApproval: null,
		terminal: null,
		files: null,
		notices: [],
	};
}

const makeEvent = (text: string): ServerEvent => ({
	type: "event",
	event: "message_delta",
	conversationId: "c1",
	messageId: "m1",
	text,
});

function harness(windowMs = 60) {
	const frames: OutFrame[] = [];
	const sender = createSender({ windowMs, send: (frame) => frames.push(frame) });
	return { sender, frames };
}

describe("节流：快照按窗口合并（ADR-0004 §3）", () => {
	it("窗口内的多次推送只发出最后一帧", () => {
		const { sender, frames } = harness();
		sender.pushSnapshot(makeSnapshot(1));
		sender.pushSnapshot(makeSnapshot(2));
		sender.pushSnapshot(makeSnapshot(3));

		sender.tick(1000);
		expect(frames).toHaveLength(1);
		expect((frames[0] as { snapshot: Snapshot }).snapshot.running.streamingText).toBe("tag-3");

		const stats = sender.stats();
		expect(stats.sentSnapshots).toBe(1);
		expect(stats.coalescedSnapshots).toBe(2);
	});

	it("窗口未到不发；窗口一到就发", () => {
		const { sender, frames } = harness(60);
		sender.pushSnapshot(makeSnapshot(1));
		sender.tick(1000);
		expect(frames).toHaveLength(1);

		sender.pushSnapshot(makeSnapshot(2));
		sender.tick(1030); // 距上次 30ms，未到窗口
		expect(frames).toHaveLength(1);
		sender.tick(1060); // 恰好到窗口
		expect(frames).toHaveLength(2);
	});

	it("首帧不需要等窗口（首屏立刻可见）", () => {
		const { sender, frames } = harness(60);
		sender.pushSnapshot(makeSnapshot(1));
		sender.tick(0);
		expect(frames).toHaveLength(1);
	});
});

describe("背压：快照可丢，事件绝不丢（ADR-0004 §4）", () => {
	it("busy 时跳过快照，但事件照发", () => {
		const { sender, frames } = harness();
		sender.setBusy(true);
		sender.pushSnapshot(makeSnapshot(1));
		sender.pushEvent(makeEvent("a"));
		sender.tick(1000);
		sender.tick(2000);

		expect(frames.map((frame) => frame.kind)).toEqual(["event"]);
		expect(sender.stats().skippedSnapshots).toBeGreaterThan(0);
		expect(sender.hasPendingSnapshot()).toBe(true);
	});

	it("积压解除后，一帧快照把状态收敛回去", () => {
		const { sender, frames } = harness();
		sender.setBusy(true);
		sender.pushSnapshot(makeSnapshot(1));
		sender.pushSnapshot(makeSnapshot(2));
		sender.tick(1000);
		sender.setBusy(false);
		sender.tick(2000);

		const snapshots = frames.filter((frame) => frame.kind === "snapshot") as Array<{ snapshot: Snapshot }>;
		expect(snapshots).toHaveLength(1);
		expect(snapshots[0].snapshot.running.streamingText).toBe("tag-2");
	});

	it("事件数量不受快照丢弃影响", () => {
		const { sender, frames } = harness();
		sender.setBusy(true);
		for (let index = 0; index < 50; index += 1) {
			sender.pushEvent(makeEvent(`delta-${index}`));
			sender.pushSnapshot(makeSnapshot(index));
			sender.tick(index * 100);
		}
		const events = frames.filter((frame) => frame.kind === "event");
		expect(events).toHaveLength(50);
		expect(sender.stats().sentEvents).toBe(50);
	});
});

describe("丢帧收敛（ADR-0012 守卫 1 的核心性质）", () => {
	it("随机丢弃快照帧之后，最后一帧仍然等于最终状态", () => {
		// 模拟：状态连续变化，快照按窗口合并 + 随机因背压被跳过；
		// 因为快照是「全量视图」，所以最后送达的那一帧必须与最终状态完全一致。
		let sent = 0;
		let lastDelivered: Snapshot | null = null;
		const sender = createSender({
			windowMs: 60,
			send: (frame) => {
				sent += 1;
				if (frame.kind === "snapshot") lastDelivered = frame.snapshot;
			},
		});

		let finalSnapshot = makeSnapshot(0);
		const random = mulberry32(42);

		for (let step = 0; step < 500; step += 1) {
			finalSnapshot = makeSnapshot(step);
			sender.pushSnapshot(finalSnapshot);
			// 30% 概率处于积压状态（快照被跳过）
			sender.setBusy(random() < 0.3);
			sender.tick(step * 20);
		}

		// 收尾：解除积压并给足窗口
		sender.setBusy(false);
		sender.tick(500 * 20 + 1000);

		expect(sent).toBeGreaterThan(0);
		expect(lastDelivered).toEqual(finalSnapshot);
	});

	it("连续丢弃任意多帧都不影响收敛（极端：前 999 帧全丢）", () => {
		let lastDelivered: Snapshot | null = null;
		const sender = createSender({
			windowMs: 60,
			send: (frame) => {
				if (frame.kind === "snapshot") lastDelivered = frame.snapshot;
			},
		});

		sender.setBusy(true);
		for (let step = 0; step < 1000; step += 1) {
			sender.pushSnapshot(makeSnapshot(step));
			sender.tick(step * 100);
		}
		sender.setBusy(false);
		sender.tick(200_000);

		expect(lastDelivered).toEqual(makeSnapshot(999));
	});
});

function mulberry32(seed: number) {
	let state = seed;
	return () => {
		state |= 0;
		state = (state + 0x6d2b79f5) | 0;
		let t = Math.imul(state ^ (state >>> 15), 1 | state);
		t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
		return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
	};
}
