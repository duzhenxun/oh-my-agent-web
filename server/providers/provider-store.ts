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
import { maskKey, type ProviderInput } from "./validate.js";

export const MODELS_STORE_FILE = "models-store.json";
export const AUTH_FILE = "auth.json";

type ModelDefinition = {
	id: string;
	name?: string;
	api?: string;
	baseUrl?: string;
	provider?: string;
	contextWindow?: number;
	[key: string]: unknown;
};
type ModelsStore = Record<string, { models?: ModelDefinition[]; lastModified?: number; [key: string]: unknown }>;
type AuthStore = Record<string, { type?: string; key?: string; [key: string]: unknown }>;

export type ProviderStore = {
	/** 已配置的 provider（不含明文 key） */
	list: () => Promise<ProviderView[]>;
	/** 新增或覆盖一个 provider 的模型表（apiKey 缺省 = 不动已有 key） */
	upsert: (input: ProviderInput) => Promise<{ ok: true; view: ProviderView } | { ok: false; error: string }>;
	/** 删掉一个 provider（模型表 + 凭证一起删，B 期；调用方必须先二次确认） */
	remove: (provider: string) => Promise<{ ok: true; removed: boolean } | { ok: false; error: string }>;
	/** 取单个 provider（编辑表单用；同样不含明文 key） */
	get: (provider: string) => Promise<ProviderView | null>;
	/**
	 * 读明文 key —— **只给服务端内部用**（例如连通性测试发请求）。
	 * 绝不能挂到任何返回给前端的路径上；协议里没有、也不会有对应字段。
	 */
	readKey: (provider: string) => Promise<string | null>;
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

export function createProviderStore(options: { agentDir: string; now: () => number }): ProviderStore {
	const modelsPath = join(options.agentDir, MODELS_STORE_FILE);
	const authPath = join(options.agentDir, AUTH_FILE);

	return {
		async list() {
			const [models, auth] = await Promise.all([
				readJson<ModelsStore>(modelsPath, {}),
				readJson<AuthStore>(authPath, {}),
			]);
			return Object.entries(models).map(([provider, entry]) => {
				const list = Array.isArray(entry.models) ? entry.models : [];
				const key = auth[provider]?.key;
				return {
					provider,
					baseUrl: list.find((model) => typeof model.baseUrl === "string")?.baseUrl ?? "",
					api: list.find((model) => typeof model.api === "string")?.api ?? "",
					hasKey: typeof key === "string" && key !== "",
					keyHint: maskKey(typeof key === "string" ? key : undefined),
					models: list.map((model) => ({ id: model.id, name: model.name ?? model.id })),
				};
			});
		},

		async readKey(provider) {
			const auth = await readJson<AuthStore>(authPath, {});
			const key = auth[provider]?.key;
			return typeof key === "string" && key !== "" ? key : null;
		},

		async get(provider) {
			const all = await this.list();
			return all.find((view) => view.provider === provider) ?? null;
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
					baseUrl: input.baseUrl,
					api: input.api,
					hasKey: typeof key === "string" && key !== "",
					keyHint: maskKey(typeof key === "string" ? key : undefined),
					models: nextModels.map((model) => ({ id: model.id, name: model.name ?? model.id })),
				},
			};
		},
	};
}
