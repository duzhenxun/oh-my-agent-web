import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	appearancePatchFromArgs,
	describeAppearance,
	describeAppearanceChange,
} from "../../server/session/appearance.ts";
import {
	applySettingsPatch,
	defaultSettings,
	normalizeAppearance,
	normalizeFontPx,
} from "../../server/session/settings.ts";
import { appearanceDecision, resetAppearanceSync } from "../../web/src/appearance-sync.ts";

const current = { chatPx: 14, projectPx: 14, sessionPx: 14 };

describe("外观工具的入参 → 要改哪一处", () => {
	it("target=all + px：三处一起改成同一个值", () => {
		const parsed = appearancePatchFromArgs({ target: "all", px: 18 }, current);
		assert.ok("patch" in parsed);
		assert.deepEqual(parsed.patch, { chatPx: 18, projectPx: 18, sessionPx: 18 });
	});

	it("只改一处：给 delta 就在当前值上加减", () => {
		const parsed = appearancePatchFromArgs({ target: "chat", delta: 2 }, current);
		assert.ok("patch" in parsed);
		assert.deepEqual(parsed.patch, { chatPx: 16 });

		const smaller = appearancePatchFromArgs({ target: "session", delta: -2 }, { ...current, sessionPx: 18 });
		assert.ok("patch" in smaller);
		assert.deepEqual(smaller.patch, { sessionPx: 16 });
	});

	it("中文 / 简写 target 也认（模型和用户都会这么说）", () => {
		const project = appearancePatchFromArgs({ target: "项目名", px: 16 }, current);
		assert.ok("patch" in project);
		assert.deepEqual(project.patch, { projectPx: 16 });
		const chat = appearancePatchFromArgs({ target: "正文", px: 20 }, current);
		assert.ok("patch" in chat);
		assert.deepEqual(chat.patch, { chatPx: 20 });
	});

	it("没给 px 也没给 delta：报错，不让它自己猜一个值", () => {
		const parsed = appearancePatchFromArgs({ target: "chat" }, current);
		assert.ok("error" in parsed);
		assert.match(parsed.error, /px|delta/);
	});

	it("未知 target 直接说清楚可用值", () => {
		const parsed = appearancePatchFromArgs({ target: "sidebar", px: 18 }, current);
		assert.ok("error" in parsed);
		assert.match(parsed.error, /chat \/ project \/ session \/ all/);
	});
});

describe("读当前值 / 报改动差值", () => {
	it("read 的正文包含三处当前字号", () => {
		const text = describeAppearance({ chatPx: 16, projectPx: 14, sessionPx: 18 });
		assert.match(text, /聊天正文：16px/);
		assert.match(text, /侧栏项目名：14px/);
		assert.match(text, /侧栏会话名：18px/);
		assert.match(text, /2–30px/);
	});

	it("改完只报真正变了的那几处，格式是 x → y", () => {
		const text = describeAppearanceChange(
			{ chatPx: 14, projectPx: 14, sessionPx: 14 },
			{
				chatPx: 18,
				projectPx: 14,
				sessionPx: 18,
			},
		);
		assert.equal(text, "- 聊天正文：14px → 18px\n- 侧栏会话名：14px → 18px");
	});

	it("值没变时说「没有改动」，而不是假装改了", () => {
		assert.match(describeAppearanceChange(current, { ...current }), /没有任何改动/);
	});
});

describe("服务端归一化：只收 2–30 的双数", () => {
	it("奇数取最近的双数，越界夹到边界", () => {
		assert.equal(normalizeFontPx(15, 14), 16);
		assert.equal(normalizeFontPx(13, 14), 14);
		assert.equal(normalizeFontPx(0, 14), 2);
		assert.equal(normalizeFontPx(99, 14), 30);
		assert.equal(normalizeFontPx("18", 14), 18);
	});

	it("坏值回落到 fallback，不抛错（settings.json 能被手改）", () => {
		assert.equal(normalizeFontPx("abc", 14), 14);
		assert.equal(normalizeFontPx(null, 14), 14);
	});

	it("部分合并：只给一处，另两处保持原值", () => {
		assert.deepEqual(normalizeAppearance({ chatPx: 18 }, { chatPx: 14, projectPx: 16, sessionPx: 20 }), {
			chatPx: 18,
			projectPx: 16,
			sessionPx: 20,
		});
	});

	it("老 settings.json（没有 appearance）读出来是 null = 没设过（不覆盖本机字号）", () => {
		assert.equal(defaultSettings().appearance, null);
	});

	it("走 set_settings 同一条路写入：只改聊天正文，其他不动", async () => {
		const state = { settings: defaultSettings() };
		await applySettingsPatch({ state, patch: { appearance: { chatPx: 18 } }, onError: () => assert.fail("不该报错") });
		assert.deepEqual(state.settings.appearance, { chatPx: 18, projectPx: 14, sessionPx: 14 });
	});
});

describe("浏览器侧：null = 没设过，设过就以服务端为准", () => {
	it("服务端没设过（null）：什么都不做，继续用本机 localStorage 那份", () => {
		resetAppearanceSync();
		assert.equal(appearanceDecision(null, null), null);
		assert.equal(appearanceDecision("14/14/14", null), null);
	});

	it("服务端设过：刷新后第一份快照就应用（换设备也一致）", () => {
		resetAppearanceSync();
		assert.equal(appearanceDecision(null, { chatPx: 18, projectPx: 14, sessionPx: 14 }), "18/14/14");
	});

	it("值没变就不动：本机面板刚拖过的字号不会被旧快照按回去", () => {
		assert.equal(appearanceDecision("18/14/14", { chatPx: 18, projectPx: 14, sessionPx: 14 }), null);
		assert.equal(appearanceDecision("18/14/14", { chatPx: 20, projectPx: 14, sessionPx: 14 }), "20/14/14");
	});

	it("字段非数字时不动（别把 NaN 写进 CSS 变量）", () => {
		assert.equal(appearanceDecision("14/14/14", { chatPx: Number.NaN, projectPx: 14, sessionPx: 14 }), null);
	});
});
