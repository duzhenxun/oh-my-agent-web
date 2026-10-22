/**
 * 引擎接线（index.ts 的 400 行护栏 + 一处装配）。
 *
 * 把三件事绑在一起，因为它们必须指向**同一批实例**：
 *   1. 注册表（有哪些引擎、怎么造）；
 *   2. codex 的 app-server 客户端（引擎与会话清单共用一个子进程）；
 *   3. 目录（每个引擎的历史会话从哪来）。
 *
 * codex 客户端构造时不 spawn：机器上没装 codex 也能正常启动，只有在切到它时才报错。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { PiProject } from "../protocol.js";
import { createBuiltinEngineRegistry } from "./builtin.js";
import { createEngineCatalog, type EngineCatalog } from "./catalog.js";
import { createCodexSessionsProvider } from "./codex-sessions.js";
import { createCodexClient } from "./codex-transport.js";
import { createDshClient } from "./dsh-transport.js";
import { createDshSessionsProvider } from "./dsh-sessions.js";
import type { EngineRegistry } from "./registry.js";

export type EngineWiring = {
	registry: EngineRegistry;
	catalog: EngineCatalog;
	/** 启动时选定的引擎（未注册的名字回落到 pi，并已在日志里报告） */
	resolved: ReturnType<EngineRegistry["resolve"]>;
	/** 退出时收掉外部引擎的子进程（codex app-server） */
	close: () => void;
};

/**
 * 读 `<patchDir>/default-model.json`（`{"provider":"…","model":"…"}` 或 `{"id":"provider/model"}`）。
 *
 * 为什么要有它：把自定义 provider 通过 `--patch` 带给 acp 之后，ACP 的 `session/new`
 * 仍然按它自己的默认路由给 `currentValue`（实测 `agent-default-model` 不生效），
 * 于是「新会话默认用哪个模型」必须由我们自己指定。
 */
export function readDshDefaultModel(dir: string): string | null {
	const file = join(dir, "default-model.json");
	if (!existsSync(file)) return null;
	try {
		const parsed = JSON.parse(readFileSync(file, "utf8")) as { id?: unknown; provider?: unknown; model?: unknown };
		if (typeof parsed.id === "string" && parsed.id.trim() !== "") return parsed.id.trim();
		if (typeof parsed.provider === "string" && typeof parsed.model === "string") {
			return `${parsed.provider}/${parsed.model}`;
		}
		return null;
	} catch {
		return null;
	}
}

export function createEngineWiring(options: {
	/** AGENT_WEB_ENGINE 的值 */
	engineName: string;
	codexBin: string;
	codexHome: string | null;
	dshBin: string;
	dshHome: string | null;
	dshModel: string | null;
	/** 环境里显式给的 patch（AGENT_WEB_DSH_PATCH） */
	dshPatches?: string[];
	/** 用户 patch 目录（默认 `<dataDir>/dsh-patches`）：里面的 *.yml 按文件名顺序叠加 */
	dshPatchDir?: string;
	/** pi 的历史会话扫描器（index 用 piAgentDir + dataDir 装配） */
	piSessions: () => Promise<PiProject[]>;
	onNotice: (text: string, level?: "info" | "warn" | "error") => void;
	onLog: (text: string, meta?: Record<string, unknown>) => void;
}): EngineWiring {
	const codexClient = createCodexClient({
		bin: options.codexBin,
		home: options.codexHome ?? undefined,
		log: (text) => options.onLog(text, { engine: "codex" }),
	});

	/**
	 * dsh 的 patch 叠加层：把「自定义 provider / 默认模型」带给 acp profile。
	 * 顺序 = 环境变量里显式给的 → 用户目录里的 `*.yml`（按文件名）。
	 */
	const patchDir = options.dshPatchDir;
	const patchFiles = [
		...(options.dshPatches ?? []),
		...(patchDir && existsSync(patchDir)
			? readdirSync(patchDir)
					.filter((name) => name.endsWith(".yml") || name.endsWith(".yaml"))
					.sort()
					.map((name) => join(patchDir, name))
			: []),
	].filter((file) => existsSync(file));
	if (patchFiles.length > 0) options.onLog(`dsh：加载 ${patchFiles.length} 个 patch 叠加层`, { files: patchFiles });
	// 自定义 provider 的「默认模型」：patch 里的 agent-default-model 不会被 ACP 带到
	// session/new 的 configOptions（实测），所以这里用一个伴随文件显式指定。
	const defaultModel = options.dshModel ?? (patchDir ? readDshDefaultModel(patchDir) : null);

	const dshClient = createDshClient({
		bin: options.dshBin,
		home: options.dshHome ?? undefined,
		patches: patchFiles,
		log: (text) => options.onLog(text, { engine: "dsh" }),
	});

	const registry = createBuiltinEngineRegistry({
		onNotice: options.onNotice,
		onLog: (text) => options.onLog(text),
		codex: { client: codexClient },
		dsh: { client: dshClient, model: defaultModel },
	});

	const catalog = createEngineCatalog({
		registry,
		sessions: {
			pi: options.piSessions,
			// fake 是「剧本回放」引擎：历史沿用 pi 的存储（本地演练 / 冒烟时侧栏不至于全空）
			fake: options.piSessions,
			codex: createCodexSessionsProvider({ client: codexClient, log: (text) => options.onLog(text) }),
			// dsh 的历史会话清单：读 ~/.dsh 的 workspace.json + 会话投影缓存（只读）
			dsh: createDshSessionsProvider({ home: options.dshHome ?? undefined, log: (text) => options.onLog(text) }),
		},
	});

	const resolved = registry.resolve(options.engineName);
	if (resolved.fallbackFrom) {
		options.onLog(`AGENT_WEB_ENGINE 未注册，回落到 pi（可选：${registry.names().join(" / ")}）`, {
			requested: resolved.fallbackFrom,
		});
	}

	return {
		registry,
		catalog,
		resolved,
		// 收掉外部引擎的子进程；pi 是进程内 SDK，不需要额外收
		close: () => {
			codexClient.close();
			dshClient.close();
		},
	};
}
