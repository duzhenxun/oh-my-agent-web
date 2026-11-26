/**
 * 客户端设置（ADR-0020 §P1）：`<dataDir>/settings.json`。
 *
 * 与 ADR-0005 的索引同一套纪律：**原子写、坏文件不致命、可重建**（重建 = 回默认值）。
 * 归一化放在纯函数里（`normalizeQuickPhrases`），因为「用户能贴进来什么」永远想不到 ——
 * 单条超长、重复、空白、几百条，都必须在上盘前收敛。
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join } from "node:path";
import type { AppearanceView, ProjectPrefs, PromptTemplate, QuickPhrase, SessionPrefs } from "../protocol.js";

const SETTINGS_FILE = "settings.json";
const SETTINGS_VERSION = 1;

/** 与 ADR-0020 对齐的上限 */
const MAX_QUICK_PHRASES = 30;
const MAX_QUICK_PHRASE_CHARS = 200;

/**
 * 默认快捷指令：**只有两条**（用户 2026-11-23：「只要 继续、总结一下 默认只有这 2 个就可以」）。
 *
 * 两条都是**双语**存着的（`text` 中文原文 + `textEn` 英文副本）：英文界面下显示 / 发送英文那条，
 * 中文界面用原文。用户自己加/改的短语没有英文副本，两种语言都原样显示 ——
 * 短语是「用户自己的话」，不该被系统偷着翻（文案规则的权威说明见 `QuickPhrase`）。
 */
export const DEFAULT_QUICK_PHRASES: readonly QuickPhrase[] = [
	{ text: "继续", textEn: "Continue" },
	{ text: "总结一下", textEn: "Summarize" },
];

/** 内置短语的「中文原文 → 英文副本」：用来给老 settings.json 里那串纯中文补上第二份 */
const BUILTIN_PHRASE_EN = new Map(DEFAULT_QUICK_PHRASES.map((phrase) => [phrase.text, phrase.textEn ?? ""]));

/**
 * 「想想」参数上下限。
 * 条数上限跟 `MAX_ACTIONS`（5）对齐：再多也只会被截掉，界面就别给出会落空的选择。
 * 超时给到 3 分钟：慢模型 + 长上下文时 20 秒确实会不够。
 */
const MIN_THINK_COUNT = 1;
const MAX_THINK_COUNT = 5;
const DEFAULT_THINK_COUNT = 5;
const MIN_THINK_TIMEOUT_SEC = 5;
const MAX_THINK_TIMEOUT_SEC = 180;
const DEFAULT_THINK_TIMEOUT_SEC = 20;

/**
 * 外观字号的合法区间：与 `web/src/font-scale.ts` 保持一致（2–30px，且**只收双数**）。
 * 界面滑杆步长是 2，这里归一化也走双数 —— 否则手改过的 settings.json 会让滑杆停在两个格之间。
 */
const MIN_FONT_PX = 2;
const MAX_FONT_PX = 30;
/** 三处字号的默认值 = 各自的「标准」档（见 `font-scale.ts`） */
export const DEFAULT_APPEARANCE: AppearanceView = { chatPx: 14, projectPx: 14, sessionPx: 14 };

const MAX_TEMPLATES = 40;
const MAX_TEMPLATE_NAME_CHARS = 24;
const MAX_TEMPLATE_DESC_CHARS = 60;
const MAX_TEMPLATE_TEXT_CHARS = 2000;

/**
 * 默认模板库（P5）：都是「开箱即用、点一下就填进输入框」的工作流提示词。
 * 图标用 emoji，避免为一个图标位引入图标库（依赖预算）。
 */
/**
 * 内置模板的英文副本（第二份）：`id` → 三个字段的英文。
 *
 * 单独一张表、而不是塞回 `DEFAULT_TEMPLATES`：中文原文是**身份**（判定「用户有没有改过」用的），
 * 英文只是显示用的另一份；放两处、用 `id` 对齐，规则一眼能看清（见 `normalizeTemplates`）。
 */
const BUILTIN_TEMPLATE_EN: Record<string, { name: string; description: string; text: string }> = {
	"t-spec": {
		name: "Spec to done",
		description: "Implement test-first from the spec",
		text: "Implement this spec: write the failing tests first, then implement until they pass. If anything in the spec is ambiguous, ask me instead of guessing.",
	},
	"t-review": {
		name: "Code review",
		description: "Review the diff against the spec and conventions",
		text: "Review the current changes: compare them against the spec and the repo's existing conventions, point out behaviour differences, missed edge cases, and code that can be deleted. Order the findings by severity.",
	},
	"t-map": {
		name: "Task map",
		description: "Turn a big project into a decision map",
		text: "Turn this big task into a decision map: first list the choice points that have to be decided now and what each one costs, then give the shortest path to something shippable.",
	},
	"t-proto": {
		name: "Quick prototype",
		description: "Validate a design assumption with throwaway code",
		text: "Validate this design assumption with a throwaway prototype: give the smallest runnable code, the metrics to watch, and a verdict (continue / change the approach).",
	},
	"t-research": {
		name: "Cited research",
		description: "Read primary sources, answer with citations",
		text: "Research this question: read primary sources only (official docs / source code / specs), give conclusions with links, and clearly flag anything you are unsure about.",
	},
	"t-arch": {
		name: "Architecture check-up",
		description: "Find the modules worth refactoring",
		text: "Do an architecture check-up of this project: find modules that are too tightly coupled or carry too many responsibilities, and rank the refactoring suggestions by payoff vs risk.",
	},
	"t-debug": {
		name: "Systematic debugging",
		description: "Start from a failure you can reproduce",
		text: "Debug this systematically: first give me one command that reproduces it reliably, then bisect. Do not guess at causes before you have a reproduction.",
	},
	"t-conflict": {
		name: "Resolve merge conflicts",
		description: "Work through merge/rebase hunk by hunk",
		text: "Resolve the merge conflicts: go hunk by hunk, read the intent on both sides, keep both meanings, run the tests afterwards, and explain every trade-off.",
	},
	"t-ask": {
		name: "Grill the requirement",
		description: "Interrogate the idea before coding",
		text: "Grill me before you start: turn the vague parts of this request into questions (at most 5), each with the default answer you would pick.",
	},
	"t-handoff": {
		name: "Handoff",
		description: "Turn a long session into a handoff doc",
		text: "Turn this session into a handoff document: done / not done / key constraints / the very next step — written for someone with no context at all.",
	},
	"t-plain": {
		name: "Plain words",
		description: "Re-explain that in everyday language",
		text: "Explain that again in plain words: replace the jargon with everyday analogies, at most 10 lines.",
	},
	"t-tdd": {
		name: "Test-driven",
		description: "The red-green-refactor rule",
		text: "Work test-driven: write one failing test and show me it failing, implement until it is green, then refactor. Every step needs command output.",
	},
};

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

/** 内置模板的 id 集合：只有这些 id 才可能带英文副本（用户自建的 `tpl-*` 不带） */
const BUILTIN_TEMPLATE_IDS: ReadonlySet<string> = new Set(DEFAULT_TEMPLATES.map((template) => template.id));

/** 按 id 取内置原文（归一化时要逐格比对「用户改过没有」） */
const BUILTIN_TEMPLATE_BY_ID = new Map(DEFAULT_TEMPLATES.map((template) => [template.id, template]));

type ClientSettings = {
	quickPhrases: QuickPhrase[];
	/**
	 * @deprecated 显隐已改为本机偏好（`agent-web.composer.quick`，见 `web/src/ui-prefs.ts`）：
	 * 手机和桌面要能各设各的，一个服务端开关做不到。这里只为老客户端兼容留着，
	 * 并作为老用户的一次性回落值（`web/src/use-quick-seed.ts`）。别再拿它做显示判断。
	 */
	quickPhrasesEnabled: boolean;
	templates: PromptTemplate[];
	/** 项目偏好（ADR-0028）：显式顺序 / 置顶 / 别名 */
	projectPrefs: ProjectPrefs;
	/** 会话级偏好：置顶 / 重命名 / 归档 */
	sessionPrefs: SessionPrefs;
	/** 每个项目的默认模型（workspace → `provider/model`）：新会话按它起步 */
	defaultModels: Record<string, string>;
	/** 「想想」一次生成几条建议 */
	thinkCount: number;
	/** 「想想」隐藏回合的最大等待（秒） */
	thinkTimeoutSec: number;
	/** 外观字号（ADR-0050）：`null` = 还没人显式设过（走 `set_settings` + 快照回推） */
	appearance: AppearanceView | null;
};

const MAX_DEFAULT_MODELS = 200;

/** 纯函数：归一化「项目默认模型」——只收绝对路径键与非空模型 id，超出上限就截断 */
function normalizeDefaultModels(input: unknown): Record<string, string> {
	const out: Record<string, string> = {};
	if (typeof input !== "object" || input === null) return out;
	for (const [key, value] of Object.entries(input as Record<string, unknown>)) {
		if (!isAbsolute(key)) continue;
		if (typeof value !== "string") continue;
		const modelId = value.trim();
		// 必须是 `provider/model`：只写一半的话服务端没法切
		if (modelId === "" || !modelId.includes("/")) continue;
		out[key] = modelId;
		if (Object.keys(out).length >= MAX_DEFAULT_MODELS) break;
	}
	return out;
}

const MAX_PROJECT_PREFS = 500;
const MAX_ALIAS_CHARS = 40;

/** 纯函数：归一化项目偏好 —— 只保留绝对路径、去重、上限、别名裁剪 */
function normalizeProjectPrefs(input: unknown): ProjectPrefs {
	const empty: ProjectPrefs = { order: [], pinned: [], aliases: {}, hidden: [] };
	if (typeof input !== "object" || input === null) return empty;
	const record = input as Record<string, unknown>;
	const paths = (value: unknown): string[] => {
		if (!Array.isArray(value)) return [];
		const seen = new Set<string>();
		const out: string[] = [];
		for (const item of value) {
			if (typeof item !== "string") continue;
			const path = item.trim();
			if (!isAbsolute(path) || seen.has(path)) continue;
			seen.add(path);
			out.push(path);
			if (out.length >= MAX_PROJECT_PREFS) break;
		}
		return out;
	};
	const aliases: Record<string, string> = {};
	if (typeof record.aliases === "object" && record.aliases !== null) {
		for (const [key, value] of Object.entries(record.aliases as Record<string, unknown>)) {
			if (!isAbsolute(key) || typeof value !== "string") continue;
			const name = value.trim().slice(0, MAX_ALIAS_CHARS);
			if (name !== "") aliases[key] = name;
		}
	}
	return { order: paths(record.order), pinned: paths(record.pinned), aliases, hidden: paths(record.hidden) };
}

/** 纯函数：会话偏好的归一化（只保留非空字符串，上限 2000 条；改名不在这里） */
function normalizeSessionPrefs(input: unknown): SessionPrefs {
	const empty: SessionPrefs = { pinned: [], archived: [], order: [] };
	if (typeof input !== "object" || input === null) return empty;
	const record = input as Record<string, unknown>;
	const ids = (value: unknown): string[] =>
		Array.isArray(value)
			? [...new Set(value.filter((item): item is string => typeof item === "string" && item.trim() !== ""))].slice(
					0,
					2000,
				)
			: [];
	// 旧 settings.json 里可能的 titles 直接忽略（改名的事实源是 pi 的会话文件）
	return { pinned: ids(record.pinned), archived: ids(record.archived), order: ids(record.order) };
}

/**
 * 纯函数：单处字号的归一化 —— 只收有限数字，夹到 2–30 并取**双数**（与界面滑杆同刻度）。
 * 坏值（字符串、NaN、越界）回落到 fallback，不抛错：这是用户能手改的 settings.json。
 */
export function normalizeFontPx(value: unknown, fallback: number): number {
	const raw = typeof value === "number" ? value : typeof value === "string" ? Number(value.trim()) : Number.NaN;
	if (!Number.isFinite(raw)) return fallback;
	const even = Math.round(raw / 2) * 2;
	return Math.min(MAX_FONT_PX, Math.max(MIN_FONT_PX, even));
}

/** 纯函数：外观部分合并（没传的那一处原样保留） */
export function normalizeAppearance(input: unknown, current: AppearanceView = DEFAULT_APPEARANCE): AppearanceView {
	if (typeof input !== "object" || input === null) return { ...current };
	const record = input as Record<string, unknown>;
	const pick = (key: keyof AppearanceView): number =>
		key in record ? normalizeFontPx(record[key], current[key]) : current[key];
	return { chatPx: pick("chatPx"), projectPx: pick("projectPx"), sessionPx: pick("sessionPx") };
}

export function defaultSettings(): ClientSettings {
	return {
		quickPhrases: DEFAULT_QUICK_PHRASES.map((phrase) => ({ ...phrase })),
		quickPhrasesEnabled: true,
		templates: DEFAULT_TEMPLATES.map((template) => ({ ...template })),
		projectPrefs: { order: [], pinned: [], aliases: {}, hidden: [] },
		sessionPrefs: { pinned: [], archived: [], order: [] },
		defaultModels: {},
		thinkCount: DEFAULT_THINK_COUNT,
		thinkTimeoutSec: DEFAULT_THINK_TIMEOUT_SEC,
		appearance: null,
	};
}

/** 单条短语的清洗：折空白、去首尾、裁长度（两个语言版本同一套规则） */
function cleanPhraseText(value: unknown): string {
	if (typeof value !== "string") return "";
	const text = value.replace(/\s+/g, " ").trim();
	return text.length > MAX_QUICK_PHRASE_CHARS ? text.slice(0, MAX_QUICK_PHRASE_CHARS) : text;
}

/**
 * 纯函数：规范化快捷短语列表 —— 去空白、限制单条长度、去重、限制条数。
 * 顺序保持用户给的原样（拖拽排序是后话，见 ADR-0020）。
 *
 * 两种输入都收：
 *   - **纯字符串**（老 settings.json，以及老客户端发上来的 `quickPhrases: string[]`）→ `{ text }`；
 *   - **`{ text, textEn }`**（新形状，见 `QuickPhrase`）。
 *
 * 英文副本的来源按「中文原文是不是还等于内置原文」判：
 *   - 还等于（用户没改过这条）→ 用**内置表里的英文**（跟着代码升级，不是抄旧值）；
 *   - 已经改过 / 用户自己写的 → 只认他自己带回来的 `textEn`，没有就不带
 *     —— 绝不把用户写的句子偷着翻成英文。
 */
export function normalizeQuickPhrases(input: unknown): QuickPhrase[] {
	if (!Array.isArray(input)) return [];
	const seen = new Set<string>();
	const out: QuickPhrase[] = [];
	for (const item of input) {
		const raw = typeof item === "string" ? { text: item } : typeof item === "object" && item !== null ? item : null;
		if (raw === null) continue;
		const record = raw as Record<string, unknown>;
		const text = cleanPhraseText(record.text);
		if (text === "") continue;
		const builtinEn = BUILTIN_PHRASE_EN.get(text);
		const textEn = builtinEn || cleanPhraseText(record.textEn);
		const key = `${text}\u0000${textEn}`;
		if (seen.has(key)) continue;
		seen.add(key);
		out.push(textEn === "" ? { text } : { text, textEn });
		if (out.length >= MAX_QUICK_PHRASES) break;
	}
	return out;
}

/**
 * 纯函数：规范化模板列表 —— 每项必须像模板，字段裁剪长度、id 去重、条数上限。
 * 顺序保持用户给的原样（用户自己拖过的顺序不该被服务器重排）。
 *
 * **英文副本（第二份）在这里补**，规则一句话：
 *   - 内置 id + 中文原文还等于内置原文 → 用内置表的英文（用户没动过这一格）；
 *   - 别的情况（改过、或自建模板）→ 只认客户端自己带上来的 `*En`，没有就不带。
 *
 * 这样老 settings.json 里那批纯中文默认模板一升级就能在英文界面显示英文，
 * 而用户改过的模板不会被塞一份对不上的过时译文。
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
		const description =
			typeof record.description === "string"
				? record.description.replace(/\s+/g, " ").trim().slice(0, MAX_TEMPLATE_DESC_CHARS)
				: "";
		const builtin = BUILTIN_TEMPLATE_BY_ID.get(id);
		const builtinEn = BUILTIN_TEMPLATE_IDS.has(id) ? BUILTIN_TEMPLATE_EN[id] : undefined;
		/** 某一格的英文：中文原文没动过就用内置那份，否则用客户端带回来的 */
		const englishOf = (field: "name" | "description" | "text", value: string, limit: number): string | undefined => {
			if (builtin && builtinEn && value === builtin[field]) return builtinEn[field];
			const provided = typeof record[`${field}En`] === "string" ? (record[`${field}En`] as string) : "";
			const clipped = provided.replace(/\s+/g, " ").trim().slice(0, limit);
			return clipped === "" ? undefined : clipped;
		};
		const nameEn = englishOf("name", name, MAX_TEMPLATE_NAME_CHARS);
		const descriptionEn = englishOf("description", description, MAX_TEMPLATE_DESC_CHARS);
		const textEn = englishOf("text", text, MAX_TEMPLATE_TEXT_CHARS);
		out.push({
			id,
			name,
			description,
			icon: typeof record.icon === "string" ? ([...record.icon][0] ?? "✳️") : "✳️",
			text,
			// 软删除标记：只有明确 true 才带上，缺省即显示
			...(record.hidden === true ? { hidden: true } : {}),
			...(nameEn ? { nameEn } : {}),
			...(descriptionEn ? { descriptionEn } : {}),
			...(textEn ? { textEn } : {}),
		});
		if (out.length >= MAX_TEMPLATES) break;
	}
	return out;
}

/** 纯函数：把一个数字收敛到 [min, max]；不是有限数就用默认值（坏值不抛） */
function normalizeInt(input: unknown, min: number, max: number, fallback: number): number {
	const value = typeof input === "number" ? input : typeof input === "string" ? Number(input.trim()) : Number.NaN;
	if (!Number.isFinite(value)) return fallback;
	return Math.min(max, Math.max(min, Math.round(value)));
}

/** 纯函数：把外来的部分设置合并进现有设置（坏值一律忽略，不抛） */
function mergeSettings(current: ClientSettings, patch: unknown): ClientSettings {
	if (typeof patch !== "object" || patch === null) return current;
	const record = patch as Record<string, unknown>;
	const next: ClientSettings = { ...current };
	if ("quickPhrases" in record) next.quickPhrases = normalizeQuickPhrases(record.quickPhrases);
	if (typeof record.quickPhrasesEnabled === "boolean") next.quickPhrasesEnabled = record.quickPhrasesEnabled;
	// templates 传 null = 「恢复默认模板」（显式手势，不当成坏值忽略）
	if (record.templates === null) next.templates = DEFAULT_TEMPLATES.map((template) => ({ ...template }));
	else if ("templates" in record) next.templates = normalizeTemplates(record.templates);
	if ("projectPrefs" in record) next.projectPrefs = normalizeProjectPrefs(record.projectPrefs);
	if ("sessionPrefs" in record) next.sessionPrefs = normalizeSessionPrefs(record.sessionPrefs);
	if ("defaultModels" in record) next.defaultModels = normalizeDefaultModels(record.defaultModels);
	if ("thinkCount" in record)
		next.thinkCount = normalizeInt(record.thinkCount, MIN_THINK_COUNT, MAX_THINK_COUNT, DEFAULT_THINK_COUNT);
	if ("thinkTimeoutSec" in record)
		next.thinkTimeoutSec = normalizeInt(
			record.thinkTimeoutSec,
			MIN_THINK_TIMEOUT_SEC,
			MAX_THINK_TIMEOUT_SEC,
			DEFAULT_THINK_TIMEOUT_SEC,
		);
	// 外观：只传一处也算合法（agent 说「对话文字大一点」时不会把侧栏一起带上）
	// null = 回到「没设过」（浏览器继续用本机那份）；对象 = 部分合并
	if ("appearance" in record)
		next.appearance =
			record.appearance === null
				? null
				: normalizeAppearance(record.appearance, current.appearance ?? DEFAULT_APPEARANCE);
	return next;
}

/** 纯函数：解析设置文件；坏内容/缺字段回默认值 */
function parseSettings(text: string): ClientSettings {
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

/**
 * 同步读设置（缺文件/坏文件 → 默认值，与 `createFileSettingsStore().load()` 同口径）。
 *
 * 只给「进程启动时就要定型」的场景用（目前只有一处：dsh 的 system prompt patch）。
 * 平时请走异步的 SettingsStore —— 这里每调一次就读一次盘。
 */
export function readSettingsSync(dataDir: string): ClientSettings {
	try {
		return parseSettings(readFileSync(settingsPath(dataDir), "utf8"));
	} catch {
		return defaultSettings();
	}
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
