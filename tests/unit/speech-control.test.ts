/**
 * 发送一条消息时，上一条回复的朗读该怎么处理。
 *
 * 为什么值得单测：这两个「停」合并成一个函数是很自然的“简化”，但后果是把两种意图揁死 ——
 * 用户敲回车（换轮）只是让当前那句闭嘴，新回复还要念；用户选了「排队」则是这一轮整个
 * 不听了；而「插队」根本不该动声音。这里用最小成本把这三种口径钉死。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	interruptSpeechForSend,
	onInterruptSpeechRequest,
	onStopSpeechRequest,
	requestInterruptSpeech,
	requestStopSpeech,
	speechActionForSend,
} from "../../web/src/speech-control.ts";

describe("停止 / 打断是两条独立通道", () => {
	it("打断只通知打断订阅者，停止只通知停止订阅者", () => {
		const seen: string[] = [];
		const offStop = onStopSpeechRequest(() => seen.push("stop"));
		const offInterrupt = onInterruptSpeechRequest(() => seen.push("interrupt"));
		try {
			requestInterruptSpeech();
			assert.deepEqual(seen, ["interrupt"], "打断不该把「停止」的订阅者也叫起来");
			requestStopSpeech();
			assert.deepEqual(seen, ["interrupt", "stop"]);
		} finally {
			offStop();
			offInterrupt();
		}
	});

	it("取消订阅之后不再收到", () => {
		let count = 0;
		const off = onInterruptSpeechRequest(() => {
			count += 1;
		});
		requestInterruptSpeech();
		off();
		requestInterruptSpeech();
		assert.equal(count, 1);
	});
});

describe("发送模式 → 朗读动作", () => {
	it("now 立刻抓、queue 连剩下的也不念、steer 不动", () => {
		assert.equal(speechActionForSend("now"), "interrupt");
		assert.equal(speechActionForSend("queue"), "stop");
		assert.equal(speechActionForSend("steer"), "none", "插队是往这一轮里插一句，用户还在听");
	});

	it("steer 不发任何停广播，queue / now 各走各的通道", () => {
		const seen: string[] = [];
		const offStop = onStopSpeechRequest(() => seen.push("stop"));
		const offInterrupt = onInterruptSpeechRequest(() => seen.push("interrupt"));
		try {
			interruptSpeechForSend("steer");
			assert.deepEqual(seen, []);
			interruptSpeechForSend("queue");
			assert.deepEqual(seen, ["stop"], "排队走「这一轮不再念」那条");
			interruptSpeechForSend("now");
			assert.deepEqual(seen, ["stop", "interrupt"], "换轮只抓当前声音");
		} finally {
			offStop();
			offInterrupt();
		}
	});
});
