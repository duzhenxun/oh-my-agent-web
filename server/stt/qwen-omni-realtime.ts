/**
 * 千问 Omni 实时语音识别（百炼 Realtime 协议）：**边说边出字**，用的是 `qwen3.8-omni-flash-realtime`。
 *
 * 为什么另起一个 provider，而不是把模型名换进 `qwen-realtime.ts`：
 * **两者协议完全不同**（2026-11-24 实测，不是照文档猜的）：
 *
 *   · `qwen-realtime.ts`（ASR message 协议，模型 `qwen-audio-3.1-asr-flash-message`）
 *       端点 `/api-ws/v1/inference`，发 `run-task`，收 `result-generated` / `task-finished`
 *   · 本文件（Realtime 协议，模型 `qwen3.8-omni-flash-realtime`）
 *       端点 `/api-ws/v1/realtime?model=…`，发 `session.update`，
 *       音频走 JSON + base64 的 `input_audio_buffer.append`，
 *       收 `conversation.item.input_audio_transcription.delta|completed`
 *
 * 把模型名硬换过去只会连上就报错。官方文档：
 *   · 接入：https://help.aliyun.com/zh/model-studio/omni-realtime-websocket-access
 *   · 客户端事件：https://help.aliyun.com/zh/model-studio/client-events
 *   · 服务端事件：https://help.aliyun.com/zh/model-studio/server-events
 *
 * 实测记录（北京区、`say` 合成 3.1s 语音 → 16k 单声道 PCM）：
 *   session.created → session.updated → input_audio_buffer.speech_started
 *   → conversation.item.created → deltas（`stash` 是累积预览文本，`text` 为空）
 *   → conversation.item.input_audio_transcription.completed（`transcript` 是定稿全文）
 * 所以：预览用 `stash`（整份替换），定稿用 `transcript`（覆盖整句）。
 *
 * 计费提醒：这是**多模态对话模型**，比纯 ASR 贵得多；只要文字的话 `qwen`（整段）更便宜。
 */
import type { SttConfig, SttLogger, SttProvider, SttSession } from "./types.js";
import { coerce, socketCtor, type SocketLike } from "./ws.js";

export const QWEN_OMNI_REALTIME_ENDPOINT = "wss://dashscope.aliyuncs.com/api-ws/v1/realtime";
export const QWEN_OMNI_REALTIME_DEFAULT_MODEL = "qwen3.8-omni-flash-realtime";
const SAMPLE_RATE = 16_000;
/** session.updated 之前的音频先攒着；上限约 5 秒 */
const MAX_BACKLOG_BYTES = SAMPLE_RATE * 2 * 5;
/** commit 之后等定稿的兜底时长 */
const FINISH_TIMEOUT_MS = 10_000;

/** 端点已经带了 `?model=` 就别重复拼（用户可能自己写了完整 URL） */
function withModel(endpoint: string, model: string): string {
	if (/[?&]model=/.test(endpoint)) return endpoint;
	return `${endpoint}${endpoint.includes("?") ? "&" : "?"}model=${encodeURIComponent(model)}`;
}

export const qwenOmniRealtimeStt: SttProvider = {
	id: "qwen-omni-realtime",
	label: "千问 Omni 实时（qwen3.8-omni-flash-realtime）",
	defaultEndpoint: QWEN_OMNI_REALTIME_ENDPOINT,
	models: ["qwen3.8-omni-flash-realtime", "qwen3.5-omni-flash-realtime", "qwen3.5-omni-plus-realtime"],
	fields: [
		{ key: "apiKey", label: "API Key（百炼）", required: true, secret: true, placeholder: "sk-…" },
		{ key: "model", label: "模型", placeholder: QWEN_OMNI_REALTIME_DEFAULT_MODEL },
		{ key: "endpoint", label: "WebSocket 端点（不带 ?model= 也行）", placeholder: QWEN_OMNI_REALTIME_ENDPOINT },
	],

	create(config: SttConfig, log: SttLogger): SttSession {
		let socket: SocketLike | null = null;
		/** 收到 session.updated 之后才敢发音频 */
		let ready = false;
		let cancelled = false;
		/** 已定稿的句子拼起来 */
		let stable = "";
		/** 正在说的这句的预览（delta 的 `stash` 是累积的，整份替换） */
		let preview = "";
		let backlog: Buffer[] = [];
		let backlogBytes = 0;
		let failure: string | null = null;
		let settleFinish: (() => void) | null = null;
		let finished = false;
		/** 最后一块音频之后有没有定稿过 —— end() 据此判断“还该不该等” */
		let pendingAudio = false;

		const model = config.model?.trim() || QWEN_OMNI_REALTIME_DEFAULT_MODEL;
		const text = () => stable + preview;

		const fail = (message: string) => {
			if (!failure) failure = message;
			log.warn("千问 Omni 实时识别失败", { message });
			settleFinish?.();
		};

		const sendJson = (payload: Record<string, unknown>) => {
			try {
				socket?.send(JSON.stringify(payload));
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		};

		const flushBacklog = () => {
			if (!socket || !ready) return;
			for (const chunk of backlog) {
				sendJson({ type: "input_audio_buffer.append", audio: chunk.toString("base64") });
			}
			backlog = [];
			backlogBytes = 0;
		};

		const onMessage = (event: { data?: unknown }) => {
			if (typeof event.data !== "string") return;
			let payload: unknown;
			try {
				payload = JSON.parse(event.data);
			} catch {
				return;
			}
			const record = payload as {
				type?: string;
				stash?: unknown;
				text?: unknown;
				transcript?: unknown;
				error?: { message?: string; code?: string };
			};
			switch (record.type) {
				case "session.updated":
					ready = true;
					flushBacklog();
					return;
				case "conversation.item.input_audio_transcription.delta": {
					// 实测：`stash` 是这一句到目前为止的累积文本（`text` 一般是空串）
					const stash = typeof record.stash === "string" ? record.stash : undefined;
					if (stash) preview = stash;
					else if (typeof record.text === "string" && record.text) preview = record.text;
					return;
				}
				case "conversation.item.input_audio_transcription.completed": {
					const transcript = typeof record.transcript === "string" ? record.transcript : preview;
					if (transcript) stable += transcript;
					preview = "";
					pendingAudio = false;
					// 一句话定稿就算这一轮结束了（VAD 自动断句时 end() 可能已经等在这）
					settleFinish?.();
					return;
				}
				case "error": {
					const message = record.error?.message ?? record.error?.code ?? "上游返回 error";
					// server_vad 下音频早被它自己消费掉了，我们 end() 里那次 commit 就会撞上
					// “buffer too small, or have no audio” —— 这是**正常情况**，不能当失败：
					// 真当失败的话，没文字的轮次会报红字，有文字的轮次也要白等十秒超时。
					if (/buffer too small|have no audio/i.test(message)) {
						pendingAudio = false;
						settleFinish?.();
						return;
					}
					fail(message);
					return;
				}
				default:
					return;
			}
		};

		const path = `providers.${"qwen-omni-realtime"}.apiKey`;
		const apiKey = config.apiKey?.trim();
		if (!apiKey && !config.headers?.Authorization) {
			fail(`千问 Omni 实时还没配密钥：在 ~/.oh-my-agent-web/stt.json 里填 ${path}`);
		} else {
			const authorization = config.headers?.Authorization ?? `Bearer ${apiKey}`;
			const endpoint = withModel(config.endpoint?.trim() || QWEN_OMNI_REALTIME_ENDPOINT, model);
			try {
				socket = new (socketCtor())(endpoint, { headers: { Authorization: authorization } });
			} catch (error) {
				fail(error instanceof Error ? error.message : String(error));
			}
		}

		socket?.addEventListener("open", () => {
			if (cancelled) return;
			// 只要文字：modalities 写 text，不花钱让模型合成语音回来。
			// `extraFields` 允许调 VAD（比如 silence_duration_ms 调大，避免一句话被切成两截）。
			sendJson({
				type: "session.update",
				session: {
					modalities: ["text"],
					input_audio_format: "pcm16",
					sample_rate: SAMPLE_RATE,
					turn_detection: { type: "server_vad" },
					...Object.fromEntries(
						Object.entries(config.extraFields ?? {}).map(([key, value]) => [
							key.replace(/^param\./, ""),
							coerce(value),
						]),
					),
				},
			});
		});
		socket?.addEventListener("message", onMessage);
		socket?.addEventListener("error", (event) => fail(event?.message ?? "WebSocket 异常"));
		socket?.addEventListener("close", () => {
			ready = false;
			settleFinish?.();
			if (!finished && !cancelled && !failure) failure = "连接被上游关闭";
		});

		return {
			push(pcm: Buffer) {
				if (cancelled || pcm.length === 0) return;
				if (!ready) {
					// session.updated 之前发音频会被拒；先攒着（最多 5 秒）
					if (backlogBytes + pcm.length > MAX_BACKLOG_BYTES) return;
					backlog.push(pcm);
					backlogBytes += pcm.length;
					return;
				}
				sendJson({ type: "input_audio_buffer.append", audio: pcm.toString("base64") });
				pendingAudio = true;
			},

			get text() {
				return text();
			},

			async end() {
				finished = true;
				// 只看“还有没有没定稿的音频”：
				//   · 有 → commit + 等定稿（正常说完就走这条）
				//   · 没有（VAD 已经断过句 / 根本没收到音频）→ 不再 commit，直接返回：
				//     VAD 已消费过的 buffer 再 commit 必定报“buffer too small”，白等一轮。
				const shouldWait = pendingAudio;
				if (shouldWait) {
					sendJson({ type: "input_audio_buffer.commit" });
					await new Promise<void>((resolve) => {
						settleFinish = resolve;
						setTimeout(resolve, FINISH_TIMEOUT_MS);
					});
				} else {
					// 已经定稿了：留一小段宽限，让可能还在路上的最后一个 delta/定稿进得来
					await new Promise<void>((resolve) => setTimeout(resolve, 150));
				}
				ready = false;
				try {
					socket?.close();
				} catch {
					// 关不掉就算了，结果已经拿到了
				}
				if (failure && !text()) throw new Error(failure);
				return text();
			},

			cancel() {
				cancelled = true;
				ready = false;
				settleFinish?.();
				try {
					socket?.close();
				} catch {
					// 取消时关不掉无所谓
				}
			},
		};
	},
};
