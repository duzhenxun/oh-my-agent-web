/**
 * 客户端设置（ADR-0020 §P1）：`<dataDir>/settings.json`。
 *
 * 与 ADR-0005 的索引同一套纪律：**原子写、坏文件不致命、可重建**（重建 = 回默认值）。
 * 归一化放在纯函数里（`normalizeQuickPhrases`），因为「用户能贴进来什么」永远想不到 ——
 * 单条超长、重复、空白、几百条，都必须在上盘前收敛。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const SETTINGS_FILE = "settings.json";
export const SETTINGS_VERSION = 1;

/** 与 ADR-0020 对齐的上限 */
export const MAX_QUICK_PHRASES = 30;
export const MAX_QUICK_PHRASE_CHARS = 200;

export const DEFAULT_QUICK_PHRASES = [
	"继续",
	"总结一下",
	"详细解释一下",
	"检查并修复问题",
	"补充测试覆盖",
	"提交并跑测试",
];

export type ClientSettings = {
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
};

export function defaultSettings(): ClientSettings {
	return { quickPhrases: [...DEFAULT_QUICK_PHRASES], quickPhrasesEnabled: true };
}

/**
 * 纯函数：规范化快捷短语列表 —— 去空白、限制单条长度、去重、限制条数。
 * 顺序保持用户给的原样（拖拽排序是后话，见 ADR-0020）。
 */
export function normalizeQuickPhrases(input: unknown): string[] {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	const out: string[] = [];
	for (const item of input) {
		if (typeof item !== "string") continue;
		const text = item.replace(/\s+/g, " ").trim();
		if (text === "") continue;
		const clipped = text.length > MAX_QUICK_PHRASE_CHARS ? text.slice(0, MAX_QUICK_PHRASE_CHARS) : text;
		if (seen.has(clipped)) continue;
		seen.add(clipped);
		out.push(clipped);
		if (out.length >= MAX_QUICK_PHRASES) break;
	}
	return out;
}

/** 纯函数：把外来的部分设置合并进现有设置（坏值一律忽略，不抛） */
export function mergeSettings(current: ClientSettings, patch: unknown): ClientSettings {
	if (typeof patch !== "object" || patch === null) return current;
	const record = patch as Record<string, unknown>;
	const next: ClientSettings = { ...current };
	if ("quickPhrases" in record) next.quickPhrases = normalizeQuickPhrases(record.quickPhrases);
	if (typeof record.quickPhrasesEnabled === "boolean") next.quickPhrasesEnabled = record.quickPhrasesEnabled;
	return next;
}

/** 纯函数：解析设置文件；坏内容/缺字段回默认值 */
export function parseSettings(text: string): ClientSettings {
	let parsed: unknown;
	try {
		parsed = JSON.parse(text);
	} catch {
		return defaultSettings();
	}
	return mergeSettings(defaultSettings(), parsed);
}

export type SettingsStore = {
	load: () => Promise<ClientSettings>;
	save: (settings: ClientSettings) => Promise<void>;
};

export function settingsPath(dataDir: string): string {
	return join(dataDir, SETTINGS_FILE);
}

export function createFileSettingsStore(dataDir: string): SettingsStore {
	return {
		async load() {
			try {
				return parseSettings(await readFile(settingsPath(dataDir), "utf8"));
			} catch {
				return defaultSettings(); // 文件不存在/读不了 = 用默认值
			}
		},
		async save(settings) {
			const target = settingsPath(dataDir);
			await mkdir(dirname(target), { recursive: true });
			const temporary = `${target}.tmp`;
			const payload = { v: SETTINGS_VERSION, ...settings };
			await writeFile(temporary, `${JSON.stringify(payload, null, "\t")}\n`, "utf8");
			await rename(temporary, target); // 原子替换
		},
	};
}

/** 内存版（单测 / 不落盘） */
export function createMemorySettingsStore(seed: ClientSettings = defaultSettings()): SettingsStore {
	let current = { ...seed };
	return {
		async load() {
			return { ...current };
		},
		async save(settings) {
			current = { ...settings };
		},
	};
}
