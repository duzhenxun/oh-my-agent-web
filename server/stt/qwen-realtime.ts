/**
 * 千问实时语音识别（百炼 WebSocket）：**边说边出字**。
 *
 * 为什么和 `qwen.ts` 分开两个 provider：
 *   · `qwen.ts` 是「非实时/录音识别」（HTTP，整段提交，说完才有字），便宜（≈¥0.08/小时）；
 *   · 这个是「实时识别」（WebSocket，说话过程中就往上冒字），贵一些（≈¥0.34/小时）。
 *   两者协议、模型、计费都不同，混在一个文件里只会互相干扰 —— 用户按需在 stt.json 里选。
 *
 * 协议（官方：https://help.aliyun.com/zh/model-studio/qwen-asr-message-websocket-api）：
 *   1. 连 `wss://dashscope.aliyuncs.com/api-ws/v1/inference`，头里带 `Authorization: Bearer <key>`
 *   2. 发 `run-task`（pcm / 16000 / 中间结果开 / 近场 VAD / 心跳）
 *   3. 等 `task-started`（这段时间的麦克风音频先攒着，别丢）
 *   4. 持续发二进制 PCM（16 bit 单声道小端，16k）
 *   5. 收 `result-generated`：`payload.output.sentence.text`，`sentence_end` 决定是中间结果还是定稿句
 *   6. `finish-task`（`payload.input` 必填，缺了会被拒） → `task-finished`
 *
 * 计费口径（北京，元/百万 Token）：输入 6、输出 4.5；音频按 12.5 Token/秒折算，
 * 也就是 1 小时音频≈45,000 Token≈¥0.27 + 输出。连续听写（麦克风常亮）时静音音频也计费。
 */
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";
import { coerce, socketCtor, type SocketLike } from "./ws.js";

export const QWEN_REALTIME_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/inference";
export const QWEN_REALTIME_DEFAULT_MODEL = "qwen-audio-3.1-asr-flash-message";
const SAMPLE_RATE = 16_000;
/** task-started 之前的音频先攒着；上限约 5 秒（再多就是连不上，攒着也没用） */
const MAX_BACKLOG_BYTES = SAMPLE_RATE * 2 * 5;
/** finish-task 之后等最终结果的兜底时长 */
const FINISH_TIMEOUT_MS = 8000;

export const qwenRealtimeStt: SttProvider = {
	id: "qwen-realtime",
	// 旧版 message 协议（run-task / result-generated）。要 omni 那条 Realtime 协议的话
	// 用 `qwen-omni-realtime`（模型 qwen3.8-omni-flash-realtime）—— 两者模型与端点都不通用。
	label: "千问 实时识别（旧版 ASR message 协议）",
	defaultEndpoint: QWEN_REALTIME_ENDPOINT,
	// 百炼的实时识别模型：走 WebSocket 的就是 `…-flash-message`
	models: ["qwen-audio-3.1-asr-flash-message"],
	fields: [
		{ key: "apiKey", label: "API Key（百炼）", required: true, secret: true, placeholder: "sk-…" },
		{ key: "model", label: "模型", placeholder: QWEN_REALTIME_DEFAULT_MODEL },
		{ key: "endpoint", label: "WebSocket 端点", placeholder: QWEN_REALTIME_ENDPOINT },
	],

	create(config: SttConfig, log: SttLogger): SttSession {
		let socket: SocketLike | null = null;
		let ready = false;
		let cancelled = false;
		let closed = false;
		/** 已定稿的句子拼起来的文本 */
		let stable = "";
		/** 正在说的这句（中间结果，整份替换） */
		let current = "";
		let backlog: Buffer[] = [];
		let backlogBytes = 0;
		let failure: string | null = null;
		let settleFinish: (() => void) | null = null;

		const taskId = () => globalThis.crypto.randomUUID();
		const runTaskId = taskId();

		const text = () => stable + current;

		const applySentence = (sentence: unknown) => {
			if (!sentence || typeof sentence !== "object") return;
			const record = sentence as { text?: unknown; sentence_end?: unknown };
			if (typeof record.text !== "string") return;
			const value = record.text;
			if (record.sentence_end === true) {
				// 定稿：并进 stable，当前句清空。
				// 两种上游行为都要吃得下 —— 有的给「本句文本」，有的给「从头累计的全文」。
				if (value.startsWith(stable) && value.length > stable.length) stable = value;
				else if (value && !stable.endsWith(value)) stable += value;
				current = "";
			} else {
				current = value;
			}
		};

		const fail = (message: string) => {
			if (!failure) failure = message;
			log.warn("千问实时识别失败", { message });
			settleFinish?.();
		};

		const flushBacklog = () => {
			if (!socket || !ready) return;
			for (const chunk of backlog) {
				try {
					socket.send(chunk);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
					return;
				}
			}
			backlog = [];
			backlogBytes = 0;
		};

		const onMessage = (event: { data?: unknown }) => {
			if (typeof event.data !== "string") return; // 二进制帧：服务端不往回发，忽略
			let payload: unknown;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			const record = payload as {
				header?: { event?: string; error_message?: string; error_code?: string };
				payload?: { output?: { sentence?: unknown } };
			};
			const kind = record.header?.event;
			if (kind === "task-started") {
				ready = true;
				flushBacklog();
				return;
			}
			if (kind === "result-generated") {
				applySentence(record.payload?.output?.sentence);
				return;
			}
			if (kind === "task-finished") {
				ready = false;
				settleFinish?.();
				return;
			}
			if (kind === "task-failed") {
				fail(record.header?.error_message ?? record.header?.error_code ?? "上游返回 task-failed");
			}
		};

		const connect = () => {
			const apiKey = config.apiKey?.trim();
			if (!apiKey && !config.headers?.Authorization) {
				fail("千问实时识别还没配密钥：在 ~/.oh-my-agent-web/stt.json 里填 providers.qwen.apiKey");
				return;
			}
			const authorization = config.headers?.Authorization ?? `Bearer ${apiKey}`;
			const ctor = socketCtor();
			const endpoint = config.endpoint?.trim() || QWEN_REALTIME_ENDPOINT;
			socket = new ctor(endpoint, { headers: { Authorization: authorization } });
			socket.addEventListener("open", () => {
				if (cancelled) return;
				socket?.send(
					JSON.stringify({
						header: { action: "run-task", task_id: runTaskId, streaming: "duplex" },
						payload: {
							input: {},
							task_group: "audio",
							task: "asr",
							function: "recognition",
							model: config.model?.trim() || QWEN_REALTIME_DEFAULT_MODEL,
							parameters: {
								format: "pcm",
								sample_rate: SAMPLE_RATE,
								// 关键：不打开这个就只有整句、没有「边说边出字」
								intermediate_result_enabled: true,
								// 近场：耳麦 / 手机语音输入（远场是会议室那种）
								vad_model: "near_meeting_16k",
								// 静音期间保持连接（常亮听写不中途掉线）
								heartbeat: true,
								...Object.fromEntries(
									Object.entries(config.extraFields ?? {}).map(([key, value]) => [
										key.replace(/^param\./, ""),
										coerce(value),
									]),
								),
							},
						},
					}),
				);
			});
			socket.addEventListener("message", onMessage);
			socket.addEventListener("error", (event) => {
				if (!cancelled) fail(event?.message ?? "WebSocket 连接出错");
			});
			socket.addEventListener("close", () => {
				closed = true;
				ready = false;
				settleFinish?.();
			});
		};

		connect();

		return {
			get text() {
				return text();
			},

			push(pcm: Buffer) {
				if (cancelled || pcm.length === 0) return;
				if (!ready || !socket) {
					// 还没 task-started：先攒着（上限 5 秒），连上后一次性补发
					if (backlogBytes + pcm.length <= MAX_BACKLOG_BYTES) {
						backlog.push(Buffer.from(pcm));
						backlogBytes += pcm.length;
					}
					return;
				}
				try {
					socket.send(pcm);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
			},

			cancel() {
				cancelled = true;
				ready = false;
				backlog = [];
				backlogBytes = 0;
				settleFinish?.();
				try {
					socket?.close();
				} catch {
					// 已经关了
				}
			},

			async end(): Promise<string> {
				if (cancelled) return "";
				if (!socket) return text();
				// finish-task 的 payload.input 是必填的：漏了会被上游以 InvalidParameter 拒掉
				try {
					socket.send(
						JSON.stringify({
							header: { action: "finish-task", task_id: taskId(), streaming: "duplex" },
							payload: { input: {} },
						}),
					);
				} catch (error) {
					fail(error instanceof Error ? error.message : String(error));
				}
				const timeoutMs = config.timeoutMs ?? FINISH_TIMEOUT_MS;
				await new Promise<void>((resolve) => {
					let done = false;
					const finish = () => {
						if (done) return;
						done = true;
						settleFinish = null;
						resolve();
					};
					settleFinish = finish;
					// 已经结束了（task-finished 在 settleFinish 赋值之前就到了）
					if (failure || closed) finish();
					setTimeout(finish, timeoutMs);
				});
				try {
					socket.close();
				} catch {
					// 已关闭
				}
				if (failure) {
					// 失败也把已经识别出来的字交出去：比整句丢掉强
					log.warn("千问实时识别未正常收尾，返回已识别的部分", { message: failure, text: text().slice(0, 80) });
				}
				return text();
			},
		};
	},
};
