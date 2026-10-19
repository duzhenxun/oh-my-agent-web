/**
 * 客户端设置（ADR-0020 §P1）：归一化、合并、落盘容错。
 * 归一化是纯函数 —— 「用户能贴进来什么」永远想不到，所以边界都在这里收。
 */
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
	createFileSettingsStore,
	createMemorySettingsStore,
	DEFAULT_QUICK_PHRASES,
	defaultSettings,
	MAX_QUICK_PHRASES,
	MAX_QUICK_PHRASE_CHARS,
	mergeSettings,
	normalizeQuickPhrases,
	parseSettings,
	settingsPath,
} from "../../server/session/settings.js";

let dir = "";

beforeEach(() => {
	dir = mkdtempSync(join(tmpdir(), "agent-web-settings-"));
});

afterEach(() => {
	rmSync(dir, { recursive: true, force: true });
});

describe("normalizeQuickPhrases", () => {
	it("去空白、去空项", () => {
		expect(normalizeQuickPhrases(["  继续  ", "", "   ", "总结一下"])).toEqual(["继续", "总结一下"]);
	});

	it("去重（保留第一次出现的位置）", () => {
		expect(normalizeQuickPhrases(["a", "b", "a"])).toEqual(["a", "b"]);
	});

	it("单条超长被截断到 200 字", () => {
		const long = "x".repeat(500);
		expect(normalizeQuickPhrases([long])[0]).toHaveLength(MAX_QUICK_PHRASE_CHARS);
	});

	it("最多 30 条", () => {
		const many = Array.from({ length: 100 }, (_, index) => `第 ${index} 条`);
		expect(normalizeQuickPhrases(many)).toHaveLength(MAX_QUICK_PHRASES);
	});

	it("换行被折叠成空格（一条短语只能占一行）", () => {
		expect(normalizeQuickPhrases(["继续\n然后总结"])).toEqual(["继续 然后总结"]);
	});

	it("非字符串项被忽略；不是数组就返回空", () => {
		expect(normalizeQuickPhrases([1, null, {}, "ok"])).toEqual(["ok"]);
		expect(normalizeQuickPhrases("不是数组")).toEqual([]);
		expect(normalizeQuickPhrases(undefined)).toEqual([]);
	});
});

describe("mergeSettings", () => {
	it("只改给出的字段", () => {
		const current = defaultSettings();
		expect(
			mergeSettings(current, {
				quickPhrasesEnabled: false,
				templates: [],
				projectPrefs: { order: [], pinned: [], aliases: {} },
			}).quickPhrasesEnabled,
		).toBe(false);
		expect(
			mergeSettings(current, {
				quickPhrasesEnabled: false,
				templates: [],
				projectPrefs: { order: [], pinned: [], aliases: {} },
			}).quickPhrases,
		).toEqual(current.quickPhrases);
	});

	it("坏载荷一律忽略（保持原样，不抛）", () => {
		const current = defaultSettings();
		expect(mergeSettings(current, null)).toEqual(current);
		expect(mergeSettings(current, "字符串")).toEqual(current);
		expect(mergeSettings(current, { quickPhrases: "不是数组" }).quickPhrases).toEqual([]);
		expect(mergeSettings(current, { quickPhrasesEnabled: "yes" }).quickPhrasesEnabled).toBe(true);
	});
});

describe("parseSettings", () => {
	it("坏 JSON 回默认值", () => {
		expect(parseSettings("{ 坏")).toEqual(defaultSettings());
	});

	it("缺字段时补默认", () => {
		expect(parseSettings('{"v":1}')).toEqual(defaultSettings());
	});

	it("合法文件按原样读出（并过一遍归一化）", () => {
		const parsed = parseSettings(
			JSON.stringify({
				v: 1,
				quickPhrases: ["继续", " 继续 "],
				quickPhrasesEnabled: false,
				templates: [],
				projectPrefs: { order: [], pinned: [], aliases: {} },
			}),
		);
		expect(parsed).toEqual({
			quickPhrases: ["继续"],
			quickPhrasesEnabled: false,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
	});
});

describe("文件存储", () => {
	it("保存后可读回，且是原子写（不留 .tmp）", async () => {
		const store = createFileSettingsStore(dir);
		await store.save({
			quickPhrases: ["继续"],
			quickPhrasesEnabled: false,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
		expect(existsSync(settingsPath(dir))).toBe(true);
		expect(existsSync(`${settingsPath(dir)}.tmp`)).toBe(false);
		expect(await store.load()).toEqual({
			quickPhrases: ["继续"],
			quickPhrasesEnabled: false,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
	});

	it("文件不存在 → 默认值（不是空列表）", async () => {
		expect(await createFileSettingsStore(dir).load()).toEqual(defaultSettings());
	});

	it("文件被写坏 → 默认值，不阻塞启动", async () => {
		writeFileSync(settingsPath(dir), "{ 坏设置", "utf8");
		expect(await createFileSettingsStore(dir).load()).toEqual(defaultSettings());
	});

	it("落盘内容是人能手工编辑的 JSON", async () => {
		await createFileSettingsStore(dir).save({
			quickPhrases: ["继续"],
			quickPhrasesEnabled: true,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
		const parsed = JSON.parse(readFileSync(settingsPath(dir), "utf8"));
		expect(parsed.v).toBe(1);
		expect(parsed.quickPhrases).toEqual(["继续"]);
	});

	it("默认短语是可用的（非空、无重复）", () => {
		expect(DEFAULT_QUICK_PHRASES.length).toBeGreaterThan(0);
		expect(new Set(DEFAULT_QUICK_PHRASES).size).toBe(DEFAULT_QUICK_PHRASES.length);
	});
});

describe("内存存储", () => {
	it("可预置、可读写", async () => {
		const store = createMemorySettingsStore({
			quickPhrases: ["a"],
			quickPhrasesEnabled: false,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
		expect(await store.load()).toEqual({
			quickPhrases: ["a"],
			quickPhrasesEnabled: false,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
		await store.save({
			quickPhrases: ["b"],
			quickPhrasesEnabled: true,
			templates: [],
			projectPrefs: { order: [], pinned: [], aliases: {} },
		});
		expect((await store.load()).quickPhrases).toEqual(["b"]);
	});
});
