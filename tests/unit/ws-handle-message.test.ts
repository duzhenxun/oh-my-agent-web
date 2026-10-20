/**
 * 请求分发的接线（回归：曾经漏把 `mode` 传给 runtime，导致「排队」被当成「引导」）。
 *
 * 这一层不测业务，只测**参数有没有原样传到 runtime**——上一版就是因为
 * 协议、runtime、前端三层都对，中间这一层漏了一个参数，而没人发现。
 */
import { describe, expect, it } from "vitest";
import { handleMessage, type HandleDeps } from "../../server/ws/handle-message.js";

function makeDeps(overrides: Partial<HandleDeps["runtime"]> = {}) {
	const calls: { method: string; args: unknown[] }[] = [];
	const replies: { id: string; result: unknown }[] = [];
	const runtime = new Proxy(
		{
			sendMessage: async (...args: unknown[]) => {
				calls.push({ method: "sendMessage", args });
				return { ok: true };
			},
			...overrides,
		} as Record<string, unknown>,
		{
			get(target, prop: string) {
				if (prop in target) return target[prop];
				return async (...args: unknown[]) => {
					calls.push({ method: prop, args });
					return { ok: true };
				};
			},
		},
	) as unknown as HandleDeps["runtime"];
	const deps: HandleDeps = {
		runtime,
		reply: (_socket, id, result) => replies.push({ id, result }),
		sender: { pushSnapshot: () => {}, flush: () => {} },
		logger: { warn: () => {}, info: () => {}, error: () => {}, debug: () => {} } as unknown as HandleDeps["logger"],
		runProviderRequest: async () => {},
	};
	return { deps, calls, replies };
}

const socket = {} as never;

describe("handleMessage：send_message 的 mode 透传", () => {
	it("mode=queue 原样传到 runtime（不会被默认成 steer）", async () => {
		const { deps, calls } = makeDeps();
		await handleMessage(
			socket,
			JSON.stringify({ id: "r1", type: "send_message", payload: { text: "排队这条", mode: "queue" } }),
			deps,
		);
		expect(calls[0]?.method).toBe("sendMessage");
		expect(calls[0]?.args).toEqual(["排队这条", undefined, "queue"]);
	});

	it("mode=steer 原样传", async () => {
		const { deps, calls } = makeDeps();
		await handleMessage(
			socket,
			JSON.stringify({ id: "r2", type: "send_message", payload: { text: "插队这条", mode: "steer" } }),
			deps,
		);
		expect(calls[0]?.args?.[2]).toBe("steer");
	});

	it("不带 mode 时传 undefined（让 runtime 用自己的默认值）", async () => {
		const { deps, calls } = makeDeps();
		await handleMessage(socket, JSON.stringify({ id: "r3", type: "send_message", payload: { text: "普通" } }), deps);
		expect(calls[0]?.args?.[2]).toBeUndefined();
	});

	it("带附件时也保留 mode", async () => {
		const { deps, calls } = makeDeps();
		const attachment = { id: "up1", kind: "image", name: "a.png", mime: "image/png", bytes: 10 };
		await handleMessage(
			socket,
			JSON.stringify({
				id: "r4",
				type: "send_message",
				payload: { text: "带图", attachments: [attachment], mode: "queue" },
			}),
			deps,
		);
		expect(calls[0]?.args?.[2]).toBe("queue");
	});
});

describe("handleMessage：其它请求仍然照旧分发", () => {
	it("approve 调到 runtime.approve", async () => {
		const { deps, calls } = makeDeps();
		await handleMessage(
			socket,
			JSON.stringify({ id: "r5", type: "approve", payload: { requestId: "a1", decision: "once" } }),
			deps,
		);
		expect(calls[0]?.method).toBe("approve");
	});

	it("非法载荷不调 runtime，但会回一个错误", async () => {
		const { deps, calls, replies } = makeDeps();
		await handleMessage(socket, JSON.stringify({ id: "r6", type: "send_message", payload: {} }), deps);
		expect(calls).toHaveLength(0);
		expect(replies[0]?.result).toMatchObject({ ok: false });
	});
});
