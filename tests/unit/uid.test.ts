/**
 * `newId()`（`web/src/lib/uid.ts`）：**非安全上下文**（http + 局域网 IP）里也要能生成 id。
 *
 * 用户 2026-10-30 实测：用 `http://192.168.17.100:25257` 打开，控制台报
 * `crypto.randomUUID is not a function`，界面卡在「等待服务端快照…」。
 * 原因：`crypto.randomUUID` 只在 https / localhost 下存在；`getRandomValues` 则在任何上下文都有。
 * 这里把三条路都钉住：有 randomUUID 用它、没有就用 getRandomValues 拼、两者都没有才 Math.random。
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { newId } from "../../web/src/lib/uid.ts";

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const original = Object.getOwnPropertyDescriptor(globalThis, "crypto");

/** 临时换掉 globalThis.crypto（Node 里它是 getter，所以用 defineProperty） */
function stubCrypto(value: unknown, run: () => void): void {
	Object.defineProperty(globalThis, "crypto", { value, configurable: true, writable: true });
	try {
		run();
	} finally {
		if (original) Object.defineProperty(globalThis, "crypto", original);
	}
}

afterEach(() => {
	if (original) Object.defineProperty(globalThis, "crypto", original);
});

describe("newId", () => {
	it("正常环境：UUID v4 形状，且不重复", () => {
		const seen = new Set<string>();
		for (let index = 0; index < 100; index += 1) {
			const id = newId();
			assert.match(id, UUID_V4);
			seen.add(id);
		}
		assert.equal(seen.size, 100);
	});

	it("非安全上下文（没有 randomUUID，只剩 getRandomValues）：照样出合法 id", () => {
		const bytes = new Uint8Array(16);
		const cryptoWithoutRandomUUID = {
			getRandomValues: (array: Uint8Array) => {
				array.set(bytes.map((_, index) => index * 7 + 3));
				return array;
			},
		};
		stubCrypto(cryptoWithoutRandomUUID, () => {
			const id = newId();
			assert.match(id, UUID_V4);
			assert.equal(id, "030a1118-1f26-4d34-bb42-4950575e656c");
		});
	});

	it("连 crypto 都没有：退到 Math.random，仍然是合法 id", () => {
		stubCrypto(undefined, () => {
			const id = newId();
			assert.match(id, UUID_V4);
		});
	});
});
