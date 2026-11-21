/**
 * 语音输入开麦时走哪套引擎（`web/src/voice-input.ts` 的 `engineToStart`）。
 *
 * 为什么值得单测（用户 2026-11-21：「安装完默认就用开箱即用的那种」）：
 * `auto` 以前每次开麦都先撞一次本地引擎，失败了才退 Chrome —— 对一台本来就没编译
 * `ASRBridge.app` 的机器来说，等于每次说话都先看一句「本地不可用」。
 * 规则定死在这里：auto + 已确认本地不可用 = 直接 Chrome（不弹提示、不白等）。
 *
 * 这个文件在 node 里跑：先把 `window` / `document` / `fetch` 摆好，再 import 语音模块。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

const globals = globalThis as unknown as Record<string, unknown>;
globals.window = {
	isSecureContext: true,
	setInterval: (handler: () => void, ms: number) => setInterval(handler, ms) as unknown as number,
	clearInterval: (id: number) => clearInterval(id as unknown as NodeJS.Timeout),
	setTimeout: (handler: () => void, ms: number) => setTimeout(handler, ms) as unknown as number,
	clearTimeout: (id: number) => clearTimeout(id as unknown as NodeJS.Timeout),
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	dispatchEvent: () => true,
};
globals.document = {
	visibilityState: "visible",
	addEventListener: () => undefined,
	removeEventListener: () => undefined,
	dispatchEvent: () => true,
};
// 模块会拉一次远端设置 / 本地识别状态：这里让所有请求都失败，按「没有远端」处理
globals.fetch = async () => ({ ok: false, json: async () => ({}) });

const { engineToStart } = await import("../../web/src/voice-input.ts");

describe("开麦用哪套引擎", () => {
	it("auto + 本地可用 → 本地（离线、带标点）", () => {
		assert.equal(engineToStart("auto", false), "local");
	});

	it("auto + 本地确认不可用 → 直接用 Chrome，不再先撞一次", () => {
		assert.equal(engineToStart("auto", true), "browser");
	});

	it("用户明确选 Chrome → Chrome（跟本地有没有无关）", () => {
		assert.equal(engineToStart("browser", false), "browser");
		assert.equal(engineToStart("browser", true), "browser");
	});

	it("用户明确选本地 → 按本地跑，坏了也要报出来（不悄悄换引擎）", () => {
		assert.equal(engineToStart("local", false), "local");
		assert.equal(engineToStart("local", true), "local");
	});
});
