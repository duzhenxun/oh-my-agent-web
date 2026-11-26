/**
 * 本地语音识别（macOS 原生 SFSpeechRecognizer，离线）的服务端这一半。
 *
 * 2026-11 合并：原先这里会自己 bind 一个 unix socket、再用
 * `open -n -a ASRBridge.app` 拉起一支独立的桥进程。识别能力现在搬进了
 * Agent Computer helper（`helper/agent-computer`），走它已有的 JSON-RPC：
 *
 *   asr.status → { authorized, locale, onDevice, message }
 *   asr.start  → 触发系统授权 + 建识别器 + 开一句
 *   asr.feed   → 送一块 base64 的 PCM16，返回当前 partial
 *   asr.end    → 结束这句，等 final 落地（超时就用已有结果）
 *   asr.cancel → 丢弃当前这句
 *
 * 对外的 7 个方法（current / latestText / ensureStarted / startUtterance /
 * pushAudio / endUtterance / dispose）和状态机都保持原样 —— 路由层和前端
 * 不需要跟着改语义，只是 `missing` 的含义从「ASRBridge.app 没装」变成
 * 「Agent Computer 没装/没在跑」。
 */
import { existsSync } from "node:fs";
import { HelperClient } from "../computer/helper-client.js";
import { helperBinaryPath, helperTransport, socketPath } from "../computer/paths.js";
import { startHelper } from "../computer/install-helper.js";
import { readSttConfig, readSttProviders, saveSttSelection } from "../stt/config.js";
import { createSttSession, getSttProvider, listSttProviders, sttEndpoint, sttProviderLabel } from "../stt/index.js";
import type { SttConfig, SttSession } from "../stt/types.js";

export type AsrState = "missing" | "idle" | "starting" | "authorizing" | "ready" | "error";

export type AsrStatus = {
	state: AsrState;
	/** 给人看的一句话（missing / error 时必填；authorizing 时说明要等什么） */
	message?: string;
	locale?: string;
	onDevice?: boolean;
	/** 云端识别时：用的是哪家（如 deepseek），面板直接显示出来 */
	provider?: string;
	providerLabel?: string;
};

/** 面板「云端引擎」下拉需要的东西：能选哪些、现在是谁、哪家配好了密钥 */
export type CloudEngine = {
	id: string;
	label: string;
	/** 配了密钥才算能用（千问整段 / 千问实时是两个 provider，密钥可以互借） */
	configured: boolean;
	/** 这家支不支持指定模型；支持的话默认模型写在 defaultModel */
	hasModel: boolean;
	defaultModel?: string;
	/** 已知可选的模型（面板下拉直接列；空数组 = 只能手填） */
	models: string[];
};

export type CloudEngines = {
	/** 当前生效的 provider（null = 没启用云端，走本地识别） */
	provider: string | null;
	/** 当前生效的模型（null = 用 provider 自己的默认值） */
	model: string | null;
	/** 配置读的是哪个文件 */
	source: string;
	error: string | null;
	engines: CloudEngine[];
};

/** 只声明用得到的级别：`debug` 用来把「云端已启用」这类常态事实降级成排查信息 */
type Logger = {
	debug: (message: string, ctx?: Record<string, unknown>) => void;
	warn: (message: string, ctx?: Record<string, unknown>) => void;
};

/** 一次听写最多攒多久的音频（兜底，正常一句话远小于这个数） */
const MAX_UTTERANCE_BYTES = 16 * 1024 * 1024;

const CONNECT_TIMEOUT_MS = 3000;
/** `asr.start` 可能弹系统授权框，用户不点就一直等（helper 侧 60s 兜底） */
const START_TIMEOUT_MS = 90_000;
const FEED_TIMEOUT_MS = 15_000;
const CONTROL_TIMEOUT_MS = 5000;
const CLIENT_NAME = "oh-my-agent-web-asr";

/** 日志里能安全打印的端点（配错了 / 没写都不断日志） */
function safeEndpoint(config: SttConfig): string {
	try {
		return sttEndpoint(config);
	} catch {
		return "(未解析)";
	}
}

export class AsrService {
	private readonly log: Logger;
	private client: HelperClient | null = null;
	private status: AsrStatus = { state: "idle" };
	private text = "";
	private audioBytes = 0;
	private connecting = false;
	/**
	 * feed 串行：浏览器每 ~300ms 发一块、不等响应，乱序会让 partial 倒退。
	 * cancel / end 也排在这条链上，保证「上一句收尾」一定发生在「下一句喂音频」之前。
	 */
	private chain: Promise<unknown> = Promise.resolve();
	/** 云端 STT 配置：配了就不碰本地 helper，直接转发厂商 API（见 server/stt/） */
	private cloudConfig: SttConfig | null = null;
	private cloudSession: SttSession | null = null;
	/** 面板切换引擎时要写回 stt.json，所以得记住数据目录 */
	private readonly dataDir: string | undefined;

	constructor(options: { log: Logger; dataDir?: string }) {
		this.log = options.log;
		this.dataDir = options.dataDir;
		this.cloudConfig = this.readCloud();
	}

	/**
	 * 读一次 `stt.json` 并校验。启动时用，面板切换引擎后也用它重新读。
	 */
	private readCloud(): SttConfig | null {
		const read = readSttConfig(this.dataDir);
		if (read.error) this.log.warn("云端 STT 配置读不懂，按未配置处理", { error: read.error });
		const config = read.config ? this.validateCloud(read.config, read.source) : null;
		if (config) {
			/**
			 * debug 而不是 warn（用户 2026-11-26）：前台启动每个终端都刷一行「云端语音识别已启用」纯噪声，
			 * 而它并不是异常 —— 配了 `stt.json` 就必然成立，面板里也一眼能看见当前引擎。
			 * 要确认到底连的哪家：`AGENT_WEB_LOG=debug aw`。密钥照样不打印。
			 */
			this.log.debug("云端语音识别已启用", {
				provider: config.provider,
				endpoint: safeEndpoint(config),
				model: config.model ?? "(默认)",
				source: read.source,
			});
		}
		return config;
	}

	/**
	 * 面板「云端引擎」下拉的数据源。
	 *
	 * 需要它是因为 `readSttConfig()` 只给**当前选中的那一家**，而面板要让人在
	 * 「千问整段识别 / 千问实时识别（边说边出字）」之间选 —— 两家的模型和价格都不一样。
	 */
	cloudEngines(): CloudEngines {
		const read = readSttConfig(this.dataDir);
		const { blocks } = readSttProviders(this.dataDir);
		return {
			provider: this.cloudConfig?.provider ?? null,
			model: this.cloudConfig?.model ?? null,
			source: read.source,
			error: read.error ?? null,
			engines: listSttProviders().map((provider) => {
				const block = blocks[provider.id] ?? {};
				const modelField = provider.fields.find((field) => field.key === "model");
				// 同厂商兄弟 provider 的密钥可以互借（selectorID 见 selectCloud）：
				// 只配过 `qwen` 的人也应该能直接选 `qwen-omni-realtime`，
				// 否则面板里那一项是灰的，而灰的永远点不到 —— 互借逻辑就没机会生效。
				const vendor = provider.id.split("-")[0];
				const siblingHasKey = Object.entries(blocks).some(
					([id, other]) =>
						id !== provider.id &&
						id.split("-")[0] === vendor &&
						Boolean(other.apiKey || other.headers?.Authorization),
				);
				return {
					id: provider.id,
					label: provider.label,
					configured: Boolean(block.apiKey || block.headers?.Authorization) || siblingHasKey,
					hasModel: modelField != null,
					// 字段声明里的 placeholder 就是官方默认模型（各 provider 里是这么写的）
					defaultModel: modelField?.placeholder,
					models: [...(provider.models ?? [])],
				};
			}),
		};
	}

	/**
	 * 面板上切换云端引擎：写回 `stt.json` → 丢掉缓存的会话 → 下一句就用新引擎。
	 *
	 * 同名厂商的兄弟 provider 钥匙可以互借：千问的「整段」和「实时」在百炼那边是同一把 key，
	 * 不代抄的话用户一切到实时就被判「没配密钥」，莫名其妙掉回本地识别。
	 */
	selectCloud(selection: { provider: string; model?: string | null }): CloudEngines {
		const provider = getSttProvider(selection.provider);
		if (!provider) throw new Error(`未知的识别引擎：${selection.provider}`);

		const { blocks, source } = readSttProviders(this.dataDir);
		const target = blocks[provider.id] ?? {};
		const hasKey = Boolean(target.apiKey || target.headers?.Authorization);

		// 防手滑：把别的引擎的模型填到这家身上（典型：`…-flash-message` 是实时模型的，
		// 却挂在整段识别上）。不拦的话要等厂商 API 回一个看不懂的 400/连不上。
		const model = selection.model?.trim();
		if (model) {
			const owner = listSttProviders().find(
				(candidate) => candidate.id !== provider.id && candidate.models?.includes(model),
			);
			if (owner) {
				throw new Error(
					`${model} 是「${owner.label}」的模型，先把引擎切到它（provider：${owner.id}）`,
				);
			}
		}
		const vendor = provider.id.split("-")[0];
		const siblingKey = Object.entries(blocks).find(
			([id, block]) => id !== provider.id && id.split("-")[0] === vendor && block.apiKey,
		)?.[1].apiKey;
		if (!hasKey && !siblingKey) {
			throw new Error(`${provider.label} 还没配密钥：先在 ${source} 里加 providers.${provider.id}.apiKey`);
		}

		saveSttSelection(
			{ provider: provider.id, model: selection.model, apiKey: hasKey ? undefined : siblingKey },
			this.dataDir,
		);

		// 换引擎 = 换协议：旧会话的 socket / 缓冲都不能再用
		try {
			this.cloudSession?.cancel();
		} catch {
			// 旧会话作废就够了
		}
		this.cloudSession = null;
		this.cloudConfig = this.readCloud();
		if (!this.cloudConfig) throw new Error(`${provider.label} 的配置不完整（缺端点或密钥），没有切换`);
		return this.cloudEngines();
	}

	/**
	 * 启动时就校验一遍，而不是等用户说到一半才炸在 pushAudio 里：
	 * 配错了（厂商名写错 / 缺密钥 / 缺端点）就当没配，回落到本地识别，并且日志写清原因。
	 */
	private validateCloud(config: SttConfig, source: string): SttConfig | null {
		try {
			sttEndpoint(config);
		} catch (error) {
			this.log.warn("云端 STT 配置不完整，按未配置处理", {
				source,
				message: error instanceof Error ? error.message : String(error),
			});
			return null;
		}
		if (!config.apiKey && !config.headers?.Authorization) {
			// deepseek / qwen 这类只要一个 key 的：缺了就不算配好，回落到本地识别
			this.log.warn("云端 STT 缺密钥，按未配置处理", { source, hint: `providers.${config.provider}.apiKey` });
			return null;
		}
		return config;
	}

	/** helper 在不在（内嵌二进制，或用户自己装的那份 app 的 socket） */
	private helperAvailable(): boolean {
		const binary = helperBinaryPath();
		if (binary && existsSync(binary)) return true;
		return existsSync(socketPath());
	}

	current(): AsrStatus {
		// 云端模式：不需要 helper、也不需要本地授权，直接算就绪
		if (this.cloudConfig) {
			return {
				state: "ready",
				locale: this.cloudConfig.language ?? "zh-CN",
				onDevice: false,
				provider: this.cloudConfig.provider,
				providerLabel: sttProviderLabel(this.cloudConfig.provider),
			};
		}
		// missing 不是终态：用户可能刚装好、刚把 helper 打开。以前这里直接返回缓存的
		// missing，于是「装好了，重新检测」点了毫无反应（用户实测反馈）。
		if (this.status.state === "missing" && this.helperAvailable()) {
			this.status = { state: "idle" };
		}
		if (this.status.state !== "idle") return this.status;
		// 一次都没启动过、helper 也不在：如实说「没装」，别让面板显示「就绪」
		if (this.helperAvailable()) return this.status;
		return {
			state: "missing",
			message: "本地识别已经并进 Agent Computer：先在「电脑控制」里安装并打开它，再回来试",
		};
	}

	/** 当前这句到目前为止的文字（partial 也在内） */
	latestText(): string {
		return this.text;
	}

	/**
	 * 确保 helper 连上并准备好识别器：没连就（异步）启动，然后立刻返回当前状态。
	 * **不要 await 到 ready**：首次授权要等用户在系统弹框里点一下，可能几十秒，
	 * HTTP 请求不该挂在那儿 —— 前端轮询状态即可。
	 */
	ensureStarted(): AsrStatus {
		if (this.cloudConfig) return this.current();
		if (this.client) return this.status;
		if (this.connecting) return this.status;
		this.connecting = true;
		this.status = { state: "starting" };
		void this.connect();
		return this.status;
	}

	private async connect(): Promise<void> {
		const binary = helperBinaryPath();
		const makeClient = () =>
			new HelperClient({
				socketPath: socketPath(),
				binaryPath: binary,
				transport: helperTransport(process.env, binary),
				clientName: CLIENT_NAME,
				session: { sessionId: `asr-${process.pid}`, turnId: null },
			});

		let client = makeClient();
		try {
			await client.connect(CONNECT_TIMEOUT_MS);
		} catch {
			client.close();
			// 连不上最常见的原因不是「没装」，而是**装了但没在跑**（helper 是独立 app，
			// 用户关掉了、或系统重启后没自启）。语音和电脑控制共用它，让用户自己去
			// Finder 里翻太蠢 —— 这里直接帮他把 app 打开，再试一次。
			this.log.warn("ASR：连不上 helper，尝试自动启动它");
			const started = await startHelper(this.log);
			if (!started.ok) {
				this.connecting = false;
				this.status = { state: "missing", message: started.message };
				return;
			}
			client = makeClient();
			try {
				await client.connect(CONNECT_TIMEOUT_MS);
			} catch (error) {
				client.close();
				this.connecting = false;
				this.status = {
					state: "missing",
					message: "已经尝试启动 Agent Computer，但仍连不上：到「电脑控制」面板点「启动 helper」，或看它有没有被系统拦下",
				};
				this.log.warn("ASR：自动启动后仍连不上 helper", {
					message: error instanceof Error ? error.message : String(error),
				});
				return;
			}
		}

		this.client = client;
		// 建识别器 + 开一句：首次会弹系统授权（麦克风 / 语音识别）
		try {
			const result = (await client.request("asr.start", {}, START_TIMEOUT_MS)) as {
				authorized?: boolean;
				locale?: string;
				onDevice?: boolean;
			};
			this.status = { state: "ready", locale: result?.locale, onDevice: result?.onDevice === true };
		} catch (error) {
			// 授权被拒 / 该语言不支持离线：照实报，别假装就绪
			this.status = { state: "error", message: error instanceof Error ? error.message : String(error) };
			this.log.warn("ASR：helper 拒绝启动识别", { message: this.status.message });
		} finally {
			this.connecting = false;
		}
	}

	/** 连接断了（helper 被关掉 / 崩了）：回到可重试的状态 */
	private fail(error: unknown): void {
		this.client?.close();
		this.client = null;
		this.status = {
			state: "error",
			message: "本地识别连接断了（Agent Computer 可能被关掉了），重新开始听写会自动重连",
		};
		this.log.warn("ASR：helper 请求失败", {
			message: error instanceof Error ? error.message : String(error),
		});
	}

	/** 开一段新的听写（清掉上一句的残留文字，并让 helper 丢弃上一句） */
	startUtterance(): void {
		this.text = "";
		this.audioBytes = 0;
		if (this.cloudConfig) {
			this.cloudSession?.cancel();
			this.cloudSession = null;
			return;
		}
		const client = this.client;
		if (!client) return;
		this.chain = this.chain
			.catch(() => undefined)
			.then(() => client.request("asr.cancel", {}, CONTROL_TIMEOUT_MS));
		this.chain.catch(() => undefined);
	}

	/** 送一段 16k 单声道 int16 PCM；返回当前 partial（到这块为止识别出的文字） */
	async pushAudio(pcm: Buffer): Promise<string> {
		if (this.cloudConfig) {
			if (this.audioBytes + pcm.length > MAX_UTTERANCE_BYTES) return this.text;
			this.audioBytes += pcm.length;
			this.cloudSession ??= createSttSession(this.cloudConfig, this.log);
			this.cloudSession.push(pcm);
			// 整段识别的 provider 在 end() 之前拿不到文字，所以这里一直是空串
			return this.cloudSession.text;
		}
		const client = this.client;
		if (!client || pcm.length === 0) return this.text;
		if (this.audioBytes + pcm.length > MAX_UTTERANCE_BYTES) return this.text; // 兜底：别把进程喂爆
		this.audioBytes += pcm.length;

		const audio = pcm.toString("base64");
		this.chain = this.chain.catch(() => undefined).then(async () => {
			const result = (await client.request("asr.feed", { audio }, FEED_TIMEOUT_MS)) as { text?: string };
			if (typeof result?.text === "string") this.text = result.text;
		});
		try {
			await this.chain;
		} catch (error) {
			this.fail(error);
		}
		return this.text;
	}

	/** 说完：让 helper `endAudio()`，等 final（超时就用已经识别到的部分） */
	async endUtterance(timeoutMs = 8000): Promise<string> {
		if (this.cloudConfig) {
			const session = this.cloudSession;
			this.cloudSession = null;
			if (!session) return this.text;
			try {
				this.text = await session.end();
			} catch (error) {
				// 云端挂了不该把整条语音路径弄死：这一句没结果，下一句照旧试
				this.log.warn("云端识别失败", { message: error instanceof Error ? error.message : String(error) });
			}
			return this.text;
		}
		const client = this.client;
		if (!client) return this.text;
		try {
			await this.chain.catch(() => undefined); // 先把音频送完
			const result = (await client.request(
				"asr.end",
				{ timeoutSeconds: timeoutMs / 1000 },
				timeoutMs + CONTROL_TIMEOUT_MS,
			)) as { text?: string };
			if (typeof result?.text === "string") this.text = result.text;
		} catch (error) {
			this.fail(error);
		}
		return this.text;
	}

	/** 服务端退出时收摊：只断开连接 —— helper 常驻与否由它自己的菜单栏决定，不归我们管 */
	dispose(): void {
		this.cloudSession?.cancel();
		this.cloudSession = null;
		this.client?.close();
		this.client = null;
		if (this.status.state === "ready" || this.status.state === "authorizing") {
			this.status = { state: "idle" };
		}
	}
}
