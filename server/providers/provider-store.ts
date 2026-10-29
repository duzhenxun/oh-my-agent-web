/**
 * provider 配置的读写（ADR-0025 §1）：**复用 pi 自己的两个文件**，不另存一份 key。
 *
 *
 * 纪律：原子写 + 0600；**key 不出服务端**（只给 hasKey + 尾 4 位）。
 * models.json 里的 provider 也在这里读写 —— 改它就等于改 pi 的配置。
 */
import { tempPathFor } from "../util/atomic-write.js";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { ProviderView } from "../protocol.js";
import { maskKey, type ModelSpec, type ProviderInput } from "./validate.js";
import {
	addCatalogModels,
	removeFromCatalog,
	adoptRename,
	writeCatalogModelPatch,
	writeCatalogUpsert,
} from "./catalog-writes.js";
import { MODELS_FILE, readCatalog, specView } from "./catalog-store.js";
import { chmodSecret } from "../util/file-mode.js";

export const MODELS_STORE_FILE = "models-store.json";
const AUTH_FILE = "auth.json";
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
/**
 * auth.json 的一条凭证。两种形态并存（同一 provider 只会有一个）：
 *   - API key：`{ type: "api_key", key: "sk-…" }`
 *   - 订阅登录（OAuth）：`{ type: "oauth", access, refresh, expires, accountId }`
 *     —— **没有 `key` 字段**。之前只认 `key`，于是「用 ChatGPT Plus/Pro 登录过」
 *     在界面上显示成「无 key」，测试直接 400 `provider.no_key`。
 */
type AuthEntry = {
	type?: string;
	key?: string;
	access?: string;
	refresh?: string;
	expires?: number;
	accountId?: string;
	[key: string]: unknown;
};
type AuthStore = Record<string, AuthEntry>;

/** 凭证的可见信息（回给界面的那一层：只有类型 / 过期时间 / 账号尾号，**没有 token 原文**） */
type CredentialFields = Pick<ProviderView, "hasKey" | "keyHint" | "credential" | "oauth">;

/** 该 provider 的凭证：api key 优先，其次订阅登录 */
function credentialFields(
	authEntry: AuthEntry | undefined,
	catalogKey: string | undefined,
	now: number,
): CredentialFields {
	const key = authEntry?.key ?? catalogKey;
	if (typeof key === "string" && key !== "") return { hasKey: true, keyHint: maskKey(key), credential: "apiKey" };
	const access = typeof authEntry?.access === "string" ? authEntry.access : "";
	if (authEntry?.type !== "oauth" || access === "") return { hasKey: false, keyHint: null, credential: "none" };
	const expiresAt = typeof authEntry.expires === "number" ? authEntry.expires : null;
	const accountId = typeof authEntry.accountId === "string" ? authEntry.accountId : "";
	return {
		hasKey: false,
		keyHint: null,
		credential: "oauth",
		oauth: {
			expired: expiresAt !== null && expiresAt <= now,
			...(expiresAt !== null ? { expiresAt } : {}),
			accountHint: accountId === "" ? null : `…${accountId.slice(-4)}`,
		},
	};
}

/** 发请求要用的凭证原文 —— **只在服务端内部流转**（测试连通性时用），绝不回给前端 */
export type ProviderCredential =
	| { kind: "apiKey"; key: string }
	| { kind: "oauth"; access: string; accountId: string | null; expiresAt: number | null }
	| { kind: "none" };
type ModelsCatalog = {
	providers?: Record<
		string,
		{ api?: string; baseUrl?: string; apiKey?: string; headers?: Record<string, string>; models?: ModelDefinition[] }
	>;
};

/** 把内置 provider「落成自定义条目」时用的种子（整表照抄，不丢内置的其它模型） */
type ProviderSeed = { baseUrl: string; api: string; models: { id: string; name: string }[] };

/** 引擎报上来的内置 provider（pi 自己的目录，不在 models-store.json 里） */
export type BuiltinProvider = {
	provider: string;
	models: { id: string; name: string; api?: string; baseUrl?: string }[];
	baseUrl?: string;
	api?: string;
	/** 目录里声明的显示名（只有未鉴权、拿不到模型清单的 provider 才有） */
	name?: string;
	/** 目录里的模型数量：未鉴权时拿不到清单，但能说清「填了 key 有多少可用」 */
	modelCount?: number;
	/** 真·官方内置（引擎自己的目录里有这个 provider） */
	official?: boolean;
	/** 只支持订阅登录（openai-codex）：填 key 没用 */
	oauthOnly?: boolean;
	/** 除 key 外还要端点 / 云凭证（bedrock、vertex、azure、cloudflare） */
	needsExtraConfig?: boolean;
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
	get: (provider: string, builtin?: BuiltinProvider[]) => Promise<ProviderView | null>;
	/**
	 * 写回单个模型的规格（ADR-0026 A 期）：能力 / 上下文窗口 / 最大输出 / 价格。
	 * 只覆盖这几个字段，其余（compat / headers 等）原样保留。
	 */
	updateModel: (
		provider: string,
		spec: ModelSpec,
		seed?: ProviderSeed,
	) => Promise<{ ok: true } | { ok: false; error: string }>;
	/** 批量导入模型：只追加不存在的 id */
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
	/**
	 * 读「能用来发请求」的凭证：api key 或订阅登录的 access token。
	 * `readKey` 只认 api key，订阅登录的 provider 在它眼里永远是 null —— 测试路径要用这个。
	 */
	readCredential: (provider: string) => Promise<ProviderCredential>;
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
	const temporary = tempPathFor(path);
	await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
	await rename(temporary, path);
	await chmodSecret(path);
}

/** 内置 provider → 可写条目（整表照抄，避免覆盖时丢掉别的模型） */
function materialize(provider: string, seed?: ProviderSeed): { models: ModelDefinition[] } | null {
	if (!seed || seed.models.length === 0) return null;
	return {
		models: seed.models.map((model) => ({
			id: model.id,
			name: model.name,
			// api / baseUrl 可能拿不到（引擎只报了模型名）：空字符串不能写进去，
			// 否则这个 provider 会因为「没有可用端点」被当成坏配置（模型表里也不推）
			...(seed.api ? { api: seed.api } : {}),
			...(seed.baseUrl ? { baseUrl: seed.baseUrl } : {}),
			provider,
		})),
	};
}

/**
 * 「读整表 → 改 → 整表写回」这几类操作**必须排队**。
 *
 * `upsert` / `updateModel` / `addModels` / `remove` / `removeModel` 全是
 * `readJson` → 内存里改 → `writeJsonPrivate` 整表覆盖。两个并发请求（两个标签页同时保存、
 * 一边保存一边用「测试连通性」导入模型）会各自读到同一份旧表、各自写回 —— 后写的那次
 * 把先写的整条 provider 配置盖掉，用户看到的就是「保存了但没了」。
 *
 * 进程级的 `server.lock` 只防多进程，防不了同一个进程里的并发请求，所以这里要一层进程内串行闸门。
 * 只包写操作：读（list / get / readKey…）不排队，否则界面上读一次要等前面的写。
 */
function withSerializedWrites<T extends object>(target: T, keys: readonly (keyof T)[]): T {
	const wrapped = { ...target } as T;
	let chain: Promise<unknown> = Promise.resolve();
	for (const key of keys) {
		const original = target[key];
		if (typeof original !== "function") continue;
		const run = original as unknown as (...args: unknown[]) => Promise<unknown>;
		wrapped[key] = ((...args: unknown[]) => {
			// 上一个失败也要接着跑下一个（不能因为一次写失败就把闸门焊死）
			const next = chain.then(
				() => run.apply(target, args),
				() => run.apply(target, args),
			);
			chain = next.then(
				() => undefined,
				() => undefined,
			);
			return next;
		}) as T[keyof T];
	}
	return wrapped;
}

export function createProviderStore(options: { agentDir: string; now: () => number }): ProviderStore {
	const modelsPath = join(options.agentDir, MODELS_STORE_FILE);
	const authPath = join(options.agentDir, AUTH_FILE);
	const catalogPath = join(options.agentDir, MODELS_FILE);

	const inCatalog = async (provider: string) => Boolean((await readCatalog(options.agentDir)).providers?.[provider]);

	const store: ProviderStore = {
		async list(builtin = []) {
			const [models, auth] = await Promise.all([
				readJson<ModelsStore>(modelsPath, {}),
				readJson<AuthStore>(authPath, {}),
			]);
			/**
			 * 内置目录里逐模型的协议 / 端点。
			 *
			 * 为什么要补：用户在界面上给内置 provider「加模型」时，写进 models.json 的往往只有裸 id，
			 * 而同一个 provider 可能混用多种协议（OpenCode Go：anthropic / openai / gemini）。
			 * 裸 id 会让视图退回到 provider 级的默认协议，逐模型试连就会拿错协议打（400）。
			 */
			/** 引擎目录里真有这个 provider → 即使配置写在 models.json 里，也算「官方内置」 */
			const officialSet = new Set(builtin.filter((item) => item.official === true).map((item) => item.provider));
			const builtinSpecs = new Map<string, Map<string, { api?: string; baseUrl?: string }>>();
			for (const item of builtin) {
				const byId = new Map<string, { api?: string; baseUrl?: string }>();
				for (const model of item.models) {
					if (!model.api && !model.baseUrl) continue;
					byId.set(model.id, {
						...(model.api ? { api: model.api } : {}),
						...(model.baseUrl ? { baseUrl: model.baseUrl } : {}),
					});
				}
				if (byId.size > 0) builtinSpecs.set(item.provider, byId);
			}
			/** 把内置目录里的逐模型协议贴到已有模型上（不覆盖显式配置） */
			const withSpecs = (provider: string, model: ModelDefinition): ModelDefinition => {
				const spec = builtinSpecs.get(provider)?.get(model.id);
				if (!spec) return model;
				return {
					...model,
					...(model.api ? {} : spec.api ? { api: spec.api } : {}),
					...(model.baseUrl ? {} : spec.baseUrl ? { baseUrl: spec.baseUrl } : {}),
				};
			};
			/**
			 * pi 的 provider 目录（models.json）：nexita / deepseek-office 这类就写在这里。
			 * **必须在拼 custom 之前读**：同一个 provider 可能同时出现在两个文件里
			 * （models-store.json 是历史位置、models.json 是 pi 自己的目录），
			 * 而 custom 分支以前只从 auth.json 找凭证 —— 于是「配置写在 models.json 里、
			 * key 也存在 models.json 里」的那个 provider 被判成「没有 key」，
			 * 面板的「只列能用的」就把它藏了（用户看到的：加了两个、只出现一个）。
			 */
			const catalog = await readJson<ModelsCatalog>(catalogPath, {});
			const catalogKeyOf = (provider: string) => catalog.providers?.[provider]?.apiKey;
			const custom = Object.entries(models).map(([provider, entry]) => {
				const list = Array.isArray(entry.models) ? entry.models : [];
				const headers = list.find((model) => model.headers)?.headers;
				return {
					provider,
					source: "custom" as const,
					baseUrl: list.find((model) => typeof model.baseUrl === "string")?.baseUrl ?? "",
					api: list.find((model) => typeof model.api === "string")?.api ?? "",
					// catalogKey 作为兜底：auth.json 没记这个 provider 时，models.json 里的
					// apiKey 同样是「配好了、能用」，不能因为存在两个文件里就当没有
					...credentialFields(auth[provider], catalogKeyOf(provider), options.now()),
					...(headers ? { headerNames: Object.keys(headers) } : {}),
					models: list.map((model) => specView(withSpecs(provider, model))),
				};
			});
			// 目录里**没被 models-store.json 覆盖**的 provider（上面那个 catalog 已经读好了）
			const fromCatalog: ProviderView[] = Object.entries(catalog.providers ?? {})
				.filter(([provider]) => !models[provider])
				.map(([provider, entry]) => {
					const headers = entry.headers ?? entry.models?.find((model) => model.headers)?.headers;
					return {
						provider,
						source: "builtin" as const,
						...(officialSet.has(provider) ? { official: true } : {}),
						baseUrl: entry.baseUrl ?? "",
						api: entry.api ?? "",
						...credentialFields(auth[provider], entry.apiKey, options.now()),
						...(headers ? { headerNames: Object.keys(headers) } : {}),
						models: (entry.models ?? []).map((model) => specView(withSpecs(provider, model))),
					};
				});
			// 引擎报上来的内置 provider：补上目录里没有的（例如插件注册的）
			const known = new Set([...custom, ...fromCatalog].map((view) => view.provider));
			const builtinViews: ProviderView[] = builtin
				.filter((item) => !known.has(item.provider))
				.map((item) => {
					return {
						provider: item.provider,
						source: "builtin" as const,
						baseUrl: item.baseUrl ?? "",
						api: item.api ?? "",
						...credentialFields(auth[item.provider], undefined, options.now()),
						models: (item.models ?? []).map((model) =>
							specView({ id: model.id, name: model.name, api: model.api, baseUrl: model.baseUrl } as ModelDefinition),
						),
						// 未鉴权的目录条目：models 是空数组，改靠 modelCount 说清「填了 key 有几个可用」
						...(typeof item.modelCount === "number" && item.modelCount > 0 ? { modelCount: item.modelCount } : {}),
						// 目录里的显示名（xai → xAI）：只给「还没鉴权、拿不到模型表」的那些用
						...(item.name && item.name !== item.provider ? { label: item.name } : {}),
						...(item.official ? { official: true } : {}),
						...(item.oauthOnly ? { oauthOnly: true } : {}),
						...(item.needsExtraConfig ? { needsExtraConfig: true } : {}),
					};
				});
			return [...custom, ...fromCatalog, ...builtinViews];
		},

		async readKey(provider) {
			const auth = await readJson<AuthStore>(authPath, {});
			const key = auth[provider]?.key ?? (await readJson<ModelsCatalog>(catalogPath, {})).providers?.[provider]?.apiKey;
			return typeof key === "string" && key !== "" ? key : null;
		},

		async readCredential(provider) {
			const [auth, catalog] = await Promise.all([
				readJson<AuthStore>(authPath, {}),
				readJson<ModelsCatalog>(catalogPath, {}),
			]);
			const entry = auth[provider];
			const key = entry?.key ?? catalog.providers?.[provider]?.apiKey;
			if (typeof key === "string" && key !== "") return { kind: "apiKey", key };
			const access = typeof entry?.access === "string" ? entry.access : "";
			if (entry?.type === "oauth" && access !== "") {
				return {
					kind: "oauth",
					access,
					accountId: typeof entry.accountId === "string" && entry.accountId !== "" ? entry.accountId : null,
					expiresAt: typeof entry.expires === "number" ? entry.expires : null,
				};
			}
			return { kind: "none" };
		},

		// `_seed` 保留在签名里（接口 / 调用方一致），但不再用来兜底造条目：
		// 「provider 根本不存在」现在会明确报错，而不是凭空 materialize 一个再删掉它
		async removeModel(provider, modelId, _seed) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			/**
			 * 同一个 provider 可能**同时**记在两个文件里：models.json（pi 自己的目录，真源头）
			 * 与 models-store.json（历史位置 + pi 的目录缓存）。
			 *
			 * 以前只删后者 —— pi 那边一条不改，下次 `listModels()` 照旧把它报上来，
			 * 用户看到的就是「这个模型我早删了，它怎么老回来」。所以两边都得删。
			 * `writeCatalogModelPatch` 在目录里没这个 provider 时返回 false，不影响老路径。
			 */
			const patchedCatalog = await writeCatalogModelPatch(options.agentDir, provider, modelId, null);
			const entry = models[provider];
			if (!entry) {
				// 只存在于 models.json 里（目录型 provider）：上面那一步已经处理完
				return patchedCatalog ? { ok: true } : { ok: false, error: `没有这个 provider：${provider}` };
			}
			const list = Array.isArray(entry.models) ? entry.models : [];
			const next = list.filter((model) => model.id !== modelId);
			if (next.length === list.length) {
				// 历史位置里没有、但目录里删掉了 —— 那也算删成功（否则界面会报「没这个模型」但实际已经没了）
				return patchedCatalog ? { ok: true } : { ok: false, error: `这个 provider 下没有模型：${modelId}` };
			}
			models[provider] = { ...entry, models: next, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);
			return { ok: true };
		},

		async readHeaders(provider) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			const own = models[provider]?.models?.find((model) => model.headers)?.headers;
			if (own) return { ...own };
			const entry = (await readJson<ModelsCatalog>(catalogPath, {})).providers?.[provider];
			const fromCatalog = entry?.headers ?? entry?.models?.find((model) => model.headers)?.headers;
			return fromCatalog ? { ...fromCatalog } : {};
		},

		async get(provider, builtin = []) {
			// 内置 provider（引擎报上来的那一批）也要能查到：否则改模型 / 停用单个模型时
			// view 为 null，模型列表被当成空 → 停一个模型会把整个 provider 关掉
			const all = await this.list(builtin);
			return all.find((view) => view.provider === provider) ?? null;
		},

		async updateModel(provider, spec, seed) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			// 目录里的 provider（nexita 之类）：直接改 pi 的 models.json，不另建覆盖条目
			if (!models[provider] && (await inCatalog(provider))) {
				await writeCatalogModelPatch(options.agentDir, provider, spec.id, spec);
				return { ok: true };
			}
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
				...(spec.costSchedule && spec.costSchedule.length > 0 ? { costSchedule: spec.costSchedule } : {}),
			};
			if (spec.contextWindow === null) delete next.contextWindow;
			if (spec.maxTokens === null) delete next.maxTokens;
			if (!spec.cost) delete next.cost;
			// 分时价格清空了也要真删（否则界面上删掉的时段表下次保存又回来了）
			if (!spec.costSchedule || spec.costSchedule.length === 0) delete next.costSchedule;
			const models2 = [...list];
			models2[index] = next;
			models[provider] = { ...entry, models: models2, lastModified: options.now() };
			await writeJsonPrivate(modelsPath, models);
			return { ok: true };
		},

		async addModels(provider, ids) {
			const models = await readJson<ModelsStore>(modelsPath, {});
			if (!models[provider] && (await inCatalog(provider))) return addCatalogModels(options.agentDir, provider, ids);
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
			let removed = false;
			if (provider in models) {
				delete models[provider];
				removed = true;
			}
			if (removed) await writeJsonPrivate(modelsPath, models);
			if (await inCatalog(provider)) removed = (await removeFromCatalog(options.agentDir, provider)) || removed;
			if (provider in auth) {
				delete auth[provider];
				await writeJsonPrivate(authPath, auth);
				removed = true;
			}
			return { ok: true, removed };
		},

		async upsert(input) {
			// 改名：把旧条目搬到新名字（否则会变成「新建一个、旧的还在」），并带上旧 key
			if (input.previousProvider && input.previousProvider !== input.provider) {
				const oldKey = await adoptRename(options.agentDir, input.previousProvider, input.provider);
				if (input.apiKey === undefined && oldKey) input = { ...input, apiKey: oldKey };
			}
			const [models, auth] = await Promise.all([
				readJson<ModelsStore>(modelsPath, {}),
				readJson<AuthStore>(authPath, {}),
			]);
			// 新 provider 一律写 pi 的目录（models.json）—— 只有写这里，pi 的 CLI 才看得到；
			// models-store.json 是历史遗留位置，仅对已存在的条目继续沿用
			if (!models[input.provider]) {
				// 新增必须能拿到凭证：api key，或者已经用订阅登录过（OAuth 凭据在 auth.json 里）
				const existingKey =
					auth[input.provider]?.key ?? (await readCatalog(options.agentDir)).providers?.[input.provider]?.apiKey;
				const fields = credentialFields(
					input.apiKey ? { type: "api_key", key: input.apiKey } : auth[input.provider],
					existingKey,
					options.now(),
				);
				if (fields.credential === "none") {
					return { ok: false, error: "新增 provider 必须填 api key（否则模型调不通）" };
				}
				/**
				 * 「只填一把 key」的引擎内置 provider（xAI / Cerebras / Fireworks …）：
				 * 模型表由引擎自己的目录提供，这里**只写 auth.json**。
				 * 为什么不能走下面那条写目录的路：models.json 里建一个 `models: []` 的条目会把
				 * 内置 provider 盖成「0 个模型」，pi 那边直接没有可用模型（比不配还糟）。
				 */
				if (input.models.length === 0) {
					if (!input.apiKey) {
						return {
							ok: false,
							error: "这个 provider 的模型由引擎目录提供：填一把 api key 就能用，不用填模型",
						};
					}
					auth[input.provider] = { ...auth[input.provider], type: "api_key", key: input.apiKey };
					await writeJsonPrivate(authPath, auth);
					return {
						ok: true,
						view: {
							provider: input.provider,
							source: "builtin" as const,
							baseUrl: input.baseUrl,
							api: input.api,
							...credentialFields(auth[input.provider], undefined, options.now()),
							models: [],
						},
					};
				}
				const { models: written } = await writeCatalogUpsert(options.agentDir, input);
				return {
					ok: true,
					view: {
						provider: input.provider,
						source: "builtin" as const,
						baseUrl: input.baseUrl,
						api: input.api,
						...fields,
						...(input.headers ? { headerNames: Object.keys(input.headers) } : {}),
						models: written.map((model) => specView(model as never)),
					},
				};
			}

			const existing = models[input.provider];
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
			// 表单里的清单是**权威**的：没勾的模型就是要去掉（之前这里会悄悄保留，
			// 于是"取消勾选 + 保存"看起来毫无效果）

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

			return {
				ok: true,
				view: {
					provider: input.provider,
					source: "custom" as const,
					baseUrl: input.baseUrl,
					api: input.api,
					...credentialFields(auth[input.provider], undefined, options.now()),
					...(input.headers ? { headerNames: Object.keys(input.headers) } : {}),
					models: nextModels.map((model) => ({ id: model.id, name: model.name ?? model.id })),
				},
			};
		},
	};

	// 写操作串行化（见 withSerializedWrites 的注释）：只包会「整表写回」的那五个
	return withSerializedWrites(store, ["upsert", "updateModel", "addModels", "remove", "removeModel"]);
}
