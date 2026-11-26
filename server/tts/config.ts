/**
 * 云端 TTS 的密钥配置（Edge 之外那些「要 key 的厂商」）。
 *
 * 为什么和 `server/stt/config.ts` 分两个文件（用户 2026-11-24：「这 2 块可以各配置各的」）：
 * 合成（文字→声音）和识别（声音→文字）是两条独立的链路，厂商可以完全不同
 * （比如合成用 DeepSeek、识别用千问），混在一个文件里迟早会串。
 *
 * 落在 `~/.oh-my-agent-web/tts.json`（0600），**按厂商分块**：
 *
 *   {
 *     "providers": {
 *       "deepseek":   { "apiKey": "sk-…", "baseUrl": "https://api.deepseek.com" },
 *       "qwen":       { "apiKey": "sk-…" },
 *       "volcengine": { "appId": "…", "accessToken": "…", "cluster": "volcano_tts" }
 *     }
 *   }
 *
 * 宽容读法：也认「顶层直接放厂商名」（省掉 providers 这一层），以及老的
 * 单厂商扁平写法 `{ "provider": "deepseek", "apiKey": "…" }` —— 用户手写的文件
 * 少一层缩进不该直接失效。
 *
 * 环境变量（便于临时试 / 容器注入），两种粒度：
 *   · `AGENT_WEB_TTS_PROVIDER=deepseek` + `AGENT_WEB_TTS_KEY=…`（[+ `_BASE_URL` / `_VOICE`]）
 *   · `AGENT_WEB_TTS_<厂商>_KEY` / `_BASE_URL` / `_VOICE`，例如 `AGENT_WEB_TTS_DEEPSEEK_KEY`
 */
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

/** 一家厂商的配置块：键名由各引擎自己解释（apiKey / baseUrl / appId / cluster …） */
export type TtsProviderSecrets = Record<string, string>;

export type TtsConfigRead = {
	/** 厂商 id → 它的配置块（没配的厂商不会有键） */
	providers: Record<string, TtsProviderSecrets>;
	/** 实际读的是哪个文件（日志/报错里说清楚，免得用户改了别的文件） */
	source: string;
	/** 文件存在但读不懂时的原因（不致命，按「没配」处理） */
	error?: string;
};

const FILE_NAME = "tts.json";
/** 配置块里只收字符串：数字/布尔容易在不同厂商间产生歧义，一律让用户写字符串 */
const KNOWN_KEYS = ["apiKey", "baseUrl", "endpoint", "voiceId", "model", "appId", "accessToken", "cluster"] as const;

export function ttsConfigPath(dataDir?: string): string {
	const override = process.env.AGENT_WEB_TTS_CONFIG?.trim();
	if (override) return override;
	return join(dataDir ?? join(homedir(), ".oh-my-agent-web"), FILE_NAME);
}

/** 把一个来路不明的对象收敛成 `{ apiKey: "…" }`：只认白名单键 + 字符串值 */
function asSecrets(value: unknown): TtsProviderSecrets {
	if (!value || typeof value !== "object" || Array.isArray(value)) return {};
	const record = value as Record<string, unknown>;
	const secrets: TtsProviderSecrets = {};
	for (const key of KNOWN_KEYS) {
		const item = record[key];
		if (typeof item === "string" && item.trim()) secrets[key] = item.trim();
	}
	return secrets;
}

function envProviders(): Record<string, TtsProviderSecrets> {
	const providers: Record<string, TtsProviderSecrets> = {};
	const pick = (name: string) => process.env[name]?.trim() || undefined;

	// 粒度一：只配一家（最短路径：provider + key）
	const single = pick("AGENT_WEB_TTS_PROVIDER");
	if (single) {
		providers[single] = asSecrets({
			apiKey: pick("AGENT_WEB_TTS_KEY"),
			baseUrl: pick("AGENT_WEB_TTS_BASE_URL"),
			endpoint: pick("AGENT_WEB_TTS_ENDPOINT"),
			voiceId: pick("AGENT_WEB_TTS_VOICE"),
		});
	}

	// 粒度二：按厂商分开配（`AGENT_WEB_TTS_DEEPSEEK_KEY` 等），可以和上面共存
	for (const [name, value] of Object.entries(process.env)) {
		const match = /^AGENT_WEB_TTS_([A-Z0-9]+)_(KEY|BASE_URL|ENDPOINT|VOICE)$/.exec(name);
		if (!match || !value?.trim()) continue;
		const id = match[1].toLowerCase();
		const field = match[2] === "KEY" ? "apiKey" : match[2] === "VOICE" ? "voiceId" : match[2].toLowerCase();
		providers[id] = { ...providers[id], [field]: value.trim() };
	}
	return providers;
}

function fileProviders(parsed: unknown, source: string): { providers: Record<string, TtsProviderSecrets>; error?: string } {
	if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
		return { providers: {}, error: `${source} 的内容不是 JSON 对象` };
	}
	const root = parsed as Record<string, unknown>;

	// 老的单厂商扁平写法：{ provider: "deepseek", apiKey: "…" }
	if (typeof root.provider === "string" && root.provider.trim()) {
		const secrets = asSecrets(root);
		return { providers: Object.keys(secrets).length > 0 ? { [root.provider.trim()]: secrets } : {} };
	}

	// 标准写法：providers 下面一家一块；顺手兼容「顶层直接放厂商名」
	const nested = root.providers && typeof root.providers === "object" && !Array.isArray(root.providers);
	const source_ = (nested ? (root.providers as Record<string, unknown>) : root) ?? {};
	const providers: Record<string, TtsProviderSecrets> = {};
	for (const [id, value] of Object.entries(source_)) {
		if (!value || typeof value !== "object" || Array.isArray(value)) continue;
		const secrets = asSecrets(value);
		if (Object.keys(secrets).length > 0) providers[id] = secrets;
	}
	return { providers };
}

export function readTtsConfig(dataDir?: string): TtsConfigRead {
	const source = ttsConfigPath(dataDir);
	let fromFile: Record<string, TtsProviderSecrets> = {};
	let error: string | undefined;

	if (existsSync(source)) {
		try {
			const parsed = JSON.parse(readFileSync(source, "utf8")) as unknown;
			const read = fileProviders(parsed, source);
			fromFile = read.providers;
			error = read.error;
		} catch (cause) {
			error = `${source} 不是合法 JSON：${cause instanceof Error ? cause.message : String(cause)}`;
		}
	}

	// 合并口径：环境变量覆盖文件里同名字段，其余厂商块各自保留
	const providers: Record<string, TtsProviderSecrets> = { ...fromFile };
	for (const [id, secrets] of Object.entries(envProviders())) {
		providers[id] = { ...providers[id], ...secrets };
	}
	return { providers, source, error };
}

/** 某家厂商的配置块（没有就是 undefined，由引擎自己给出「怎么配」的报错） */
export function providerSecrets(config: TtsConfigRead, id: string): TtsProviderSecrets | undefined {
	const secrets = config.providers[id];
	return secrets && Object.keys(secrets).length > 0 ? secrets : undefined;
}
