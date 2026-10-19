/**
 * 客户端设置（ADR-0020 §P1）：`<dataDir>/settings.json`。
 *
 * 与 ADR-0005 的索引同一套纪律：**原子写、坏文件不致命、可重建**（重建 = 回默认值）。
 * 归一化放在纯函数里（`normalizeQuickPhrases`），因为「用户能贴进来什么」永远想不到 ——
 * 单条超长、重复、空白、几百条，都必须在上盘前收敛。
 */
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProjectPrefs, PromptTemplate } from "../protocol.js";

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

export const MAX_TEMPLATES = 40;
export const MAX_TEMPLATE_NAME_CHARS = 24;
export const MAX_TEMPLATE_DESC_CHARS = 60;
export const MAX_TEMPLATE_TEXT_CHARS = 2000;

/**
 * 默认模板库（P5）：都是「开箱即用、点一下就填进输入框」的工作流提示词。
 * 图标用 emoji，避免为一个图标位引入图标库（依赖预算）。
 */
export const DEFAULT_TEMPLATES: PromptTemplate[] = [
	{
		id: "t-spec",
		icon: "🏗",
		name: "规格落地",
		description: "按规格测试优先实现",
		text: "按这份规格实现：先写失败的测试，再实现到测试通过。遇到规格里有歧义的地方先问我，别自己猜。",
	},
	{
		id: "t-review",
		icon: "🧹",
		name: "代码审查",
		description: "对照规格与标准审查 diff",
		text: "审查当前改动：对照规格与仓库既有约定，指出行为差异、边界条件遗漏、以及可以删掉的代码。按严重程度排序。",
	},
	{
		id: "t-map",
		icon: "🗺",
		name: "大任务地图",
		description: "把大工程画成决策地图",
		text: "把这个大任务拆成决策地图：先列出必须现在决定的选择点、各自代价，再给一条最短可交付路径。",
	},
	{
		id: "t-proto",
		icon: "⚗️",
		name: "快速原型",
		description: "用一次性代码验证设计假设",
		text: "用一次性原型验证这个设计假设：给出最小可运行代码、要观察的指标，以及结论（继续 / 换方案）。",
	},
	{
		id: "t-research",
		icon: "📚",
		name: "有据调研",
		description: "读一手来源给出带引用的答案",
		text: "调研这个问题：只读一手来源（官方文档 / 源码 / 规范），给出带链接的结论，不确定的地方明确标注。",
	},
	{
		id: "t-arch",
		icon: "🏛",
		name: "架构体检",
		description: "找出值得重构的模块",
		text: "体检这个项目的架构：找出耦合过紧、职责过载的模块，按「收益 / 风险」排序给重构建议。",
	},
	{
		id: "t-debug",
		icon: "🐛",
		name: "系统化排错",
		description: "从可复现的失败开始诊断",
		text: "系统化排错：先给我一条能稳定复现的命令，再二分定位。不要在没有复现之前猜原因。",
	},
	{
		id: "t-conflict",
		icon: "🔀",
		name: "解决合并冲突",
		description: "逐个 hunk 完成合并/变基",
		text: "解决合并冲突：逐个 hunk 看两侧意图，保留两边语义，冲突解决后跑一遍测试并说明每处取舍。",
	},
	{
		id: "t-ask",
		icon: "🔍",
		name: "需求拷问",
		description: "动手前盘问对齐想法",
		text: "动手之前先拷问我：把需求里模糊的地方列成问题（最多 5 个），每个给出你倾向的默认答案。",
	},
	{
		id: "t-handoff",
		icon: "🤝",
		name: "交接",
		description: "把长会话写成交接文档",
		text: "把这次会话整理成交接文档：已完成 / 未完成 / 关键约束 / 下一步第一步，写给完全不了解背景的人。",
	},
	{
		id: "t-plain",
		icon: "💬",
		name: "说人话",
		description: "用大白话重讲刚才的解释",
		text: "用大白话重讲一遍，把术语替换成日常类比，不超过 10 行。",
	},
	{
		id: "t-tdd",
		icon: "🧪",
		name: "测试驱动",
		description: "红-绿-重构的规则",
		text: "用测试驱动：先写一个失败的测试并让它跑给我看，再实现到绿，最后重构。每一步都要有命令输出。",
	},
];

export type ClientSettings = {
	quickPhrases: string[];
	quickPhrasesEnabled: boolean;
	templates: PromptTemplate[];
	/** 项目偏好（ADR-0028）：显式顺序 / 置顶 / 别名 */
	projectPrefs: ProjectPrefs;
};

export const MAX_PROJECT_PREFS = 500;
export const MAX_ALIAS_CHARS = 40;

/** 纯函数：归一化项目偏好 —— 只保留绝对路径、去重、上限、别名裁剪 */
export function normalizeProjectPrefs(input: unknown): ProjectPrefs {
	const empty: ProjectPrefs = { order: [], pinned: [], aliases: {} };
	if (typeof input !== "object" || input === null) return empty;
	const record = input as Record<string, unknown>;
	const paths = (value: unknown): string[] => {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") continue;
			const path = item.trim();
			if (!path.startsWith("/") || seen.has(path)) continue;
			seen.add(path);
			out.push(path);
			if (out.length >= MAX_PROJECT_PREFS) break;
		}
		return out;
	};
	const aliases: Record<string, string> = {};
	if (typeof record.aliases === "object" && record.aliases !== null) {
		for (const [key, value] of Object.entries(record.aliases as Record<string, unknown>)) {
			if (!key.startsWith("/") || typeof value !== "string") continue;
			const name = value.trim().slice(0, MAX_ALIAS_CHARS);
			if (name !== "") aliases[key] = name;
		}
	}
	return { order: paths(record.order), pinned: paths(record.pinned), aliases };
}

export function defaultSettings(): ClientSettings {
	return {
		quickPhrases: [...DEFAULT_QUICK_PHRASES],
		quickPhrasesEnabled: true,
		templates: DEFAULT_TEMPLATES.map((template) => ({ ...template })),
		projectPrefs: { order: [], pinned: [], aliases: {} },
	};
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

/**
 * 纯函数：规范化模板列表 —— 每项必须像模板，字段裁剪长度、id 去重、条数上限。
 * 顺序保持用户给的原样（用户自己拖过的顺序不该被服务器重排）。
 */
export function normalizeTemplates(input: unknown): PromptTemplate[] {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	const out: PromptTemplate[] = [];
	for (const item of input) {
		if (typeof item !== "object" || item === null) continue;
		const record = item as Record<string, unknown>;
		const name =
			typeof record.name === "string" ? record.name.replace(/\s+/g, " ").trim().slice(0, MAX_TEMPLATE_NAME_CHARS) : "";
		const text = typeof record.text === "string" ? record.text.trim().slice(0, MAX_TEMPLATE_TEXT_CHARS) : "";
		if (name === "" || text === "") continue; // 名字和正文是硬要求
		const id =
			typeof record.id === "string" && record.id.trim() !== "" ? record.id.trim() : `t-${out.length + 1}-${name}`;
		if (seen.has(id)) continue;
		seen.add(id);
		out.push({
			id,
			name,
			description:
				typeof record.description === "string"
					? record.description.replace(/\s+/g, " ").trim().slice(0, MAX_TEMPLATE_DESC_CHARS)
					: "",
			icon: typeof record.icon === "string" ? ([...record.icon][0] ?? "✳️") : "✳️",
			text,
			// 软删除标记：只有明确 true 才带上，缺省即显示
			...(record.hidden === true ? { hidden: true } : {}),
		});
		if (out.length >= MAX_TEMPLATES) break;
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
	// templates 传 null = 「恢复默认模板」（显式手势，不当成坏值忽略）
	if (record.templates === null) next.templates = DEFAULT_TEMPLATES.map((template) => ({ ...template }));
	else if ("templates" in record) next.templates = normalizeTemplates(record.templates);
	if ("projectPrefs" in record) next.projectPrefs = normalizeProjectPrefs(record.projectPrefs);
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

/**
 * 把一次设置改动落到 state + 盘上（runtime 侧的粘合，从 runtime 拆出以守住 400 行护栏）。
 * 写盘失败只回调警告：内存里的设置仍然生效（下次启动才会回到旧值）。
 */
export async function applySettingsPatch(input: {
	state: { settings: ClientSettings };
	store?: SettingsStore;
	patch: unknown;
	onError: (message: string) => void;
}): Promise<ClientSettings> {
	const next = mergeSettings(input.state.settings, input.patch);
	input.state.settings = next;
	try {
		await input.store?.save(next);
	} catch (error) {
		input.onError(`保存设置失败：${error instanceof Error ? error.message : String(error)}`);
	}
	return next;
}
