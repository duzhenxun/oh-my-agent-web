/**
 * DeepSeek 语音识别（`POST /v1/tools/asr`）。
 *
 * 官方文档：https://api-docs.deepseek.com/zh-cn/guides/asr/
 *
 * 形状比多数厂商都干净：multipart 传一个 16 位 PCM WAV（或 Ogg Opus），回来
 * `{ request_id, text, duration_ms }` —— 正好和这里「整段识别」的模型一致
 * （`session.text` 在 `end()` 之前是空串，说的时候不出字）。
 *
 * 两条硬限制，代码里都兜住了：
 *   · **单请求最长 120 秒、最大 8 MiB** —— 超过就分段发、拼起来（见 `SEGMENT_SECONDS`）；
 *   · 不支持流式 —— 想要边说边出字得换厂商，这不是配置能解决的。
 *
 * 语种不传，服务端按音频自动判断。
 */
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";
import { pcmToWav } from "./openai.js";

export const DEEPSEEK_ASR_ENDPOINT = "https://api.deepseek.com/v1/tools/asr";
/** 输入是 16k 单声道 int16（见 server/asr/service.ts 的采音链路） */
const SAMPLE_RATE = 16_000;
const BYTES_PER_SECOND = SAMPLE_RATE * 2;
/** 文档上限 120s；留 10s 余量，别卡在边界上被拒 */
const SEGMENT_SECONDS = 110;
/** 太短的不值得发一次请求（静音误触） */
const MIN_BYTES = 3_200;

/**
 * 准实时（增量识别）的参数。
 *
 * DeepSeek 的 ASR **没有流式接口**（官方文档：「一次请求发送完整音频，返回完整转写文本，
 * 不支持流式识别」），所以想让文字边说边出，只能反复把**已经录到的音频**整段送一次。
 *
 * 代价是重复计费（按音频时长算），所以这里用**指数退避**：1.5s、3s、6s、12s、15s…
 * 一句 30 秒的话大约算 2 倍时长的钱，换来到说完为止一直在出字。
 */
const INCREMENTAL_FIRST_MS = 1_500;
const INCREMENTAL_MAX_GAP_MS = 15_000;
/** 至少攒够这么多新音频才值得再发一次（1 秒） */
const INCREMENTAL_MIN_NEW_BYTES = BYTES_PER_SECOND;
/** 超过这个时长就不再增量了（再往后重复计的费太贵，交给 end() 整段识别） */
const INCREMENTAL_MAX_SECONDS = 60;

function endpointOf(config: SttConfig): string {
	return config.endpoint?.trim() || DEEPSEEK_ASR_ENDPOINT;
}

/** 分段拼接：中文之间不加空格，英文/数字之间留一个空格，免得粘成一个词 */
function joinSegments(parts: string[]): string {
	return parts
		.filter((part) => part !== "")
		.reduce((acc, part) => {
			if (!acc) return part;
			const needsSpace = /[A-Za-z0-9]$/.test(acc) && /^[A-Za-z0-9]/.test(part);
			return needsSpace ? `${acc} ${part}` : `${acc}${part}`;
		}, "");
}

async function transcribe(
	wav: Buffer,
	config: SttConfig,
	log: SttLogger,
	signal: AbortSignal,
): Promise<string> {
	const form = new FormData();
	form.append("file", new Blob([wav], { type: "audio/wav" }), "utterance.wav");
	const headers: Record<string, string> = { ...config.headers };
	if (config.apiKey && !Object.keys(headers).some((key) => key.toLowerCase() === "authorization")) {
		headers.Authorization = `Bearer ${config.apiKey}`;
	} else if (!config.apiKey && !headers.Authorization) {
		throw new Error("DeepSeek ASR 还没配密钥：在 ~/.oh-my-agent-web/stt.json 里填 providers.deepseek.apiKey");
	}
	if (config.language) {
		// 这家没有语种参数（自动判断）：写了也不发，只在日志里提醒一句，免得以为生效了
		log.warn("DeepSeek ASR 不支持 language 参数，已忽略", { language: config.language });
	}

	const response = await fetch(endpointOf(config), { method: "POST", headers, body: form, signal }).catch((error: unknown) => {
		// undici 的原始报错只有一句「fetch failed」，真正的理由（DNS / 证书 / 连接被重置）
		// 在 error.cause 里 —— 不带出来就没法排查，用户也只能看到「识别失败」四个字
		const cause = (error as { cause?: { code?: string; message?: string } }).cause;
		const detail = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
		throw new Error(`连接 DeepSeek 失败（${detail}）`);
	});
	const raw = await response.text();
	if (!response.ok) {
		log.warn("DeepSeek 识别失败", { status: response.status, body: raw.slice(0, 300) });
		const detail = raw.trim().slice(0, 160);
		if (response.status === 400) throw new Error("DeepSeek 不接受这段音频（要 16 位 PCM WAV 或 Ogg Opus）");
		if (response.status === 401 || response.status === 403) {
			throw new Error("DeepSeek 密钥无效或没有语音识别权限：检查 ~/.oh-my-agent-web/stt.json 的 providers.deepseek.apiKey");
		}
		if (response.status === 413) throw new Error("这段音频超过 DeepSeek 的 8 MiB 上限");
		if (response.status === 429) throw new Error("DeepSeek 同时进行的识别请求数超限，稍等再试");
		if (response.status === 504) throw new Error("DeepSeek 识别超时");
		throw new Error(`DeepSeek 识别失败（HTTP ${response.status}）${detail ? `：${detail}` : ""}`);
	}
	try {
		const parsed = JSON.parse(raw) as { text?: unknown };
		if (typeof parsed.text === "string") return parsed.text.trim();
	} catch {
		// 不是 JSON：落到下面当错误报出来，别把整段响应塞进输入框
	}
	throw new Error(`DeepSeek 返回了看不懂的内容：${raw.slice(0, 200)}`);
}

export const deepseekStt: SttProvider = {
	id: "deepseek",
	label: "DeepSeek 语音识别",
	defaultEndpoint: DEEPSEEK_ASR_ENDPOINT,
	fields: [
		{ key: "apiKey", label: "API Key", required: true, secret: true, placeholder: "sk-…" },
		{ key: "endpoint", label: "转写端点", placeholder: DEEPSEEK_ASR_ENDPOINT },
	],

	create(config: SttConfig, log): SttSession {
		let chunks: Buffer[] = [];
		let bytes = 0;
		let text = "";
		let cancelled = false;
		/** 已经进 end() 了：不再排新的增量请求（否则收尾之后还会多打一次官方接口） */
		let closed = false;
		const controller = new AbortController();
		/** 给每次请求一个「可取消 + 超时」的信号 */
		const signalFor = () =>
			AbortSignal.any([controller.signal, AbortSignal.timeout(config.timeoutMs ?? 60_000)]);

		/* ---- 增量识别（准实时出字）的状态 ---- */
		const incremental = config.incremental !== false;
		let firstGap = Math.min(Math.max(config.incrementalMs ?? INCREMENTAL_FIRST_MS, 500), 10_000);
		let timer: ReturnType<typeof setTimeout> | undefined;
		let inFlight: Promise<void> | null = null;
		/** 上一次发出去时录到的字节数（用来判断有没有新音频） */
		let sentBytes = 0;

		const stopTimer = () => {
			if (timer !== undefined) {
				clearTimeout(timer);
				timer = undefined;
			}
		};

		const schedule = (delay: number) => {
			if (cancelled || closed || !incremental || timer !== undefined) return;
			timer = setTimeout(tick, delay);
		};

		const tick = () => {
			timer = undefined;
			if (cancelled || closed) return;
			// 上一次还没回来：等它结束时会自己安排下一拍（见 finally）
			if (inFlight) return;
			if (bytes > INCREMENTAL_MAX_SECONDS * BYTES_PER_SECOND) return; // 太长了，不再重复发
			if (bytes - sentBytes < INCREMENTAL_MIN_NEW_BYTES) {
				schedule(400);
				return;
			}
			const snapshot = Buffer.concat(chunks);
			const at = bytes;
			inFlight = transcribe(pcmToWav(snapshot), config, log, signalFor())
				.then((result) => {
					// 增量结果直接替换：整段识别的后一次结果总是更完整的
					if (!cancelled && result) text = result;
				})
				.catch((error: unknown) => {
					// 增量失败不该影响最终结果（真正的错会在 end() 里报出来）
					log.warn("DeepSeek 增量识别失败（忽略）", {
						message: error instanceof Error ? error.message : String(error),
					});
				})
				.finally(() => {
					inFlight = null;
					sentBytes = at;
					// 指数退避：越往后重复计的费越贵
					firstGap = Math.min(firstGap * 2, INCREMENTAL_MAX_GAP_MS);
					schedule(firstGap);
				});
		};

		return {
			get text() {
				return text;
			},

			push(pcm: Buffer) {
				if (cancelled || pcm.length === 0) return;
				chunks.push(pcm);
				bytes += pcm.length;
				// 第一块音频到了就开始排期；之后由 tick 自己接力
				schedule(firstGap);
			},

			cancel() {
				cancelled = true;
				chunks = [];
				bytes = 0;
				stopTimer();
				controller.abort();
			},

			async end(): Promise<string> {
				if (cancelled) return "";
				closed = true;
				stopTimer();
				// 还在飞的那个增量请求不算数，但也不白等它：超时自己会断
				await inFlight?.catch(() => undefined);
				const pcm = Buffer.concat(chunks);
				chunks = [];
				bytes = 0;
				if (pcm.length < MIN_BYTES) return text;
				// 一段一句话：超过单请求时长上限的，切成几段依次发（一段失败就算整句失败，
				// 不偷偷返回半句 —— 半句输进输入框比没有更难受）
				const segmentBytes = SEGMENT_SECONDS * BYTES_PER_SECOND;
				const parts: string[] = [];
				for (let offset = 0; offset < pcm.length; offset += segmentBytes) {
					const slice = pcm.subarray(offset, Math.min(offset + segmentBytes, pcm.length));
					parts.push(await transcribe(pcmToWav(slice), config, log, signalFor()));
				}
				// 最终结果覆盖增量结果（增量可能只到半句）
				text = joinSegments(parts);
				return text;
			},
		};
	},
};
