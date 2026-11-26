/**
 * 云端 STT 的配置读取。
 *
 * 和 TTS 一模一样的原则（用户 2026-11-24：「这 2 块可以各配置各的」）：合成、识别
 * 各读一个文件，厂商之间也各配各的块 —— 换掉识别厂商不该动到合成的密钥。
 *
 * 来源，环境变量优先（方便临时切换 / 容器里注入）：
 *   1. `~/.oh-my-agent-web/stt.json`（或 `AGENT_WEB_STT_CONFIG` 指定的文件）
 *   2. `AGENT_WEB_STT_PROVIDER` / `_ENDPOINT` / `_KEY` / `_MODEL` / `_LANGUAGE`
 *      以及按厂商分开的 `AGENT_WEB_STT_<厂商>_KEY`（如 `AGENT_WEB_STT_DEEPSEEK_KEY`）
 *
 * 文件形状（推荐，按厂商分块）：
 *
 *   {
 *     "provider": "deepseek",
 *     "providers": {
 *       "deepseek":   { "apiKey": "sk-…" },
 *       "qwen":       { "apiKey": "sk-…", "model": "qwen3-asr-flash" }
 *     }
 *   }
 *
 * 也认老的单厂商扁平写法：`{ "provider": "openai-compatible", "endpoint": "…", "apiKey": "…" }`，
 * 以及只有一家时的省略写法 `{ "providers": { "deepseek": { "apiKey": "…" } } }`（自动选中那家）。
 *
 * 没配（缺 provider）= 继续用本地识别，不报错 —— 这是默认状态。
 */
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { SttConfig } from "./types.js";

const FILE_NAME = "stt.json";

export function sttConfigPath(dataDir?: string): string {
	const override = process.env.AGENT_WEB_STT_CONFIG?.trim();
	if (override) return override;
	return join(dataDir ?? join(homedir(), ".oh-my-agent-web"), FILE_NAME);
}

/** 把一段来路不明的对象收敛成配置字段（只认白名单，别的键一律丢掉） */
function asFields(value: unknown): Partial<SttConfig> {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const raw = value as Record<string, unknown>;
	const fields: Partial<SttConfig> = {};
	const text = (name: string) => {
		const item = raw[name];
		return typeof item === "string" && item.trim() ? item.trim() : undefined;
	};
	const provider = text("provider");
	if (provider) fields.provider = provider;
	const endpoint = text("endpoint");
	if (endpoint) fields.endpoint = endpoint;
	const apiKey = text("apiKey");
	if (apiKey) fields.apiKey = apiKey;
	const model = text("model");
	if (model) fields.model = model;
	const language = text("language");
	if (language) fields.language = language;
	if (typeof raw.timeoutMs === "number" && Number.isFinite(raw.timeoutMs)) fields.timeoutMs = raw.timeoutMs;
	// 增量（准实时）出字：显式关掉/调快调慢
	if (typeof raw.incremental === "boolean") fields.incremental = raw.incremental;
	if (typeof raw.incrementalMs === "number" && Number.isFinite(raw.incrementalMs)) {
		fields.incrementalMs = raw.incrementalMs;
	}
	if (raw.headers && typeof raw.headers === "object" && !Array.isArray(raw.headers)) {
		const headers: Record<string, string> = {};
		for (const [key, item] of Object.entries(raw.headers as Record<string, unknown>)) {
			if (typeof item === "string" && item.trim()) headers[key] = item.trim();
		}
		if (Object.keys(headers).length > 0) fields.headers = headers;
	}
	if (raw.extraFields && typeof raw.extraFields === "object" && !Array.isArray(raw.extraFields)) {
		const extra: Record<string, string> = {};
		for (const [key, item] of Object.entries(raw.extraFields as Record<string, unknown>)) {
			if (typeof item === "string" && item.trim()) extra[key] = item.trim();
		}
		if (Object.keys(extra).length > 0) fields.extraFields = extra;
	}
	return fields;
}

/** 文件 → { 顶层字段, 各厂商块 }；容忍三种写法（见文件头） */
function parseFile(parsed: unknown, source: string): {
	flat: Partial<SttConfig>;
	providers: Record<string, Partial<SttConfig>>;
	error?: string;
} {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { flat: {}, providers: {}, error: `${source} 的内容不是 JSON 对象` };
	}
	const root = parsed as Record<string, unknown>;
	const flat = asFields(root);
	const providers: Record<string, Partial<SttConfig>> = {};

	if (root.providers && typeof root.providers === "object" && !Array.isArray(root.providers)) {
		for (const [id, block] of Object.entries(root.providers as Record<string, unknown>)) {
			const fields = asFields(block);
			// 块里可以省掉 provider（外面写着呢），这里补上，日志与 registry 才找得到
			providers[id] = { ...fields, provider: fields.provider ?? id };
		}
	} else if (!flat.provider) {
		// 没有 providers 这一层、也没写 provider：把「顶层厂商名」当块（只有一家时才这么猜）
		const entries = Object.entries(root).filter(
			([, value]) => value && typeof value === "object" && !Array.isArray(value),
		);
		const named = entries.filter(([id]) => asFields(root[id]).apiKey || asFields(root[id]).endpoint);
		if (named.length === 1) {
			const [id] = named[0];
			providers[id] = { ...asFields(root[id]), provider: id };
		}
	}
	return { flat, providers };
}

function envOverrides(): { flat: Partial<SttConfig>; providers: Record<string, Partial<SttConfig>> } {
	const pick = (name: string) => process.env[name]?.trim() || undefined;
	const flat: Partial<SttConfig> = {
		provider: pick("AGENT_WEB_STT_PROVIDER"),
		endpoint: pick("AGENT_WEB_STT_ENDPOINT"),
		apiKey: pick("AGENT_WEB_STT_KEY"),
		model: pick("AGENT_WEB_STT_MODEL"),
		language: pick("AGENT_WEB_STT_LANGUAGE"),
	};
	// 把 undefined 的键去掉，免得覆盖掉文件里的值
	for (const key of Object.keys(flat) as Array<keyof SttConfig>) {
		if (flat[key] === undefined) delete flat[key];
	}
	const providers: Record<string, Partial<SttConfig>> = {};
	for (const [name, value] of Object.entries(process.env)) {
		const match = /^AGENT_WEB_STT_([A-Z0-9]+)_(KEY|ENDPOINT|MODEL|LANGUAGE)$/.exec(name);
		if (!match || !value?.trim()) continue;
		const id = match[1].toLowerCase();
		const field = match[2].toLowerCase() as "apiKey" | "endpoint" | "model" | "language";
		providers[id] = { ...providers[id], [field]: value.trim() };
	}
	return { flat, providers };
}

export type SttConfigRead = {
	/** 配好了才有值；null = 用本地识别 */
	config: SttConfig | null;
	/** 实际读的是哪个文件（日志里说清楚，免得用户改了别的文件） */
	source: string;
	/** 文件存在但读不懂时的原因（不致命，按"没配"处理） */
	error?: string;
};

/** 文件里每一家厂商自己的配置块（不含 env 合并，内部用） */
function readFileParts(dataDir?: string): {
	flat: Partial<SttConfig>;
	providers: Record<string, Partial<SttConfig>>;
	source: string;
	error?: string;
} {
	const source = sttConfigPath(dataDir);
	let flat: Partial<SttConfig> = {};
	let providers: Record<string, Partial<SttConfig>> = {};
	let error: string | undefined;

	if (existsSync(source)) {
		try {
			const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown;
			const read = parseFile(parsed, source);
			flat = read.flat;
			providers = read.providers;
			error = read.error;
		} catch (cause) {
			error = `${source} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}
	return { flat, providers, source, error };
}

/**
 * 各家厂商的配置块（含 env 覆盖）。面板列「能选哪些云端引擎」时用它 ——
 * 只有 `readSttConfig()` 的话只能看见**当前选中的那一家**，选不到别家。
 */
export function readSttProviders(dataDir?: string): {
	blocks: Record<string, Partial<SttConfig>>;
	source: string;
	error?: string;
} {
	const file = readFileParts(dataDir);
	const env = envOverrides();
	const blocks: Record<string, Partial<SttConfig>> = {};
	for (const id of new Set([...Object.keys(file.providers), ...Object.keys(env.providers)])) {
		blocks[id] = { ...file.providers[id], ...env.providers[id] };
	}
	return { blocks, source: file.source, error: file.error };
}

/**
 * 面板上切换云端引擎：只改顶层的 `provider`，以及该厂商块里的 `model` / `apiKey`，
 * **别家的密钥、端点、额外字段一律原样保留**。
 *
 * 为什么 apiKey 也要能写：千问的「整段识别」和「实时识别」是两个 provider，百炼那边
 * 却是同一把 key。不代抄的话，用户切到实时就被判「没配密钥」、莫名其妙掉回本地识别。
 *
 * 文件读不懂时**抛错而不是覆盖** —— 那里面是密钥，宁可让用户手工修，也不替他清空。
 */
export function saveSttSelection(
	selection: { provider: string; model?: string | null; apiKey?: string },
	dataDir?: string,
): string {
	const file = sttConfigPath(dataDir);
	let root: Record<string, unknown> = {};

	if (existsSync(file)) {
		try {
			const parsed = JSON.parse(readFileSync(file, "utf8")) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("内容不是 JSON 对象");
			root = { ...(parsed as Record<string, unknown>) };
		} catch (cause) {
			throw new Error(
				`${file} 读不出来（${cause instanceof Error ? cause.message : String(cause)}），为免覆盖掉里面的密钥，请先手工修好这个文件`,
			);
		}
	}

	root.provider = selection.provider;

	const isPlainObject = (value: unknown): value is Record<string, unknown> =>
		!!value && typeof value === "object" && !Array.isArray(value);
	const providers = isPlainObject(root.providers) ? { ...root.providers } : {};
	const current = isPlainObject(providers[selection.provider]) ? { ...(providers[selection.provider] as Record<string, unknown>) } : {};

	if (selection.model !== undefined) {
		const model = selection.model?.trim();
		if (model) current.model = model;
		else delete current.model; // 空 = 回到 provider 自己的默认模型
	}
	const apiKey = selection.apiKey?.trim();
	if (apiKey) current.apiKey = apiKey;

	// 一次都没配过就别凭写个空块出来（文件里原本没有这一家）
	if (Object.keys(current).length > 0) providers[selection.provider] = current;
	if (Object.keys(providers).length > 0) root.providers = providers;

	// 密钥在里面：0600 + 原子写（先写临时文件再 rename，半截文件比没写更糟）
	const tmp = `${file}.${process.pid}.tmp`;
	writeFileSync(tmp, `${JSON.stringify(root, null, 2)}\n`, { mode: 0o600 });
	renameSync(tmp, file);
	return file;
}

export function readSttConfig(dataDir?: string): SttConfigRead {
	const file = readFileParts(dataDir);
	const fromFile = file.flat;
	const fileProviders = file.providers;
	const source = file.source;
	const error = file.error;

	const env = envOverrides();
	// provider 决定取哪个厂商块：环境变量 > 文件顶层 > 只有一家时的那个块
	const provider = env.flat.provider ?? fromFile.provider ?? (Object.keys(fileProviders).length === 1 ? Object.keys(fileProviders)[0] : undefined);
	if (!provider) return { config: null, source, error };

	const block = { ...fileProviders[provider], ...env.providers[provider] };
	const merged: SttConfig = { ...fromFile, ...block, ...env.flat, provider } as SttConfig;
	// endpoint 可以不写：各 provider 自己有默认端点（见 server/stt/index.ts）；这里只保证 provider 在
	return { config: merged, source, error };
}
