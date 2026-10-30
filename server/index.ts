/**
 * 入口：一个 HTTP 端口 + 实时通道（WS 或 SSE/RPC，ADR-0032）。
 */
import { defaultSkillsDir } from "./skills/skill-store.js";
import { homedir, networkInterfaces } from "node:os";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { createEngineWiring } from "./engine/wiring.js";
import type { EnginePort, EngineProviderCatalogEntry } from "./engine/port.js";
import { createFileRuleStore } from "./approval/rules.js";
import { existsSync, mkdirSync } from "node:fs";
import { PROTOCOL_VERSION, type ProtocolError, type ServerReply } from "./protocol.js";
import { acquireLock, describeHolder, releaseLock } from "./session/lock.js";
import { createRuntime } from "./session/runtime.js";
import { createFileSettingsStore, readSettingsSync } from "./session/settings.js";
import { createSender, type OutFrame } from "./snapshot/sender.js";
import { createPiSessionsProvider, piAgentDir } from "./session/pi-sessions-provider.js";
import { createUploadStore, uploadsDir } from "./uploads/upload-store.js";
import { createProviderWiring } from "./providers/provider-handlers.js";
import { providerPool } from "./providers/provider-pool.js";
import { probeProvider } from "./providers/probe.js";
import { createProviderStore } from "./providers/provider-store.js";
import { createEnabledStore } from "./providers/enabled-models.js";
import { createPluginStore, type PluginStore } from "./engine/pi-plugins.js";
import { createMcpLogin } from "./mcp/mcp-auth.js";
import { createCodexMcpStore, codexConfigPath } from "./mcp/codex-mcp-store.js";
import { createClaudeMcpStore, createOpencodeMcpStore } from "./mcp/json-mcp-store.js";
import { createNoneMcpStore } from "./mcp/none-mcp-store.js";
import { createMcpStore, type McpStore } from "./mcp/mcp-store.js";
import {
	createClaudePluginStore,
	createCodexPluginStore,
	createNonePluginStore,
	createOpencodePluginStore,
} from "./plugins/engine-plugin-stores.js";
import { createMcpMarket } from "./mcp/mcp-market.js";
import { migrateStoreToCatalog } from "./providers/catalog-writes.js";
import { createPushStore, notifyTurnFinished } from "./push/push.js";
import { registerAuxRoutes } from "./http/aux-routes.js";
// ADR-0047：右侧「网页」页的代理（绕开 X-Frame-Options / CSP frame-ancestors）
import { registerWebProxyRoutes } from "./web-proxy/proxy-routes.js";
import { handleMessage, type ClientSink } from "./ws/handle-message.js";
import { registerHealthAndStatic } from "./http/health-and-static.js";
import { registerUploadRoutes } from "./uploads/upload-routes.js";
import { readConfig, validateConfig } from "./util/env.js";
import { createLogger } from "./util/log.js";
import { createRotatingFileSink, logFileName, type RotatingFileSink } from "./util/log-file.js";
import { refreshPriceIndex } from "./util/pricing-index.js";
import { pickExisting, webDistCandidates } from "./util/paths.js";
import { isLoopbackHostname } from "./util/origin.js";
import { authMiddleware } from "./http/auth.js";
import { createPasswordStore } from "./http/password-store.js";
import { registerAuthRoutes } from "./http/auth-routes.js";
import { BRAND_NAME } from "./brand.js";
import { registerLiveRoutes, type Sink } from "./http/live-routes.js";
import { compressText, immutableAssets } from "./http/compress.js";
import { fanOutSnapshot } from "./snapshot/fan-out.js";
import { checkDataDirWritable, describeListenError } from "./util/startup.js";
import { migrateLegacyDataDir } from "./util/data-dir.js";
import { DEFAULT_DATA_DIR_NAME } from "./util/env.js";
import { resolveStartupPassword } from "./http/password-store.js";
import { packageMeta } from "./util/version.js";
import { checkForUpdate, describeUpdate } from "./update-check.js";
import { styleText } from "node:util";

const HERE = fileURLToPath(new URL(".", import.meta.url));
/** 开发态对外端口（Vite）；dev 脚本用它告诉后端可信来源 */
const DEV_WEB_PORT = Number(process.env.AGENT_WEB_DEV_PORT ?? 25257);
/** 快照节流窗口（ADR-0004 §3） */
const SNAPSHOT_WINDOW_MS = 60;
const TICK_MS = 20;

/**
 * 访问密码：**唯一来源是 `<dataDir>/password`**（在 `readConfig` 之前就要定下来）。
 *
 * 以前这个入口（`npm run dev` / `npm run serve`，源码直跑）只认 `AGENT_WEB_PASSWORD`，
 * 而 `cli.ts`（`aw` / `npm start`）会先把文件补进 env —— 于是同一个人用两种方式起，
 * 「设置 → 远程」里改的密码只在其中一种方式下生效，重启后就成了「密码怎么变了」
 * （用户 2026-10-30）。现在两边同一个口径：文件优先，env 只在文件还没生成时当一次性来源。
 */
const startupDataDir =
	process.env.AGENT_WEB_DATA_DIR && process.env.AGENT_WEB_DATA_DIR !== ""
		? resolve(process.env.AGENT_WEB_DATA_DIR)
		: join(homedir(), DEFAULT_DATA_DIR_NAME);
const startupPassword = resolveStartupPassword(join(startupDataDir, "password"), process.env.AGENT_WEB_PASSWORD);
if (startupPassword.password !== null) process.env.AGENT_WEB_PASSWORD = startupPassword.password;
else delete process.env.AGENT_WEB_PASSWORD;

const {
	config,
	problems: envProblems,
	notes: envNotes,
	workspaceFallback,
} = readConfig(process.env, {
	home: homedir(),
	cwd: process.cwd(),
});
let fileSink: RotatingFileSink | null = null;
/**
 * 前台运行（CLI 默认）：终端只留 warn / error。
 *
 * 以前后台才是默认，这些 info（装载会话索引、provider 列表……）都落在 daemon.log 里看不见；
 * 现在前台成了默认，再照旧打就会把用户自己的输机记录冲没。
 * 它们仍然**全部**进轮转日志文件；显式给了 `AGENT_WEB_LOG=debug|info` 就按用户的意思正常打。
 * （每来一个客户端一条的「SSE 已连接 / 已断开」已经降到 debug：每个标签页每次重连都写一行，
 * 正常运行时纯噪声，真排查时 `AGENT_WEB_LOG=debug aw` 再看。）
 */
const foreground = process.env.AGENT_WEB_FOREGROUND === "1";
const quietConsole = foreground && !process.env.AGENT_WEB_LOG;
const logger = createLogger({
	level: config.logLevel,
	scope: "app",
	sink: (line, level) => {
		if (!quietConsole || level === "warn" || level === "error") process.stdout.write(`${line}\n`);
		fileSink?.write(line);
	},
});
// 密码来源只记来源、记来源里的**文件名**，绝不记密码本身：
// 「改了密码还是不生效」十有八九是读的那份和你改的不是同一份。
if (startupPassword.source === "migrated") {
	logger.info("访问密码来自环境变量，已一次性存进数据目录（以后只读那份）", {
		file: join(startupDataDir, "password"),
	});
} else if (startupPassword.source === "none") {
	logger.info("没有设访问密码：远程访问一律不开（本机回环免密）");
} else if (startupPassword.conflict) {
	logger.info(`环境变量里的密码与数据目录那份不一致：以 ${join(startupDataDir, "password")} 为准`);
}

// 单用户工作台：一处 fire-and-forget 的 Promise 拒绝（推送写盘失败、模型热重载失败……）
// 不该把整个服务带走（Node ≥15 默认会直接退出）。记日志、继续跑。
process.on("unhandledRejection", (reason) => {
	logger.error("未处理的 Promise 拒绝（已记录，进程继续）", {
		message: reason instanceof Error ? (reason.stack ?? reason.message) : String(reason),
	});
});
// 同一个口径的另外半边：**同步抛出**的异常（最典型的是扩展塞在 setTimeout 里的渲染，
// 比如 `token-speed.ts` 调 pi 的 theme 时抛 `Theme not initialized`）。
// 没人 catch 的 timer 异常在 Node 里等于「杀进程」—— 一条扩展的渲染错就能把整个工作台带走，
// 用户看到的就是服务突然没了、终端回到提示符。这里记下来、继续跑。
//
// 取舍：单用户本地工作台，宁可带着可能的脏状态继续（顶多某个界面块不刷新），
// 也不要一按就死 —— 死了连日志面板都打不开。真到了没法自救的地步，用户重启就是了。
process.on("uncaughtException", (error) => {
	logger.error("未捕获的异常（已记录，进程继续）", {
		message: error instanceof Error ? (error.stack ?? error.message) : String(error),
	});
});

/** 局域网地址自动放行；域名仍要显式配 */
const localAddresses = Object.values(networkInterfaces())
	.flat()
	.filter((item): item is NonNullable<typeof item> => Boolean(item) && item?.internal === false)
	.map((item) => item.address);

const policy = {
	port: config.port,
	devPorts: [DEV_WEB_PORT],
	extraHosts: [...new Set([...localAddresses, ...config.allowedHosts])],
};

let shuttingDown = false;

const sender = createSender({
	windowMs: SNAPSHOT_WINDOW_MS,
	send: (frame: OutFrame) => {
		if (frame.kind === "snapshot") fanOut(frame.snapshot);
	},
});

const piSessions = createPiSessionsProvider({ agentDir: piAgentDir(), dataDir: config.dataDir });

/** 引擎接线：注册表 + codex 客户端 + 每个引擎的会话来源（engine/wiring.ts） */
const engineWiring = createEngineWiring({
	engineName: config.engine,
	codexBin: config.codexBin,
	codexHome: config.codexHome,
	dshBin: config.dshBin,
	dshHome: config.dshHome,
	dshModel: config.dshModel,
	dshPatches: config.dshPatches,
	dshPatchDir: join(config.dataDir, "dsh-patches"),
	opencodeBin: config.opencodeBin,
	opencodeArgs: config.opencodeArgs,
	opencodeModel: config.opencodeModel,
	claudeBin: config.claudeBin,
	claudeArgs: config.claudeArgs,
	claudeModel: config.claudeModel,
	// 技能目录：pi 只扫自己那份（~/.pi/agent/skills），我们的技能在 ~/.agents/skills。
	// 不给它，`/skill:xxx` 就不会被展开成技能正文（模型只会收到字面文本）。
	skillPaths: [defaultSkillsDir()],
	// 子代理模板目录：pi 与 codex 共用同一份（codex 的 spawn 类型就是这些模板）
	subagentAgentDir: piAgentDir(),
	// 「下一步建议」要几条 = 设置里「想想」的那个数：pi / codex 建会话时现读（读的是盘上的
	// settings.json，改了设置下一条会话就生效）；dsh 只能在启动时取一次（进程级 patch）
	thinkCount: () => readSettingsSync(config.dataDir).thinkCount,
	workspace: config.workspace,
	piSessions,
	onNotice: (text, level) => runtimeRef.current?.notify(text, level),
	// 引擎子进程的 stderr / 诊断输出：正常运行时它是噪声（codex、dsh 都会吐），
	// 真正要用户知道的事走 onNotice（界面提示）。所以记日志光进文件，别占终端。
	// `meta.level` 是引擎自己标的等级（provider 报错 / 自动重试等），没标就按 info。
	onLog: (text, meta) => {
		const { level: rawLevel, ...ctx } = meta ?? {};
		const level = rawLevel === "debug" || rawLevel === "warn" || rawLevel === "error" ? rawLevel : "info";
		logger[level](text, Object.keys(ctx).length > 0 ? ctx : undefined);
	},
});
const engineCatalog = engineWiring.catalog;
const resolved = engineWiring.resolved;
const engine: EnginePort = resolved.engine;

/** 引擎在 runtime 建好之前就会创建，用一个 ref 把「通知」转发给界面 */
/** provider 配置存储（ADR-0025）：复用 pi 自己的 models-store.json / auth.json */
const providerStore = createProviderStore({ agentDir: piAgentDir(), now: Date.now });
/** 启动时的配置补齐（main 里会 await 它：避免和价格索引抢着读同一个文件） */
const catalogMigration = migrateStoreToCatalog(piAgentDir()).then((migrated) => {
	if (migrated.length > 0) logger.info("已把老 provider 补进 models.json", { providers: migrated });
});
const enabledStore = createEnabledStore({ agentDir: piAgentDir() });
const pushStore = createPushStore({
	dataDir: config.dataDir,
	now: Date.now,
	// 推送失败只进日志（`失败 403` 这种状态码看不出病因，body 里的
	// `BadJwtToken` / `VapidPkHashMismatch` 才是）；它也不该弹成界面提示 ——
	// 回合结束时用户可能根本不在电脑前。
	log: (message, meta) => logger.warn(message, meta),
});

const runProviderRequest = createProviderWiring({
	store: providerStore,
	logger,
	probe: probeProvider,
	enabled: enabledStore,
	catalog: () => engineCatalogProviders(),
	getRuntime: () => runtime,
});

/**
 * 引擎目录里的 provider（含**没配 key** 的）：拼「官方内置服务商」用。
 * 引擎不支持（codex / dsh / opencode / claude）就当没有 —— 那些引擎的模型不归 pi 的目录管。
 */
const engineCatalogProviders = async (): Promise<EngineProviderCatalogEntry[]> =>
	(await engine.listProviderCatalog?.()) ?? [];

const runtimeRef: { current: { notify: (text: string, level?: "info" | "warn" | "error") => void } | null } = {
	current: null,
};
/** 懒读：provider 列表里要带上内置 provider 分组，而那需要 runtime 里的模型表 */
const providerList = async () => {
	const pool = await providerPool({ models: runtime?.state().models ?? [], catalog: engineCatalogProviders });
	const list = await providerStore.list(pool);
	const live = runtime?.state();
	if (live) live.enabledModels = await enabledStore.read();
	return list;
};

const runtime = createRuntime({
	engine,
	// 自定义 provider 来自 models-store.json；不主动读一次，界面上就只剩内置的那几个
	loadProviders: providerList,
	onTurnFinished: (info) => notifyTurnFinished(pushStore, info),
	rules: createFileRuleStore(config.dataDir),
	// 启动信息只进日志，不进对话流
	onStartupInfo: (text) => logger.info(text),
	workspace: config.workspace,
	engineName: resolved.descriptor.name,
	engineCapabilities: resolved.descriptor.capabilities,
	// 默认审批模式（ADR-0034 默认 allow；AGENT_WEB_APPROVAL_MODE=ask 可改）
	approvalMode: config.approvalMode,
	turnTimeoutMs: config.turnTimeoutMs,
	settings: createFileSettingsStore(config.dataDir),
	// 子代理模板落 ~/.pi/agent/agents（pi 读的就是这套 md 模板）
	subagentAgentDir: piAgentDir(),
	uploadStore: {
		read: (id) => uploadStore.read(id),
		pathOf: (id) => join(uploadsDir(config.dataDir), id),
	},
	piSessions: engineCatalog.sessionsFor(resolved.descriptor.name) ?? undefined,
	engines: engineCatalog,
	emit: {
		snapshot: (snapshot) => sender.pushSnapshot(snapshot),
		event: (event) => {
			broadcast(JSON.stringify(event));
		},
	},
});

runtimeRef.current = runtime;

/** SSE 连接（纯 HTTP 通道）：clientId → 写入函数（每客户端一份快照，ADR-0033） */
const sinks = new Map<string, Sink>();

const fanOut = (snapshot: Parameters<typeof fanOutSnapshot>[0]) =>
	fanOutSnapshot(snapshot, { sinks, snapshotFor: (id) => runtime.snapshotFor(id) });

/** 广播给所有 SSE 连接（WS 通道已移除，见文件头） */
function broadcast(payload: string): void {
	for (const sink of sinks.values()) sink(payload);
}

async function dispatchRequest(socket: ClientSink, raw: string, clientId?: string): Promise<void> {
	await handleMessage(socket, raw, {
		runtime,
		...(clientId ? { clientId } : {}),
		reply,
		sender,
		logger,
		runProviderRequest: (request, respond) => runProviderRequest(request, (result) => respond(result)),
	});
}

function reply(
	socket: ClientSink,
	id: string,
	result: { ok: true; result?: unknown } | { ok: false; error: ProtocolError },
): void {
	const message: ServerReply = result.ok
		? { type: "reply", id, ok: true, ...(result.result === undefined ? {} : { result: result.result }) }
		: { type: "reply", id, ok: false, error: result.error };
	socket.send(JSON.stringify(message));
}

// ------------------------------ HTTP ------------------------------

const app = express();
// 登录端点必须挂在鉴权**之前**：此刻还没有 cookie，不能要求先过鉴权（ADR-0031 修订）
const passwordStore = createPasswordStore(config.password, join(config.dataDir, "password"));
registerAuthRoutes(app, {
	getPassword: () => passwordStore.get(),
	setPassword: (password) => passwordStore.set(password),
	brandName: BRAND_NAME,
});
// 鉴权其次：本机放行，其它来源必须过密码；页面请求给登录页，接口请求给 401
app.use(
	authMiddleware({
		getPassword: () => passwordStore.get(),
		brandName: BRAND_NAME,
		originPolicy: policy,
	}),
);
app.use(express.json()); // 终端/技能/导入要读 body
const webDist = pickExisting(webDistCandidates(HERE), existsSync);
// 压缩 + 缓存头必须在 **API 路由注册之前** 挂：Express 按注册顺序匹配中间件，
// 挂在后面就只影响之后注册的路由 —— `/api/rpc`（快照帧）这类大包会一直裸奔。
// SSE / 终端流 / Range 媒体在 compress.ts 里显式跳过（不能攒、不能压）。
app.use(compressText());
app.use(immutableAssets());
const uploadStore = createUploadStore({ dataDir: config.dataDir });
registerUploadRoutes(app, { uploadStore, logger }); // 附件（ADR-0020 §P3）
// 网页代理（ADR-0047）：必须挂在鉴权之后 —— 它是「拿你的网络身份去取任意网页」的入口
registerWebProxyRoutes(app, { log: (text) => logger.warn(text) });

const workspaceOf = () => runtime.state().files?.root ?? config.workspace;

/**
 * 插件 / MCP 面板：**按当前引擎**取后端（这次修的正是这里 ——
 * 以前只有一个固定的 pi store，切到 codex 之后面板还在读写 pi 的配置）。
 *
 * 各引擎的真实落点：
 *   - pi     → `~/.pi/agent/settings.json` / `mcp.json`（原有实现，一字未改）
 *   - codex  → app-server：`plugin/list`、`config/read`、`mcpServerStatus/list`，
 *              写回 `~/.codex/config.toml`（同一个 app-server 子进程，不另开）
 *   - claude → `~/.claude/settings.json`（插件开关）/ `~/.claude.json`（MCP）
 *   - opencode → `opencode.json`（插件数组 + `mcp` 表）
 *   - dsh    → 面板如实说「还没接」，不拿别人的配置冒充
 */
const pluginStores: Record<string, PluginStore> = {
	pi: createPluginStore({ agentDir: piAgentDir() }),
	codex: createCodexPluginStore({
		client: engineWiring.codexClient,
		configPath: codexConfigPath(config.codexHome),
		log: (text) => logger.warn(text),
	}),
	claude: createClaudePluginStore({ log: (text) => logger.warn(text) }),
	opencode: createOpencodePluginStore({ log: (text) => logger.warn(text) }),
	dsh: createNonePluginStore("dsh", "dsh 没有插件概念：扩展走它的 profile / patch 机制（~/.dsh）"),
};
const pluginStoreFor = (engineName: string): PluginStore =>
	pluginStores[engineName] ?? createNonePluginStore(engineName, `${engineName} 没有接入插件面板`);

const mcpStores: Record<string, McpStore> = {
	pi: createMcpStore({ agentDir: piAgentDir(), login: createMcpLogin({ agentDir: piAgentDir() }) }),
	codex: createCodexMcpStore({
		client: engineWiring.codexClient,
		home: config.codexHome,
		log: (text) => logger.warn(text),
	}),
	claude: createClaudeMcpStore({ log: (text) => logger.warn(text) }),
	opencode: createOpencodeMcpStore({ log: (text) => logger.warn(text) }),
	dsh: createNoneMcpStore("dsh", "dsh 的 MCP 配置还没接：它读自己 profile 里的配置（~/.dsh）"),
};
const mcpStoreFor = (engineName: string): McpStore =>
	mcpStores[engineName] ?? createNoneMcpStore(engineName, `${engineName} 没有接入 MCP 面板`);

registerAuxRoutes(app, {
	providerStore,
	// 「官方内置」provider 的模型 / 端点在引擎目录里，测连与拉模型都要它
	builtinProviders: () => providerPool({ models: runtime?.state().models ?? [], catalog: engineCatalogProviders }),
	workspaceOf,
	projects: () => runtime.state().piProjects,
	deleteSession: (id, options) => runtime.deleteSession(id, options),
	pushStore,
	// 订阅服务（OAuth）：引擎没有这个能力时界面上那一块不画
	providerAuth: engine.providerAuth,
	// 模型测速（模型面板的「测速」按钮）：交给当前引擎开一次性会话跑 ping
	probeModel: (modelId) => runtime.probeModel(modelId),
	// 插件 / MCP：按当前引擎分发（见上面 pluginStores / mcpStores 的注释）
	engineOf: () => runtime.state().engine,
	pluginStoreFor,
	mcpStoreFor,
	// MCP 市场：公开注册中心，1 小时磁盘缓存（数据目录下的 mcp-market/）
	mcpMarket: createMcpMarket({ dataDir: config.dataDir }),
	notify: (text, level) => runtime.notify(text, level),
	log: (message, meta) => logger.info(message, meta),
	onChange: () => runProviderRequest({ type: "list_providers" }, () => {}),
});

/**
 * 优雅停机端点（`aw stop` 先敲这里，超时才强杀）。
 *
 * 为什么必须有：**Windows 上没有可捕获的 SIGTERM**（`process.kill` 映射成
 * TerminateProcess，`shutdown()` 根本不会跑）—— 只靠信号停服务，在 Windows 上
 * 就一定会切断正在落盘的转录。这个口子挂在鉴权之后（本机回环直接放行），
 * 与它旁边那些「能跑任意命令」的接口同属一个信任边界。
 */
app.post("/api/shutdown", (_request, response) => {
	response.json({ ok: true });
	// 先把响应发出去，下一轮事件循环再关：否则客户端只会看到连接被掐断
	setTimeout(() => void shutdown("api"), 20);
});

registerLiveRoutes(app, {
	sinks,
	snapshotFor: (clientId) => runtime.snapshotFor(clientId),
	clientTracker: { setSlim: runtime.clientView.setSlim, drop: runtime.clientView.drop },
	logger,
	handleMessage: async (clientId, shim, raw) => {
		await dispatchRequest(shim, raw, clientId);
	},
});

registerHealthAndStatic(app, {
	workspace: config.workspace,
	engine: config.engine,
	webDist,
	devWebPort: DEV_WEB_PORT,
	counts: () => ({
		sessions: runtime.state().piProjects.reduce((total, project) => total + project.sessions.length, 0),
		conversations: runtime.state().conversations.length,
	}),
});

const httpServer = createServer(app);

// 客户端请求分发在 ws/handle-message.ts（index 只负责装配）

// ---------------------------------------------------------------------------
// 启动
// ---------------------------------------------------------------------------

// ============================================================================
// 启动提示（前台）
// ============================================================================

/** 只在真终端上上色：管道 / 重定向 / 日志里不能带 ANSI */
function paint(format: Parameters<typeof styleText>[0], text: string): string {
	return process.stdout.isTTY && !process.env.NO_COLOR ? styleText(format, text) : text;
}

/**
 * 终端显示宽度：双宽字符（中日韩 / 全角）算 2 列。
 *
 * `padEnd` 数的是**字符**，而 `-P <密码>` 里的中文占 4 列 —— 直接用 padEnd，那一行的说明列
 * 会比其它行往右偏 3 格，看着就是错的。
 */
function displayWidth(text: string): number {
	let width = 0;
	for (const char of text) {
		const code = char.codePointAt(0) ?? 0;
		const wide =
			(code >= 0x1100 && code <= 0x115f) || // 韩文字母
			(code >= 0x2e80 && code <= 0xa4cf) || // CJK 部首 … 巫文（含全角空格）
			(code >= 0xac00 && code <= 0xd7a3) || // 韩文音节
			(code >= 0xf900 && code <= 0xfaff) || // CJK 兼容表意
			(code >= 0xfe30 && code <= 0xfe6f) || // CJK 兼容形式
			(code >= 0xff00 && code <= 0xff60) || // 全角标点 / 字母
			(code >= 0xffe0 && code <= 0xffe6); // 全角符号
		width += wide ? 2 : 1;
	}
	return width;
}

/** 按显示宽度右补空格（对齐用） */
function padToWidth(text: string, width: number): string {
	return text + " ".repeat(Math.max(0, width - displayWidth(text)));
}

/**
 * 前台启动后的那一屏：版本 + 地址 + 四条常用命令。
 *
 * 为什么是「命令在左、说明在右」：命令这一列能对齐就好看；说明列里中文多，所以只左对齐。
 * 文案统一用英文：终端里混排中英在等宽字体下宽度不好算（`padToWidth` 只做兜底）。
 */
function printStartBanner(options: { cli: string; version: string; url: string }): void {
	const { cli, version, url } = options;
	const COMMAND_WIDTH = 32;
	const row = (command: string, note: string) =>
		`  ${paint("cyan", padToWidth(command, COMMAND_WIDTH))} ${paint("dim", note)}`;
	console.log("");
	console.log(`  ${paint("bold", `oh-my-agent-web ${version}`)}  ${paint("dim", "·")}  ${paint("green", "started")}`);
	console.log(`  ${paint("underline", url)}  ${paint("dim", "(Ctrl-C to exit)")}`);
	console.log("");
	console.log(row(`${cli} -d`, "run in background (logs to daemon.log)"));
	console.log(row(`${cli} restart  /  ${cli} stop`, "restart / stop"));
	console.log(row(`${cli} -H 0.0.0.0 -P <password>`, "remote access (password required)"));
	console.log(row(`${cli} --help`, "all options"));
	console.log("");
}

async function main(): Promise<void> {
	// 旧数据目录（~/.agent-web）自动搬到新目录：dev 直接跑本文件时也要搬
	migrateLegacyDataDir({ dataDir: config.dataDir, log: (line) => logger.info(line) });
	const problems = [...envProblems, ...validateConfig(config, { home: homedir() })];
	if (problems.length > 0) {
		for (const problem of problems) logger.error(`启动自检失败：${problem}`);
		process.exit(1);
	}

	// 「家目录不能当工作区」的回落：把那个目录建出来，否则文件树一打开就是红的
	if (workspaceFallback) {
		try {
			mkdirSync(config.workspace, { recursive: true });
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			logger.error(`启动自检失败：建不出回落工作区 ${config.workspace}：${message}`);
			process.exit(1);
		}
	}
	for (const note of envNotes) logger.warn(note);

	const writable = await checkDataDirWritable(config.dataDir);
	if (!writable.ok) {
		logger.error(`启动自检失败：${writable.reason}`);
		process.exit(1);
	}

	// 日志自己也住在数据目录里 → 确认可写之后再挂文件 sink
	fileSink = createRotatingFileSink({ file: logFileName(config.dataDir), onError: (message) => logger.warn(message) });

	// 单实例锁（ADR-0007）：必须在读/写任何会话数据之前拿到
	const acquired = await acquireLock(config.dataDir, { pid: process.pid, port: config.port, startedAt: Date.now() });
	if (!acquired.ok) {
		logger.error("已经有一个 agent-web 在跑，本进程退出", { holder: describeHolder(acquired.holder) });
		console.error(`\n已经有一个 agent-web 在这个数据目录上跑着：\n  ${describeHolder(acquired.holder)}\n`);
		console.error(`  → 打开它：http://127.0.0.1:${acquired.holder.port}`);
		console.error("  → 或者先停掉它（前台运行时 Ctrl-C 即可）\n");
		process.exit(1);
	}
	if (acquired.stale && acquired.previous) {
		logger.warn("接管陈旧锁（上一个进程已不在）", { previous: describeHolder(acquired.previous) });
	}

	const { conversations } = await runtime.init().then(() => ({ conversations: runtime.state().conversations }));
	// 分时价格索引（ADR-0026 D 期）：要在读历史 / 算账之前就绪；读不到就是空表 = 全部走引擎给的 cost
	await catalogMigration.catch(() => undefined);
	await refreshPriceIndex(piAgentDir());
	void runProviderRequest({ type: "list_providers" }, () => {}); // 启动先填一次 provider 列表
	logger.info("会话索引已装载", { conversations: conversations.length });

	/**
	 * 监听。开发态（`AGENT_WEB_DEV=1`，dev.mjs 传）对 EADDRINUSE 短暂重试：
	 * `tsx --watch` 改文件就重启，新进程经常赶在**旧进程还没放开端口**时就 listen ——
	 * 以前直接报「已被占用」退出，而 tsx 那边只说 `Failed running … Waiting for file changes`，
	 * 于是后端就真的没了：界面上每个请求都是 502（Vite 反代连不上 25258），
	 * 红条一直挂着，直到你再改一个文件把它撞活。这里把这个窗口吃掉。
	 * 生产态不变：该报错就报错、退出。
	 */
	const devRetry = process.env.AGENT_WEB_DEV === "1";
	for (let attempt = 0; ; attempt += 1) {
		try {
			await new Promise<void>((resolve, reject) => {
				const onError = (error: NodeJS.ErrnoException) => {
					httpServer.off("listening", onListening);
					reject(error);
				};
				const onListening = () => {
					httpServer.off("error", onError);
					resolve();
				};
				httpServer.once("error", onError);
				httpServer.once("listening", onListening);
				httpServer.listen(config.port, config.host);
			});
			break;
		} catch (error) {
			const code = (error as NodeJS.ErrnoException).code;
			if (devRetry && code === "EADDRINUSE" && attempt < 20) {
				if (attempt === 0) logger.warn("端口还占着（多半是上一个开发进程没退干净），等它放开…", { port: config.port });
				await new Promise<void>((resolve) => setTimeout(resolve, 300).unref?.());
				continue;
			}
			logger.error(
				describeListenError(
					error as NodeJS.ErrnoException,
					config.port,
					"可能是另一个 agent-web 或别的程序占着这个端口",
				),
			);
			await releaseLock(config.dataDir, process.pid);
			process.exit(1);
		}
	}

	if (foreground) {
		// 正常日志已经不在终端刷了，这屏就是「真的跑起来了」 + 最常用的几条命令。
		// 命令名照用户实际敲的那个（aw / agent-web / oh-my-agent-web），由 cli.ts 传进来。
		const shownHost =
			config.host === "0.0.0.0" || config.host === "::" || config.host === "" ? "127.0.0.1" : config.host;
		printStartBanner({
			cli: process.env.AGENT_WEB_CLI_NAME || "aw",
			version: packageMeta().version,
			url: `http://${shownHost}:${config.port}`,
		});
	}

	/**
	 * 「有没有新版」：前台启动时印在启动那屏（banner）**下面**。
	 *
	 * 以前在 cli.ts 里等 `await import("./index.js")` 之后才印 —— 结果它跑到了 banner
	 * **上面**（而且与启动日志交错），很容易让人以为没有这个功能。
	 *
	 * `AGENT_WEB_UPDATE_NOTICE=1` 由 cli.ts 只在前台分支里设：后台（`-d`）那一路的提示是
	 * CLI 在终端上自己印的，这里不能再印一份到 daemon.log。
	 * 不 await：查到再印；查不到（离线 / 关掉了 / 本来就是最新）就什么都不说，
	 * 绝不拖慢启动（update-check 自己有 1.5s 超时）。
	 */
	if (process.env.AGENT_WEB_UPDATE_NOTICE === "1") {
		void checkForUpdate({ dataDir: config.dataDir })
			.then((result) => {
				const line = describeUpdate(result);
				if (line) console.log(`  ${paint("yellow", line)}`);
			})
			.catch(() => undefined);
	}

	logger.info("agent-web 已启动", {
		url: `http://${config.host}:${config.port}`,
		workspace: config.workspace,
		dataDir: config.dataDir,
		engine: config.engine,
		protocolVersion: PROTOCOL_VERSION,
		conversations: runtime.state().conversations.length,
	});
	// 对外开放但还没设密码：远程会全部被拒（且只能在本机设密码）—— 先把话说清楚
	if (!passwordStore.get() && !isLoopbackHostname(config.host)) {
		logger.warn("还没设访问密码：远程访问一律不开，先在本机打开一次设上它（或 `-P` 启动）", {
			host: config.host,
		});
	}
	if (!webDist) {
		logger.info("前端未构建，开发态请访问", { vite: `http://127.0.0.1:${DEV_WEB_PORT}` });
	}

	setInterval(() => sender.tick(Date.now()), TICK_MS);
}

async function shutdown(signal: string): Promise<void> {
	if (shuttingDown) return;
	shuttingDown = true;
	logger.info("收到退出信号，正在关闭", { signal });
	sender.flush(Date.now());
	engineWiring.close(); // 收掉 codex app-server 子进程（不给它留孤儿）
	httpServer.close();
	// 锁要还回去：只有还属于自己时才删（避免删掉接管者的锁）
	await releaseLock(config.dataDir, process.pid);
	process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));

main().catch((error: unknown) => {
	logger.error("启动失败", { message: error instanceof Error ? error.message : String(error) });
	process.exit(1);
});
