/**
 * provider 配置的读写（ADR-0025 §1）：**复用 pi 自己的两个文件**，不另存一份 key。
 *
 *   ~/.pi/agent/models-store.json   { [provider]: { models: ModelDefinition[], lastModified } }
 *   ~/.pi/agent/auth.json           { [provider]: { type, key } }
 *
 * 两条纪律：
 *   - 原子写（临时文件 + rename）且强制 0600 —— 这两个文件里可能有凭证；
 *   - **key 不出服务端**：对外只给 `hasKey` + 尾 4 位（ADR-0025 §2）。
 */
import { chmod, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderView } from "../protocol.js";
import { maskKey, type ModelSpec, type ProviderInput } from "./validate.js";

export const MODELS_STORE_FILE = "models-store.json";
export const AUTH_FILE = "auth.json";

type ModelDefinition = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	provider?: string;
	contextWindow?: number;
	headers?: Record<string, string>;
	[key: string]: unknown;
};
type ModelsStore = Record<string, { models?: ModelDefinition[]; lastModified?: number; [key: string]: unknown }>;
type AuthStore = Record<string, { type?: string; key?: string; [key: string]: unknown }>;

/**
 * 把内置 provider「落成自定义条目」时用的种子（pi 的目录里本来就有这些模型）。
 * 只有整表照抄，才不会因为覆盖而丢掉内置的其它模型。
 */
export type ProviderSeed = { baseUrl: string; api: string; models: { id: string; name: string }[] };

/** 引擎报上来的内置 provider（pi 自己的目录，不在 models-store.json 里） */
export type BuiltinProvider = {
	provider: string;
	models: { id: string; name: string }[];
	baseUrl?: string;
	api?: string;
};

export type ProviderStore = {
	/**
	 * 已配置的 provider（不含明文 key）。
	 * `builtin` 传引擎报上来的内置 provider：合并展示，标成 source=builtin（只读）。
	 */
	list: (builtin?: BuiltinProvider[]) => Promise<ProviderView[]>;
	/** 新增或覆盖一个 provider 的模型表（apiKey 缺省 = 不动已有 key） */
	upsert: (input: ProviderInput) => Promise<{ ok: true; view: ProviderView } | { ok: false; error: string }>;
	/** 删掉一个 provider（模型表 + 凭证一起删，B 期；调用方必须先二次确认） */
	remove: (provider: string) => Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>;
	/** 取单个 provider（编辑表单用；同样不含明文 key） */
	get: (provider: string) => Promise<ProviderView | null>;
	/**
	 * 写回单个模型的规格（ADR-0026 A 期）：能力 / 上下文窗口 / 最大输出 / 价格。
	 * 只覆盖这几个字段，其余（compat / headers 等）原样保留。
	 */
	updateModel: (
		provider: string,
		spec: ModelSpec,
		seed?: ProviderSeed,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	/**
	 * 批量导入模型（ADR-0026 B 期）：只追加**不存在**的 id，已有的跳过（不覆盖用户填过的规格）。
	 * api / baseUrl 沿用该 provider 现有条目；一个都没有时要求调用方先做一次 provider 级保存。
	 */
	addModels: (
		provider: string,
		ids: string[],
	) => Promise<{ ok: true; added: string[]; skipped: string[] } | { ok: false; error: string }>;
	/** 从 provider 下移除一个模型（模型表里的条目，不动凭证） */
	removeModel: (
		provider: string,
		modelId: string,
		seed?: ProviderSeed,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	/**
	 * 读明文 key —— **只给服务端内部用**（例如连通性测试发请求）。
	 * 绝不能挂到任何返回给前端的路径上；协议里没有、也不会有对应字段。
	 */
	readKey: (provider: string) => Promise<string | null>;
	readHeaders: (provider: string) => Promise<Record<string, string>>;
};

async function readJson<T>(path: string, fallback: T): Promise<T> {
	try {
		const text = await readFile(path, "utf8");
		const parsed: unknown = JSON.parse(text);
		return typeof parsed === "object" && parsed !== null ? (parsed as T) : fallback;
	} catch {
		// 文件不存在 / 坏文件都不致命：按空表处理（与 ADR-0005 的「可重建」一致）
		return fallback;
	}
}

/** 原子写 + 0600：凭证文件不能出现「半写」也不能是 world-readable */
async function writeJsonPrivate(path: string, value: unknown): Promise<void> {
	await mkdir(dirname(path), { recursive: true });
	const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmod(path, 0o600);
}

/** 内置 provider → 可写条目（整表照抄，避免覆盖时丢掉别的模型） */
function materialize(provider: string, seed?: ProviderSeed): { models: ModelDefinition[] } | null {
	if (!seed || seed.models.length === 0) return null;
	return {
		models: seed.models.map((model) => ({
			id: model.id,
			name: model.name,
			api: seed.api,
			baseUrl: seed.baseUrl,
			provider,
		})),
	};
}

export function createProviderStore(options: { agentDir: string; now: () => number }): ProviderStore {
	const modelsPath = join(options.agentDir, MODELS_STORE_FILE);
	const authPath = join(options.agentDir, AUTH_FILE);

	return {
		async list(builtin = []) {
			const [models, auth] = await Promise.all([
				readJson<ModelsStore>(modelsPath, {}),
				readJson<AuthStore>(authPath, {}),
			]);
			const custom = Object.entries(models).map(([provider, entry]) => {
				const list = Array.isArray(entry.models) ? entry.models : [];
				const key = auth[provider]?.key;
				const headers = list.find((model) => model.headers)?.headers;
				return {
					provider,
					source: "custom" as const,
					baseUrl: list.find((model) => typeof model.baseUrl === "string")?.baseUrl ?? "",
					api: list.find((model) => typeof model.api === "string")?.api ?? "",
					hasKey: typeof key === "string" && key !== "",
					keyHint: maskKey(typeof key === "string" ? key : undefined),
					...(headers ? { headerNames: Object.keys(headers) } : {}),
					models: list.map((model) => ({
						id: model.id,
						name: model.name ?? model.id,
						reasoning: model.reasoning === true,
						imageInput: Array.isArray(model.input) && model.input.includes("image"),
						...(typeof model.contextWindow === "number" ? { contextWindow: model.contextWindow } : {}),
						...(typeof model.maxTokens === "number" ? { maxTokens: model.maxTokens } : {}),
						...(model.cost ? { cost: model.cost as Record<string, number> } : {}),
					})),
				};
			});
			// 内置 provider（nexita / nexita-anthropic …）：pi 的目录里，models-store 里没有它们
			const known = new Set(custom.map((view) => view.provider));
			const builtinViews: ProviderView[] = builtin
				.filter((item) => !known.has(item.provider))
				.map((item) => {
					const key = auth[item.provider]?.key;
					return {
						provider: item.provider,
						source: "builtin" as const,
						baseUrl: item.baseUrl ?? "",
						api: item.api ?? "",
						hasKey: typeof key === "string" && key !== "",
						keyHint: maskKey(typeof key === "string" ? key : undefined),
						models: item.models,
					};
				});
			return [...custom, ...builtinViews];
		},

		async readKey(provider) {
			const auth = await readJson<AuthStore>(authPath, {});
			const key = auth[provider]?.key;
			return typeof key === "string" && key !== "" ? key : null;
		},

		async removeModel(provider, modelId, seed) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			const entry = models[provider] ?? materialize(provider, seed);
			if (!entry) return { ok: false, error: `没有这个 provider：${provider}` };
			const list = Array.isArray(entry.models) ? entry.models : [];
			const next = list.filter((model) => model.id !== modelId);
			if (next.length === list.length) return { ok: false, error: `这个 provider 下没有模型：${modelId}` };
			models[provider] = { ...entry, models: next, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);
			return { ok: true };
		},

		async readHeaders(provider) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			const headers = models[provider]?.models?.find((model) => model.headers)?.headers;
			return headers ? { ...headers } : {};
		},

		async get(provider) {
			const all = await this.list();
			return all.find((view) => view.provider === provider) ?? null;
		},

		async updateModel(provider, spec, seed) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			const entry = models[provider] ?? materialize(provider, seed);
			if (!entry) return { ok: false, error: `没有这个 provider：${provider}` };
			const list = Array.isArray(entry.models) ? entry.models : [];
			const index = list.findIndex((model) => model.id === spec.id);
			if (index < 0) return { ok: false, error: `这个 provider 下没有模型：${spec.id}` };
			const current = list[index] ?? { id: spec.id };
			const next: ModelDefinition = {
				...current,
				id: spec.id,
				name: spec.name,
				...(spec.reasoning ? { reasoning: true } : { reasoning: false }),
				input: spec.imageInput ? ["text", "image"] : ["text"],
				...(spec.contextWindow !== null ? { contextWindow: spec.contextWindow } : {}),
				...(spec.maxTokens !== null ? { maxTokens: spec.maxTokens } : {}),
				...(spec.cost ? { cost: spec.cost } : {}),
			};
			if (spec.contextWindow === null) delete next.contextWindow;
			if (spec.maxTokens === null) delete next.maxTokens;
			if (!spec.cost) delete next.cost;
			const models2 = [...list];
			models2[index] = next;
			models[provider] = { ...entry, models: models2, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);
			return { ok: true };
		},

		async addModels(provider, ids) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			const entry = models[provider];
			if (!entry) return { ok: false, error: `没有这个 provider：${provider}` };
			const list = Array.isArray(entry.models) ? entry.models : [];
			const template = list.find((model) => typeof model.api === "string" && typeof model.baseUrl === "string");
			if (!template)
				return { ok: false, error: "这个 provider 还没有可参考的 api / baseUrl（先保存一次 provider 配置）" };
			const existing = new Set(list.map((model) => model.id));
			const added: string[] = [];
			const skipped: string[] = [];
			const nextList = [...list];
			for (const id of ids) {
				if (existing.has(id)) {
					skipped.push(id);
					continue;
				}
				existing.add(id);
				added.push(id);
				nextList.push({
					id,
					name: id,
					api: template.api,
					baseUrl: template.baseUrl,
					provider,
					...(template.headers ? { headers: template.headers } : {}),
				});
			}
			if (added.length === 0) return { ok: true, added, skipped };
			models[provider] = { ...entry, models: nextList, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);
			return { ok: true, added, skipped };
		},

		async remove(provider) {
			if (!/^[a-z0-9][a-z0-9-]{1,30}$/.test(provider)) return { ok: false, error: "provider 名字不合法" };
			const models = await readJson<ModelsStore>(modelsPath, {});
			const auth = await readJson<AuthStore>(authPath, {});
			const existed = provider in models || provider in auth;
			if (!existed) return { ok: true, removed: false };
			delete models[provider];
			delete auth[provider];
			await writeJsonPrivate(modelsPath, models);
			await writeJsonPrivate(authPath, auth);
			return { ok: true, removed: true };
		},

		async upsert(input) {
			const [models, auth] = await Promise.all([
				readJson<ModelsStore>(modelsPath, {}),
				readJson<AuthStore>(authPath, {}),
			]);
			const existing = models[input.provider];
			if (!existing && input.apiKey === undefined && auth[input.provider]?.key === undefined) {
				return { ok: false, error: "新增 provider 必须填 api key（否则模型调不通）" };
			}

			// 模型表：保留原有其它字段（成本、compat 等），只覆盖我们管的四项
			const previous = new Map((existing?.models ?? []).map((model) => [model.id, model]));
			const nextModels: ModelDefinition[] = input.models.map((model) => {
				const base: ModelDefinition = previous.get(model.id) ?? { id: model.id };
				return {
					...base,
					id: model.id,
					name: model.name ?? base.name ?? model.id,
					api: input.api,
					baseUrl: input.baseUrl,
					provider: input.provider,
					...(input.headers ? { headers: input.headers } : base.headers ? { headers: base.headers } : {}),
					...(model.contextWindow ? { contextWindow: model.contextWindow } : {}),
				};
			});
			// 原有但这次没提到的模型保留，避免"只是加了一个模型却把别的删了"
			for (const [id, model] of previous) if (!nextModels.some((item) => item.id === id)) nextModels.push(model);

			models[input.provider] = { ...existing, models: nextModels, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);

			if (input.apiKey !== undefined) {
				auth[input.provider] = {
					...auth[input.provider],
					type: auth[input.provider]?.type ?? "api_key",
					key: input.apiKey,
				};
				await writeJsonPrivate(authPath, auth);
			}

			const key = auth[input.provider]?.key;
			return {
				ok: true,
				view: {
					provider: input.provider,
					source: "custom" as const,
					baseUrl: input.baseUrl,
					api: input.api,
					hasKey: typeof key === "string" && key !== "",
					keyHint: maskKey(typeof key === "string" ? key : undefined),
					...(input.headers ? { headerNames: Object.keys(input.headers) } : {}),
					models: nextModels.map((model) => ({ id: model.id, name: model.name ?? model.id })),
				},
			};
		},
	};
}
