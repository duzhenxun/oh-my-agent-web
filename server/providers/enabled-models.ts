/**
 * 「启用了哪些模型」（ADR-0025 的姊妹：仍然只写 pi 自己的 settings.json）。
 *
 * pi 的 `enabledModels` 是一串 **allowlist 模式**：
 *   `nexita-anthropic/**`        这个 provider 下全部
 *   `openai-codex/gpt-6-luna`    单个模型
 * 没有这一项（或空数组）= 不限制（全部可用）。语义由 pi 自己实现，我们只负责正确改写它。
 *
 * 两个方向都要小心：
 *   - 关掉某个 provider：要把它下面所有单模型条目一起删，否则会「关不干净」；
 *   - 关掉某个模型、但它的 provider 是 `/**` 全开时：必须先把 `/**` **展开成逐个模型**，
 *     再去掉这一个 —— 否则那个 `/**` 仍然会把它匹配上。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

export const PI_SETTINGS_FILE = "settings.json";

export type EnabledPatterns = string[];

/** 纯函数：某个模型是否被启用（没有 allowlist = 全开） */
export function isModelEnabled(patterns: EnabledPatterns, provider: string, modelId: string): boolean {
	if (patterns.length === 0) return true;
	const full = `${provider}/${modelId}`;
	return patterns.some((pattern) => matches(pattern, provider, full));
}

/** 纯函数：某个 provider 是否整体启用（有 `provider/**` 或至少一个单模型条目） */
export function isProviderEnabled(patterns: EnabledPatterns, provider: string): boolean {
	if (patterns.length === 0) return true;
	return patterns.some((pattern) => pattern === `${provider}/**` || pattern.startsWith(`${provider}/`));
}

/** 支持两种写法：`provider/**` 与精确的 `provider/model` */
function matches(pattern: string, provider: string, full: string): boolean {
	if (pattern === `${provider}/**`) return true;
	return pattern === full;
}

/**
 * 纯函数：整体开关一个 provider。
 *
 * 关键在「全开状态下停用一个」：白名单为空时删条目等于没删，
 * 必须**展开**成「除它以外所有 provider 的所有模型」—— 否则点了停用毫无效果。
 * `universe` 就是为此传进来的全量模型清单。
 */
export function toggleProvider(
	patterns: EnabledPatterns,
	provider: string,
	models: string[],
	enabled: boolean,
	universe: { provider: string; models: string[] }[] = [],
): EnabledPatterns {
	if (patterns.length === 0) {
		if (enabled) return patterns; // 已经全开
		return universe
			.filter((item) => item.provider !== provider)
			.flatMap((item) => item.models.map((id) => `${item.provider}/${id}`))
			.sort();
	}
	const others = patterns.filter((pattern) => !(pattern === `${provider}/**` || pattern.startsWith(`${provider}/`)));
	if (!enabled) return others;
	return [`${provider}/**`, ...others].sort();
}

/** 纯函数：开关单个模型（必要时把 `provider/**` 展开） */
export function toggleModel(
	patterns: EnabledPatterns,
	provider: string,
	models: string[],
	modelId: string,
	enabled: boolean,
): EnabledPatterns {
	if (patterns.length === 0) {
		// 全开状态下关一个：必须展开成「除它以外的所有模型」
		if (enabled) return patterns;
		return models
			.filter((id) => id !== modelId)
			.map((id) => `${provider}/${id}`)
			.sort();
	}
	const allOn = patterns.includes(`${provider}/**`);
	const full = `${provider}/${modelId}`;
	if (enabled) {
		if (allOn || patterns.includes(full)) return patterns;
		return [...patterns, full].sort();
	}
	if (allOn) {
		// 展开：其余模型逐个列出
		const rest = models.filter((id) => id !== modelId).map((id) => `${provider}/${id}`);
		const others = patterns.filter((pattern) => pattern !== `${provider}/**`);
		return [...others, ...rest].sort();
	}
	return patterns.filter((pattern) => pattern !== full);
}

/** 纯函数：「启用全部」= 清空 allowlist（pi 的语义：没有白名单 = 不限制） */
export function enableAll(): EnabledPatterns {
	return [];
}

export type EnabledStore = {
	read: () => Promise<EnabledPatterns>;
	write: (patterns: EnabledPatterns) => Promise<void>;
};

/** 读写 pi 的 settings.json；只碰 `enabledModels` 这一个键，其它原样保留 */
export function createEnabledStore(options: { agentDir: string }): EnabledStore {
	const path = join(options.agentDir, PI_SETTINGS_FILE);

	const readAll = async (): Promise<Record<string, unknown>> => {
		try {
			const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
			return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
		} catch {
			return {};
		}
	};

	return {
		async read() {
			const all = await readAll();
			const value = all.enabledModels;
			return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
		},
		async write(patterns) {
			const all = await readAll();
			all.enabledModels = patterns;
			await mkdir(dirname(path), { recursive: true });
			const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
			await writeFile(temporary, `${JSON.stringify(all, null, 2)}\n`, { mode: 0o600 });
			await rename(temporary, path);
			await chmod(path, 0o600);
		},
	};
}
