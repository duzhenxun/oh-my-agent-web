/**
 * 云端语音识别（STT）的 provider 扩展点。
 *
 * 为什么需要它：桌面 App（Electron）里的 Web Speech 是死的 —— Electron 用开源
 * Chromium，不含 Google 的语音后端，配 GOOGLE_API_KEY 也没用（实测三种配置都只回
 * `error:network`）。想在 App 里用云端识别，只能由**服务端**把音频转发给某个 STT API。
 *
 * 这一层刻意做成「配置驱动 + 一个 provider 一个文件」：
 *   · 内置 `openai-compatible`（Whisper 以及大量厂商/网关的兼容端点都认）
 *   · 火山豆包、阿里千问这类签名协议不同的，再加一个 provider 文件并在 registry 注册即可，
 *     不用碰 server/asr/bridge.ts
 *
 * 配置落在 `~/.oh-my-agent-web/stt.json`（0600），形状见 `SttConfig`。
 */

type Logger = { warn: (message: string, ctx?: Record<string, unknown>) => void };

export type SttConfig = {
	/** 用哪个 provider；留空或不写 = 继续用本地识别（SFSpeech） */
	provider: string;
	/** 完整端点，例如 https://api.openai.com/v1/audio/transcriptions */
	endpoint: string;
	/** 鉴权用的 key。默认发成 `Authorization: Bearer <key>` */
	apiKey?: string;
	/** 额外请求头：火山/阿里这类要自己算签名的场景塞这里 */
	headers?: Record<string, string>;
	/** 模型名，例如 whisper-1 / paraformer-v2 */
	model?: string;
	/** 语音语言（ISO-639-1，如 zh / en） */
	language?: string;
	/** 额外表单字段：各家参数差异全塞这里，不用为每个参数改代码 */
	extraFields?: Record<string, string>;
	/** 一次识别的超时（毫秒），默认 60s */
	timeoutMs?: number;
	/**
	 * 是否在录音过程中就把已录音频送上去、边出边显示文字（默认开）。
	 * 只对**没有流式接口**的厂商有意义（如 DeepSeek）：靠反复整段识别模拟出字。
	 * 关掉 = 只在 end() 时识别一次，省钱但说完才出字。
	 */
	incremental?: boolean;
	/** 第一次增量识别的延迟（毫秒），默认 1500；之后指数退避到 15s */
	incrementalMs?: number;
};

/** 一次「说一句话」的会话：push 音频，end 拿文本 */
export type SttSession = {
	/** 追加一块 16kHz 单声道 int16 小端 PCM */
	push(pcm: Buffer): void;
	/** 结束这句，返回识别文本（失败抛错，由调用方决定退回本地还是报错） */
	end(): Promise<string>;
	/** 目前能给出的最新文本（流式 provider 才有；整段识别在 end 之前一直是空串） */
	readonly text: string;
	/** 丢弃这段音频（用户取消） */
	cancel(): void;
};

/** provider 需要的配置字段：第一版靠配置文件，将来做 UI 时直接拿来渲染表单 */
export type SttField = {
	key: keyof SttConfig;
	label: string;
	required?: boolean;
	placeholder?: string;
	/** 这个字段要不要当密钥处理（UI 里打码、日志里绝不打印） */
	secret?: boolean;
};

export type SttProvider = {
	/** 配置文件里 `provider` 填的值 */
	id: string;
	label: string;
	/** 不写 endpoint 时用它（厂商官方端点）；不提供 = endpoint 必填 */
	defaultEndpoint?: string;
	/**
	 * 这家有哪些可选模型（面板做成下拉，不用让用户手敲模型名）。
	 * 只能列官方确认过的；不列也不影响手填，只是面板里少几个候选项。
	 */
	models?: readonly string[];
	fields: SttField[];
	create(config: SttConfig, log: Logger): SttSession;
};

export type { Logger as SttLogger };
