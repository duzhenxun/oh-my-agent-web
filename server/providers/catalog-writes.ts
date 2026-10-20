/**
 * 把「目录里的 provider」写回 models.json（nexita / nexita-anthropic 这类）。
 * 单独放一个文件：provider-store 已经接近 400 行护栏，而这块逻辑是自成一体的。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { patchCatalogModel, readCatalog, specToCatalog, writeCatalog, type CatalogEntry } from "./catalog-store.js";

async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		return JSON.parse(await readFile(path, "utf8")) as T;
	} catch {
		return fallback;
	}
}
import type { ModelSpec, ProviderInput } from "./validate.js";

export async function writeCatalogUpsert(
	agentDir: string,
	input: ProviderInput,
): Promise<{ models: unknown[]; entry: CatalogEntry }> {
	const catalog = await readCatalog(agentDir);
	const entry = catalog.providers?.[input.provider] ?? {};
	const previous = new Map((entry.models ?? []).map((model) => [model.id, model]));
	const models = input.models.map((model) => ({
		...(previous.get(model.id) ?? { id: model.id }),
		id: model.id,
		name: model.name ?? previous.get(model.id)?.name ?? model.id,
		...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
	}));
	const next: CatalogEntry = {
		...entry,
		api: input.api,
		baseUrl: input.baseUrl,
		...(input.apiKey !== undefined ? { apiKey: input.apiKey } : {}),
		...(input.headers ? { headers: input.headers } : {}),
		models,
	};
	catalog.providers = { ...catalog.providers, [input.provider]: next };
	await writeCatalog(agentDir, catalog);
	return { models, entry: next };
}

export async function writeCatalogModelPatch(
	agentDir: string,
	provider: string,
	modelId: string,
	spec: ModelSpec | null,
): Promise<boolean> {
	const catalog = await readCatalog(agentDir);
	const entry = catalog.providers?.[provider];
	if (!entry) return false;
	catalog.providers = {
		...catalog.providers,
		[provider]: patchCatalogModel(entry, modelId, (current) =>
			spec === null ? null : { ...current, ...specToCatalog(spec) },
		),
	};
	await writeCatalog(agentDir, catalog);
	return true;
}

/** 往目录里的 provider 追加模型：只加不存在的 id，已有的跳过（不覆盖用户填过的规格） */
export async function addCatalogModels(
	agentDir: string,
	provider: string,
	ids: string[],
): Promise<{ ok: true; added: string[]; skipped: string[] } | { ok: false; error: string }> {
	const catalog = await readCatalog(agentDir);
	const entry = catalog.providers?.[provider];
	if (!entry) return { ok: false, error: `没有这个 provider：${provider}` };
	const list = entry.models ?? [];
	const existing = new Set(list.map((model) => model.id));
	const added: string[] = [];
	const skipped: string[] = [];
	const next = [...list];
	for (const id of ids) {
		if (existing.has(id)) {
			skipped.push(id);
			continue;
		}
		existing.add(id);
		added.push(id);
		next.push({ id, name: id });
	}
	if (added.length > 0) {
		catalog.providers = { ...catalog.providers, [provider]: { ...entry, models: next } };
		await writeCatalog(agentDir, catalog);
	}
	return { ok: true, added, skipped };
}

/** 从 models.json 里整条删掉一个 provider（连带它的 key） */
export async function removeFromCatalog(agentDir: string, provider: string): Promise<boolean> {
	const catalog = await readCatalog(agentDir);
	if (!catalog.providers?.[provider]) return false;
	const next = { ...catalog.providers };
	delete next[provider];
	catalog.providers = next;
	await writeCatalog(agentDir, catalog);
	return true;
}

/**
 * 把 models-store.json 里的老 provider 补一份到 models.json。
 *
 * 为什么：pi 的 CLI 只认 models.json（providers 段）里的配置；
 * 早期我们按 ADR-0025 把用户配的 provider 写进了 models-store.json，
 * 结果「本应用能用、pi CLI 里却没有」。这里做一次幂等补齐（**不删**原文件，失败也安全）。
 */
export async function migrateStoreToCatalog(agentDir: string): Promise<string[]> {
	const [catalog, store, auth] = await Promise.all([
		readCatalog(agentDir),
		readJson<Record<string, { models?: Record<string, unknown>[] }>>(join(agentDir, "models-store.json"), {}),
		readJson<Record<string, { key?: string }>>(join(agentDir, "auth.json"), {}),
	]);
	const providers = { ...catalog.providers };
	const migrated: string[] = [];
	for (const [id, entry] of Object.entries(store)) {
		if (providers[id]) continue; // 已经在目录里，不动
		const models = Array.isArray(entry.models) ? entry.models : [];
		const template = models.find((model) => model.api && model.baseUrl) as Record<string, unknown> | undefined;
		if (!template) continue; // 没有可用端点，补过去也是坏的
		providers[id] = {
			api: template.api as string,
			baseUrl: template.baseUrl as string,
			...(auth[id]?.key ? { apiKey: auth[id].key } : {}),
			...(template.headers ? { headers: template.headers as Record<string, string> } : {}),
			models: models.map((model) => ({
				...model,
				api: (model.api ?? template.api) as string,
			})) as unknown as CatalogEntry["models"],
		};
		migrated.push(id);
	}
	if (migrated.length > 0) {
		catalog.providers = providers;
		await writeCatalog(agentDir, catalog);
	}
	return migrated;
}
