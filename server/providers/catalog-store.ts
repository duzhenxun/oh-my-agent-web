/**
 * pi 的 provider 目录（`~/.pi/agent/models.json`）—— nexita / nexita-anthropic 这类就住在这里。
 *
 * 之前我们只「读」它，界面上把这类 provider 标成「只读，改这里会写坏 pi 的目录」。
 * 但用户说得对：**能改，改的就是 pi 的配置**，只是要按 pi 的格式正确地写。
 * 参照 pi 文档（docs/models.md）的字段：
 *
 *   { "providers": { "<provider>": {
 *       "api": "anthropic-messages" | "openai-completions" | …,
 *       "baseUrl": "https://…",
 *       "apiKey": "sk-…" | "ENV_VAR" | "!command",
 *       "headers": { … },
 *       "models": [{ id, name, reasoning, input: ["text","image"], contextWindow, maxTokens, cost }]
 *   } } }
 *
 * 纪律与 models-store.json 相同：原子写 + 0600（里面有明文 key），且**只动目标 provider**。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { PriceSegment } from "../util/pricing.js";

export const MODELS_FILE = "models.json";

export type CatalogModel = {
	id: string;
	name?: string;
	reasoning?: boolean;
	input?: string[];
	contextWindow?: number;
	maxTokens?: number;
	cost?: Record<string, number>;
	/** 分时价格（ADR-0026 D 期）：我们自己的扩展字段，pi 不认、也不会用 */
	costSchedule?: PriceSegment[];
	headers?: Record<string, string>;
	[key: string]: unknown;
};

export type CatalogEntry = {
	api?: string;
	baseUrl?: string;
	apiKey?: string;
	headers?: Record<string, string>;
	models?: CatalogModel[];
	[key: string]: unknown;
};

export type Catalog = { providers?: Record<string, CatalogEntry>; [key: string]: unknown };

export async function readCatalog(agentDir: string): Promise<Catalog> {
	try {
		const parsed: unknown = JSON.parse(await readFile(join(agentDir, MODELS_FILE), "utf8"));
		return typeof parsed === "object" && parsed !== null ? (parsed as Catalog) : {};
	} catch {
		// 不存在 / 坏文件都按空表处理（与其它配置一致：可重建）
		return {};
	}
}

/** 原子写 + 0600：目录文件里有明文 key */
export async function writeCatalog(agentDir: string, catalog: Catalog): Promise<void> {
	const path = join(agentDir, MODELS_FILE);
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(catalog, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

/** 纯函数：改一个模型（不存在就追加）；返回新 entry，不改入参 */
export function patchCatalogModel(
	entry: CatalogEntry,
	modelId: string,
	patch: (current: CatalogModel) => CatalogModel | null,
): CatalogEntry {
	const models = Array.isArray(entry.models) ? entry.models : [];
	const index = models.findIndex((model) => model.id === modelId);
	const current = index >= 0 ? (models[index] as CatalogModel) : ({ id: modelId } as CatalogModel);
	const next = patch(current);
	if (next === null) {
		if (index < 0) return entry;
		return { ...entry, models: models.filter((model) => model.id !== modelId) };
	}
	const list = [...models];
	if (index >= 0) list[index] = next;
	else list.push(next);
	return { ...entry, models: list };
}

/** 界面表单（ModelSpec 形状）→ pi 目录里的模型字段 */
export function specToCatalog(spec: {
	name: string;
	reasoning: boolean;
	imageInput: boolean;
	contextWindow: number | null;
	maxTokens: number | null;
	cost: Record<string, number> | null;
	/** 分时价格（ADR-0026 D 期）：写进模型条目，pi 不认这个字段 → 只当我们的扩展 */
	costSchedule?: PriceSegment[] | null;
}) {
	return {
		name: spec.name,
		reasoning: spec.reasoning,
		input: spec.imageInput ? ["text", "image"] : ["text"],
		...(spec.contextWindow !== null ? { contextWindow: spec.contextWindow } : {}),
		...(spec.maxTokens !== null ? { maxTokens: spec.maxTokens } : {}),
		...(spec.cost ? { cost: spec.cost } : {}),
		...(spec.costSchedule && spec.costSchedule.length > 0 ? { costSchedule: spec.costSchedule } : {}),
	};
}

/** pi 目录条目里的模型 → 界面用的规格视图（没配过就缺省，不编造 0） */
/** ModelDefinition → 界面用的规格视图（没配过就缺省，不编造 0） */
export function specView(model: CatalogModel) {
	return {
		id: model.id,
		name: model.name ?? model.id,
		reasoning: model.reasoning === true,
		imageInput: Array.isArray(model.input) && model.input.includes("image"),
		...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
		...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
		...(model.cost ? { cost: model.cost as Record<string, number> } : {}),
		...(Array.isArray(model.costSchedule) && model.costSchedule.length > 0
			? { costSchedule: model.costSchedule as PriceSegment[] }
			: {}),
	};
}
