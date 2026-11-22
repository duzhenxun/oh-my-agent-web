/**
 * 「声音与语音」面板（独立 Tab，排在 MCP 后面）。
 *
 * 两块：
 *   - 声音提示：开始 / 结束 / 出错 / 等待审批各一枚提示音，可单独开关 + 试听，带总音量；
 *   - 语音播报：可选择浏览器语音或 Edge TTS，调整语速和音色，试听及朗读回复。
 *
 * 设置全部存本机（localStorage）：音量/音色/语速都是「这台机器」的属性，不该多端同步。
 */
import { useEffect, useRef, useState } from "react";
import {
	SOUND_LABEL,
	loadSoundSettings,
	playSound,
	saveSoundSettings,
	type SoundKind,
	type SoundSettings,
} from "../sound.ts";
import {
	DEFAULT_TTS_SETTINGS,
	describeSpeechError,
	diagnoseSpeech,
	isSpeechAvailable,
	listVoices,
	loadTtsSettings,
	saveTtsSettings,
	speak,
	stopSpeaking,
	subscribeVoices,
	ttsSampleLine,
	wakeSpeechService,
	type TtsSettings,
	type TtsProvider,
	type VoiceOption,
} from "../tts.ts";
import { fetchRemoteVoices, type RemoteVoice } from "../remote-tts.ts";
import { requestStopSpeech } from "../speech-control.ts";
import { playVoiceClip } from "../voice-clips.ts";
import { voiceChannelOf } from "../voice-cue-logic.ts";
import { forgetLocalUnavailable, saveVoiceInputSettings, useVoiceInputSettings } from "../voice-input.ts";
import { useAppSelector } from "../store.ts";
import { useT } from "../use-language.ts";

const SOUND_KINDS: SoundKind[] = ["start", "steer", "done", "error", "approval"];

/**
 * 近讲灵敏度（进识别的音量门限）给几档「人话」档位。
 *
 * 为什么不再给滑杆（用户 2026-11-21：「感觉现在这个不太好，要不你有那种下拉框的形式，让我选数字也行」）：
 * 这个值调完才知道对不对，滑杆要一点点试，还看不出「旁人说话会不会被挡」。
 * 一档一句人话（宽松 / 中等 / 偏严），选错了往下/往上挪一档就行。
 */
const NEAR_TALK_PRESETS: readonly { db: number; zh: string; en: string }[] = [
	{ db: 0, zh: "关闭 · 0（不挡人，开自动增益）", en: "Off · 0 (no gate, auto gain on)" },
	{ db: 6, zh: "宽松 · 6 dB（小声也能进，偶尔收进旁人）", en: "Loose · 6 dB (quiet voice gets in)" },
	{ db: 12, zh: "中等 · 12 dB（默认档，挡住一米外的聊天）", en: "Medium · 12 dB (default)" },
	{ db: 18, zh: "偏严 · 18 dB（基本要正对着说）", en: "Strict · 18 dB (near-field only)" },
	{ db: 24, zh: "很严 · 24 dB（几乎只认贴嘴）", en: "Very strict · 24 dB" },
];

export function VoicePanel() {
	const t = useT();
	const [sound, setSound] = useState<SoundSettings>(() => loadSoundSettings());
	const [tts, setTts] = useState<TtsSettings>(() => loadTtsSettings());
	// 语音输入是**听**（麦克风 → 文字），和上面这套播报（文字 → 声音）是两块，所以单独一份设置
	const voiceInput = useVoiceInputSettings();
	// 插队只有声明了 steer 的引擎才有（pi 有，codex/opencode 没有）
	const steerSupported = useAppSelector((state) => state.snapshot?.engineCapabilities?.steer !== false);
	/**
	 * 本地识别桥的状态：**只读**（不带 `?start=1`）—— 打开设置面板不该顺带拉起一个
	 * 会弹系统授权框的原生进程。真要启动时用户点「启动」或直接用浮条说话。
	 */
	const [asr, setAsr] = useState<{
		state: string;
		message?: string;
		locale?: string;
		/** 没装时服务端给的安装信息（去哪儿下、装好会在哪） */
		install?: { downloadUrl: string; appPath: string; canAutoInstall: boolean } | null;
	} | null>(null);
	/** 正在下载/安装本地识别程序（这期间按钮置灰，避免连点） */
	const [installingAsr, setInstallingAsr] = useState(false);
	const [asrInstallError, setAsrInstallError] = useState<string | null>(null);
	const refreshAsr = (start = false) => {
		void fetch(`/api/asr/status${start ? "?start=1" : ""}`)
			.then(async (response) => {
				if (!response.ok) return;
				setAsr(
					(await response.json()) as {
						state: string;
						message?: string;
						locale?: string;
						install?: { downloadUrl: string; appPath: string; canAutoInstall: boolean } | null;
					},
				);
			})
			.catch(() => undefined);
	};
	/**
	 * 下载并安装本地识别程序（服务端装到 `~/Library/Application Support/oh-my-agent-web/asr`）。
	 * 装完直接拉起：用户点了这个按钮，意思就是「我要用本地识别」，不用再点一次「启动」。
	 */
	const installAsr = () => {
		if (installingAsr) return;
		setInstallingAsr(true);
		setAsrInstallError(null);
		void fetch("/api/asr/install", { method: "POST", credentials: "same-origin" })
			.then(async (response) => {
				const body = (await response.json().catch(() => ({}))) as { ok?: boolean; message?: string };
				if (!response.ok || body.ok !== true) {
					setAsrInstallError(body.message ?? t("安装失败", "Install failed"));
					return;
				}
				// 之前探到过 missing（auto 就一直在走 Chrome）：装好了要把这条记忆清掉
				forgetLocalUnavailable();
				refreshAsr(true);
			})
			.catch((error: unknown) =>
				setAsrInstallError(error instanceof Error ? error.message : t("安装请求失败了", "The install request failed")),
			)
			.finally(() => setInstallingAsr(false));
	};
	useEffect(() => refreshAsr(), []);
	const [voices, setVoices] = useState<VoiceOption[]>(() => listVoices());
	const [remoteVoices, setRemoteVoices] = useState<RemoteVoice[]>([]);
	const [loadingVoices, setLoadingVoices] = useState(false);
	const [voicesIssue, setVoicesIssue] = useState<string | null>(null);
	/** 试听失败/没响的原因（成功开始念就清掉）：合成失败在浏览器里是静默的，不给提示就只能瞎猜 */
	const [voiceIssue, setVoiceIssue] = useState<string | null>(null);
	/**
	 * 这次失败「唤一下服务再重试」有没有意义（`SpeakIssue.wakeable` / 诊断结论）。
	 * 只有它是 true 时才显示「唤醒并重试」—— 换音色、联网这类问题给这颗按钮只是让人白点。
	 */
	const [issueWakeable, setIssueWakeable] = useState(false);
	/** 正在念（按钮跟着变）：「点了没反应」本身就是个 bug */
	const [previewing, setPreviewing] = useState(false);
	const previewActive = useRef(false);
	useEffect(
		() => () => {
			if (previewActive.current) stopSpeaking();
		},
		[],
	);
	/** 中性状态行（正在播放 / 已念完），与红色失败原因分开 */
	const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
	const available = isSpeechAvailable(tts);
	const isRemote = (tts.provider ?? "browser") !== "browser";
	const remoteProvider = tts.provider === "kokoro" || tts.provider === "qwen3" ? tts.provider : "edge";
	const remoteVoice =
		tts.provider === "kokoro" ? tts.kokoroVoice : tts.provider === "qwen3" ? tts.qwen3Voice : tts.edgeVoice;
	// 旧版本可能存过 Google 在线音色；不在当前清单里时显示回退到「自动」
	const selectedVoice = voices.some((voice) => voice.voiceURI === tts.voiceURI) ? tts.voiceURI : "";
	/**
	 * 存着、但这会儿不在清单里的音色（典型：取消勾选「显示在线音色」之后的 Google 中文）。
	 * 必须把它作为一条选项显示出来，否则面板写「自动」而设置里存着 Google —— 两边对不上。
	 */
	const keptOffList =
		tts.voiceURI !== "" && selectedVoice === ""
			? listVoices({ includeOnline: true }).find((voice) => voice.voiceURI === tts.voiceURI)
			: undefined;

	// Chrome 的语音清单是异步填充的：第一次拿到空数组，得等 voiceschanged
	// 只列在线音色时这张清单会短很多，但切换勾选后必须重取一次（否则还挂着旧的那份）
	useEffect(() => {
		setVoices(listVoices({ onlyOnline: tts.allowOnline }));
		return subscribeVoices(() => setVoices(listVoices({ onlyOnline: tts.allowOnline })));
	}, [tts.allowOnline]);

	useEffect(() => {
		if (!isRemote) return;
		const controller = new AbortController();
		let disposed = false;
		const timer = window.setTimeout(() => controller.abort(), 15_000);
		setLoadingVoices(true);
		setVoicesIssue(null);
		void fetchRemoteVoices(controller.signal, remoteProvider)
			.then((items) => {
				if (!disposed) setRemoteVoices(items);
			})
			.catch(() => {
				if (!disposed)
					setVoicesIssue(
						t(
							"音色列表加载失败，可以使用默认音色试听",
							"Unable to load voices; you can still preview the default voice",
						),
					);
			})
			.finally(() => {
				window.clearTimeout(timer);
				if (!disposed) setLoadingVoices(false);
			});
		return () => {
			disposed = true;
			window.clearTimeout(timer);
			controller.abort();
		};
	}, [isRemote, remoteProvider, t]);

	const patchSound = (patch: Partial<SoundSettings>) => {
		const next = { ...sound, ...patch };
		setSound(next);
		saveSoundSettings(next);
	};
	const patchTts = (patch: Partial<TtsSettings>) => {
		if (
			patch.provider !== undefined ||
			patch.voiceURI !== undefined ||
			patch.edgeVoice !== undefined ||
			patch.kokoroVoice !== undefined ||
			patch.qwen3Voice !== undefined
		) {
			stopSpeaking();
			setVoiceIssue(null);
			setVoiceStatus(null);
			setIssueWakeable(false);
		}
		const next = { ...tts, ...patch };
		setTts(next);
		saveTtsSettings(next);
	};
	/**
	 * 开关「只列在线音色」（默认开）。
	 *
	 * 本机音色（macOS 的 Eddy / 婷婷等）在这台机器上就是念不出来，列在下拉里只会让人白选一场，
	 * 所以默认只列在线的（Chrome 的 Google 系列）。取消勾选能看到全部，自己排查时用。
	 *
	 * 取消勾选**不删**已选音色：只是列表变了，存着的 voiceURI 不动。
	 */
	const patchAllowOnline = (allowOnline: boolean) => patchTts({ allowOnline });
	/** 只列在线音色，却一条都没捞到（Chrome 的 Google 音色要联网才加载） */
	const noOnlineVoice = !isRemote && tts.allowOnline && voices.length === 0;
	/**
	 * 试听：跳过「总开关关着」「这一项关着」的判断 —— 试听本来就是显式意图。
	 *
	 * 走的是**真实链路**（`voiceChannelOf`）：语音开着就播对应事件的本地片段，关着就只响提示音。
	 * 真机上要听「出错 / 审批」的语音，现实里很难现场造出来，这几颗按钮就是唯一方便的人口。
	 * （「开始」没有片段，永远只是轻响一声。）
	 *
	 * **插队例外**（用户 2026-11-03）：这一行要听的就是那句「有新任务插队」——
	 * 它没有「提示音」这层语义（以前退回去借用「开始」的轻响，试听只听到一声「嗒」，
	 * 根本不知道插队会念什么）。所以不论「启用语音播报」勾没勾，试听都**直接播片段**。
	 */
	const preview = (kind: SoundKind) => {
		if (kind === "steer") {
			playVoiceClip("steer", { force: true, volume: Math.max(0.05, sound.volume / 100) });
			return;
		}
		const enabled = loadTtsSettings().enabled;
		const channel = voiceChannelOf({ kind, voiceEnabled: enabled, readReplies: false, hasReply: false });
		if (channel === "clip" && kind !== "start") {
			playVoiceClip(kind, { force: true, volume: Math.max(0.05, sound.volume / 100) });
			return;
		}
		playSound(kind, { ...sound, enabled: true, [kind]: true, volume: sound.volume });
	};
	/**
	 * 试听**本地片段**（状态语音的主路）：走的就是真实播报那条代码，成功与否不看系统音色。
	 * 用 `force`：用户可能先把声音关了再点试听 —— 那样也得有反馈，不然他会以为功能坏了。
	 *
	 * `language` 给了就播**那个语言**的片段（不切界面语言也能听英文版，方便核对两套音频）。
	 */
	const previewClip = (language?: "zh" | "en") => {
		playVoiceClip("done", { force: true, language, volume: Math.max(0.05, sound.volume / 100) });
		setVoiceIssue(null);
		setVoiceStatus(
			language === "en"
				? t("已播放英文片段「Task complete.」", 'Played the English clip "Task complete."')
				: language === "zh"
					? t("已播放中文片段「任务已完成」", 'Played the Chinese clip "任务已完成"')
					: t("已播放本地语音片段（跟当前界面语言）", "Played the bundled clip (current UI language)"),
		);
		window.setTimeout(() => setVoiceStatus(null), 2400);
	};
	/**
	 * 试听语音：**必须给反馈**。
	 * 浏览器的合成失败是静默的（不报错、就是没声音），没有这条提示用户只能猜「是不是坏了」。
	 * 所以每种结果都落到界面上：按钮变「试听中」、念完恢复、失败给一句能照做的原因。
	 */
	const previewVoice = () => {
		stopSpeaking();
		setVoiceIssue(null);
		setIssueWakeable(false);
		setVoiceStatus(t("正在准备语音…", "Preparing speech…"));
		setPreviewing(true);
		previewActive.current = true;
		const settle = () => {
			previewActive.current = false;
			setPreviewing(false);
		};
		speak(
			ttsSampleLine(),
			{ ...tts, enabled: true },
			{
				onStart: () => {
					previewActive.current = true;
					setPreviewing(true);
					setVoiceIssue(null);
					setVoiceStatus(t("正在念：语音播报正常", "Speaking: speech is working"));
				},
				onCancel: () => {
					// 被消息里的「朗读」接管：旧试听不会再回调 onEnd，
					// 不在这里收尾，「试听中」会一直挂着（4 秒兜底也因 started 已 true 而跳过）。
					settle();
					setVoiceStatus(null);
				},
				onEnd: () => {
					settle();
					setVoiceStatus(null);
				},
				onIssue: (message, issue) => {
					settle();
					setVoiceStatus(null);
					setVoiceIssue(message);
					setIssueWakeable(issue.wakeable);
				},
			},
		);
	};

	/**
	 * 「唤醒并重试」：先让合成器念一句静音短句（`wakeSpeechService`：cancel + resume + 空句
	 * 走一遍 start→end）把没起来的系统语音服务踢醒，隔一拍再重放一次试听。
	 *
	 * 为什么要这颗按钮：自愈（`speak()` 里那 `MAX_WAKES` 轮）失败后，用户手里只剩
	 * 「重启浏览器 / 终端 killall speechsynthesisd」两招 —— 这颗按钮就是同一招，
	 * 但带着面板里的反馈（正在唤醒 / 正在念 / 又失败了）。
	 */
	const wakeAndRetry = () => {
		setVoiceIssue(null);
		setIssueWakeable(false);
		setVoiceStatus(t("正在唤醒系统语音服务…", "Waking the system speech service…"));
		// 400ms 比内部重试的 200ms 宽一档：手动点的时候，人眼要看得见「唤醒」这一步
		wakeSpeechService(() => previewVoice(), 400);
	};

	/**
	 * 诊断：拿一句最朴素的“测试”直接问浏览器能不能念，把四层原因分开 ——
	 * 浏览器不支持 / 合成器卡死 / 音色念不出来 / 其实念了但没音频输出。
	 */
	const runDiagnosis = async () => {
		setVoiceIssue(null);
		setVoiceStatus(t("正在诊断…（约 2.5 秒）", "Diagnosing… (about 2.5s)"));
		const result = await diagnoseSpeech();
		if (!result.available) {
			setVoiceStatus(null);
			setVoiceIssue(
				t("诊断：这个浏览器没有语音合成（speechSynthesis）能力", "Diagnosis: this browser has no speech synthesis"),
			);
			return;
		}
		if (result.started) {
			setVoiceStatus(
				t(
					`诊断：合成器正常（${result.ms}ms 内开始；音色 ${result.voices} 个，其中在线 ${result.online} 个）。若还是听不到，问题在音量 / 输出设备，不在浏览器。`,
					`Diagnosis: the synthesizer responds (started within ${result.ms}ms; ${result.voices} voices, ${result.online} online). If you still hear nothing, the problem is volume / output device.`,
				),
			);
			return;
		}
		if (result.error) {
			setVoiceStatus(null);
			setIssueWakeable(true);
			setVoiceIssue(
				t(
					`诊断：系统报错「${result.error}」— ${describeSpeechError(result.error)}`,
					`Diagnosis: error "${result.error}" — ${describeSpeechError(result.error)}`,
				),
			);
			return;
		}
		setVoiceStatus(null);
		setIssueWakeable(true);
		setVoiceIssue(
			t(
				`诊断：合成器 ${result.ms}ms 内既没开始也没报错（音色 ${result.voices} 个，在线 ${result.online} 个）→ 系统的语音服务卡死了。重启浏览器；macOS 还可执行 killall speechsynthesisd`,
				`Diagnosis: no start and no error within ${result.ms}ms (${result.voices} voices, ${result.online} online) → the OS speech service is stuck. Restart the browser; on macOS try killall speechsynthesisd`,
			),
		);
	};

	return (
		<div className="voice-panel">
			<section className="voice-section">
				{/* 不再单独起一个「声音提示」小标题：这一块的开关与细项已经说清了自己是什么，
				 * 多一行标题只是把内容往下推（用户要求去掉）。 */}
				<label className="voice-row">
					<span className="voice-row-label">
						<span aria-hidden="true">🔊</span> {t("启用声音", "Enable sounds")}
					</span>
					<input type="checkbox" checked={sound.enabled} onChange={() => patchSound({ enabled: !sound.enabled })} />
				</label>

				{SOUND_KINDS.map((kind) => (
					<label className="voice-row" key={kind}>
						<span className="voice-row-label">
							{t(SOUND_LABEL[kind].title, SOUND_LABEL[kind].titleEn)}
							<span className="voice-row-hint">{t(SOUND_LABEL[kind].hint, SOUND_LABEL[kind].hintEn)}</span>
						</span>
						<button
							type="button"
							className="btn btn-tiny voice-try"
							onClick={(event) => {
								// 在 label 里点按钮会连带切换勾选框：拦下来
								event.preventDefault();
								preview(kind);
							}}
						>
							{t("试听", "Preview")}
						</button>
						<input
							type="checkbox"
							checked={sound[kind]}
							onChange={() => patchSound({ [kind]: !sound[kind] } as Partial<SoundSettings>)}
						/>
					</label>
				))}
			</section>

			<section className="voice-section">
				<label className="voice-row">
					<span className="voice-row-label">
						<span aria-hidden="true">🔊</span> {t("启用语音播报", "Enable speech")}
						<span className="voice-row-hint">
							{t(
								"完成 / 插队 / 出错 / 等待审批播本地音频（中文、英文各一套，不联网、不依赖系统音色）",
								"Plays bundled audio clips on finish / steer / error / approval (Chinese and English, no network, no system voices)",
							)}
						</span>
					</span>
					<input type="checkbox" checked={tts.enabled} onChange={() => patchTts({ enabled: !tts.enabled })} />
				</label>

				<label className="voice-row">
					<span className="voice-row-label">
						{t("朗读回复", "Read replies aloud")}
						<span className="voice-row-hint">
							{t(
								"开启后，回答边输出边按句朗读（不用等整条写完）",
								"Reads each sentence as the answer streams in, instead of waiting for the whole reply",
							)}
						</span>
					</span>
					<input
						type="checkbox"
						checked={tts.readReplies}
						onChange={() => patchTts({ readReplies: !tts.readReplies })}
					/>
				</label>

				<label className="voice-row voice-row-select voice-row-stacked">
					<span className="voice-row-label">{t("语音引擎", "Speech engine")}</span>
					<select
						className="voice-select"
						value={tts.provider ?? "browser"}
						onChange={(event) => patchTts({ provider: event.target.value as TtsProvider })}
					>
						<option value="browser">{t("浏览器语音", "Browser speech")}</option>
						<option value="edge">{t("微软 Edge TTS（在线）", "Microsoft Edge TTS (online)")}</option>
						<option value="kokoro">{t("Kokoro（本地）", "Kokoro (local)")}</option>
						<option value="qwen3">{t("Qwen3-TTS（本地）", "Qwen3-TTS (local)")}</option>
					</select>
				</label>
				{isRemote ? (
					<div className="voice-issue voice-status" role="status">
						{remoteProvider === "edge"
							? t(
									"无需 API Key，需联网；朗读文字会发送到微软语音服务。",
									"No API key needed; requires internet. Text is sent to Microsoft's speech service.",
								)
							: t(
									"本机 MLX 模型，不联网；首次合成要加载模型，会慢几秒。",
									"Runs on this Mac with MLX, no network; the first synthesis loads the model and takes a few seconds.",
								)}
					</div>
				) : null}

				{/* 语速与提示音音量并排一行：两块都是滑杆，竖着排白占一屏（用户 2026-11-21：「语速跟提示音可以放成一行」） */}
				<div className="voice-row-pair">
					<div className="voice-row voice-row-stacked">
						<span className="voice-row-label">{t("语速", "Rate")}</span>
						<span className="voice-slider-line">
							<input
								type="range"
								min={0.5}
								max={2}
								step={0.1}
								value={tts.rate}
								onChange={(event) => patchTts({ rate: Number(event.target.value) })}
							/>
							<span className="voice-value mono">{tts.rate.toFixed(1)}×</span>
						</span>
					</div>

					{/* 音量跟着「语速」放：两块都是滑杆，挨在一起才好对比着调。
				    它管的是**提示音**（提示音走 WebAudio，播报的是浏览器自己的响度），
				    标签写成「提示音音量」，免得被当成语音播报的音量。 */}
					<div className="voice-row voice-row-stacked">
						<span className="voice-row-label">{t("提示音音量", "Cue volume")}</span>
						<span className="voice-slider-line">
							<input
								type="range"
								min={0}
								max={100}
								step={5}
								value={sound.volume}
								onChange={(event) => patchSound({ volume: Number(event.target.value) })}
								onMouseUp={() => preview("done")}
								title={t("调完松手会试听一声", "Plays a sample when you let go")}
							/>
							<span className="voice-value mono">{sound.volume}%</span>
						</span>
					</div>
				</div>

				{isRemote ? (
					<label className="voice-row voice-row-select voice-row-stacked">
						<span className="voice-row-label">{t("语音", "Voice")}</span>
						<select
							className="voice-select"
							value={remoteVoice ?? ""}
							onChange={(event) =>
								patchTts(
									remoteProvider === "kokoro"
										? { kokoroVoice: event.target.value }
										: remoteProvider === "qwen3"
											? { qwen3Voice: event.target.value }
											: { edgeVoice: event.target.value },
								)
							}
							disabled={loadingVoices}
						>
							{!remoteVoices.some((voice) => voice.id === remoteVoice) ? (
								<option value={remoteVoice ?? ""}>
									{loadingVoices
										? t("正在加载音色…", "Loading voices…")
										: (remoteVoice ?? t("默认音色", "Default voice"))}
								</option>
							) : null}
							{remoteVoices.map((voice) => (
								<option key={voice.id} value={voice.id}>
									{voice.name}
									{voice.lang ? `（${voice.lang}）` : ""}
								</option>
							))}
						</select>
					</label>
				) : (
					<>
						<div className="voice-row voice-row-select voice-row-stacked">
							<span className="voice-row-label">{t("语音", "Voice")}</span>
							<select
								className="voice-select"
								value={selectedVoice}
								onChange={(event) => patchTts({ voiceURI: event.target.value })}
								title={t(
									"浏览器里可用的音色（取决于系统装了什么语音）",
									"Voices available in the browser (depends on what the OS has installed)",
								)}
							>
								<option value="">{t("自动（跟随系统语言）", "Auto (match the system language)")}</option>
								{voices.map((voice) => (
									<option key={voice.voiceURI} value={voice.voiceURI}>
										{/* 在线音色必须标出来：它要联网，且部分 Chrome 版本选它会念不出来 */}
										{voice.name}（{voice.lang}
										{voice.localService ? "" : t("，在线", ", online")}）
									</option>
								))}
								{keptOffList ? (
									<option value={keptOffList.voiceURI}>
										{keptOffList.name}（{keptOffList.lang}
										{keptOffList.localService
											? t("，本机；已保留", ", local; kept")
											: t("，在线；已保留", ", online; kept")}
										）
									</option>
								) : null}
							</select>
						</div>

						{/* 本机音色（macOS 的 Eddy / 婷婷等）在这台机器上念不出来，下拉里只列在线的。
						 *  但能力不能被藏死：取消勾选还能看到全部，排查时用。 */}
						<label className="voice-row voice-row-stacked">
							<span className="voice-row-label">
								{t("只列在线音色", "Online voices only")}
								<span className="voice-row-hint">
									{t(
										"本机音色在这台机器上念不出来，所以默认只列在线的（如「Google 普通话」）；取消勾选可看全部",
										"Local voices never start on this machine, so only online ones are listed; uncheck to see all",
									)}
								</span>
							</span>
							<input type="checkbox" checked={tts.allowOnline} onChange={() => patchAllowOnline(!tts.allowOnline)} />
						</label>
					</>
				)}
				{isRemote && voicesIssue ? (
					<div className="voice-issue" role="status">
						{voicesIssue}
					</div>
				) : null}

				{noOnlineVoice ? (
					<div className="voice-issue voice-status" role="status">
						{t(
							"没找到在线音色：Chrome 的 Google 音色要联网才会加载（断网时只能选「自动」或取消勾选看本机音色）",
							"No online voice found: Chrome loads Google voices from the network",
						)}
					</div>
				) : null}

				<div className="voice-actions">
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => previewClip()}
						title={t("播一段本地语音片段（跟当前界面语言）", "Plays a bundled clip (current UI language)")}
					>
						{t("试听", "Preview")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => previewClip("en")}
						title={t("播英文片段（不用先切界面语言）", "Plays the English clip without switching the UI language")}
					>
						{t("试听英文", "Preview (EN)")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={previewVoice}
						disabled={!available || previewing}
						title={t("用所选语音引擎试听一句话", "Previews a sentence using the selected speech engine")}
					>
						{t("测朗读", "Test reading")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={requestStopSpeech}
						title={t(
							"停掉正在念的内容；这一轮剩下的文字也不再自动念",
							"Stops the current sentence; the rest of this turn stays silent",
						)}
					>
						{t("停止", "Stop")}
					</button>
					{!isRemote ? (
						<button
							type="button"
							className="btn btn-tiny"
							onClick={() => void runDiagnosis()}
							title={t(
								"绕过本项目所有设置，直接问浏览器能不能念",
								"Bypasses all settings and asks the browser directly",
							)}
						>
							{t("诊断", "Diagnose")}
						</button>
					) : null}
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => {
							stopSpeaking();
							patchTts({ ...DEFAULT_TTS_SETTINGS, voiceURI: tts.voiceURI });
						}}
					>
						{t("恢复默认", "Restore defaults")}
					</button>
				</div>

				{voiceStatus ? (
					<div className="voice-issue voice-status" role="status">
						{voiceStatus}
					</div>
				) : null}
				{voiceIssue ? (
					<div className="voice-issue" role="status">
						<span className="voice-issue-text">{voiceIssue}</span>
						{issueWakeable && available && !isRemote ? (
							<button
								type="button"
								className="btn btn-tiny"
								onClick={wakeAndRetry}
								disabled={previewing}
								title={t(
									"先念一句静音的唤醒句把系统语音服务踢醒，再重放一次试听（省得你去终端 killall）",
									"Plays a silent wake-up utterance, then retries the sample (no need to killall anything)",
								)}
							>
								{t("唤醒并重试", "Wake & retry")}
							</button>
						) : null}
					</div>
				) : null}
			</section>

			{/* 语音输入：听 → 文字。和上面那套「文字 → 声音」没共用的开关，所以单开一节。 */}
			<section className="voice-section">
				<div className="voice-row">
					<span className="voice-row-label">
						<span aria-hidden="true">🎤</span> {t("语音输入", "Voice input")}
						<span className="voice-row-hint">
							{t(
								"点页面上的麦克风浮条说话，文字实时进输入框（浮条可以拖到任意位置）",
								"Tap the microphone bubble to dictate; text lands in the composer as you speak (drag the bubble anywhere)",
							)}
						</span>
					</span>
				</div>
				<label className="voice-row">
					<span className="voice-row-label">
						{t("说完自动发送", "Send when I stop talking")}
						<span className="voice-row-hint">
							{t(
								`停 ${(voiceInput.silenceMs / 1000).toFixed(1)} 秒没说话就发（句中停顿不会被打断）。关掉后只写进输入框，按回车才发`,
								`Sends after ${(voiceInput.silenceMs / 1000).toFixed(1)}s of silence (mid-sentence pauses won't cut you off). Off = dictation only fills the composer`,
							)}
						</span>
					</span>
					<input
						type="checkbox"
						checked={voiceInput.autoSend}
						onChange={() => saveVoiceInputSettings({ ...voiceInput, autoSend: !voiceInput.autoSend })}
					/>
				</label>
				{/* 静音时长：用户 2026-11-21「设成几秒你就几秒再发送」—— 按秒调，0.2 秒一档 */}
				<label className="voice-row">
					<span className="voice-row-label">
						{t("等多久发送", "Silence before sending")}
						<span className="voice-row-hint">
							{t(
								"停顿超过这个时长才算说完。说话慢、爱停顿就调大一点；越大越不容易被切断",
								"Longer means a pause must last longer to count as done — safer if you speak slowly or pause often",
							)}
						</span>
					</span>
					<span className="voice-slider-line voice-slider-compact">
						<input
							type="range"
							min={0.6}
							max={10}
							step={0.2}
							value={voiceInput.silenceMs / 1000}
							onChange={(event) =>
								saveVoiceInputSettings({ ...voiceInput, silenceMs: Number(event.target.value) * 1000 })
							}
						/>
						<span className="voice-value mono">{(voiceInput.silenceMs / 1000).toFixed(1)}s</span>
					</span>
				</label>

				<label className="voice-row">
					<span className="voice-row-label">
						{t("显示朗读控制条", "Show reading controls")}
						<span className="voice-row-hint">
							{t(
								"关掉后消息下面那条「暂停 / 停止」就不显示（快捷键仍然可用）",
								"Hides the pause/stop bar under messages (keyboard shortcuts still work)",
							)}
						</span>
					</span>
					<input
						type="checkbox"
						checked={voiceInput.showReadingDock}
						onChange={() => saveVoiceInputSettings({ ...voiceInput, showReadingDock: !voiceInput.showReadingDock })}
					/>
				</label>

				{/* 朗读恢复延迟：和上面那个发送阈值拆开（发送要快、朗读恢复要慢） */}
				<label className="voice-row">
					<span className="voice-row-label">
						{t("朗读恢复延迟", "Resume reading after")}
						<span className="voice-row-hint">
							{t(
								"你说话时朗读会暂停；安静满这个时长它才继续念（和上面的发送阈值互不影响）",
								"Reading pauses while you speak and resumes after this much silence (independent from the send threshold above)",
							)}
						</span>
					</span>
					<span className="voice-slider-line voice-slider-compact">
						<input
							type="range"
							min={0.6}
							max={10}
							step={0.2}
							value={voiceInput.readingResumeMs / 1000}
							onChange={(event) =>
								saveVoiceInputSettings({ ...voiceInput, readingResumeMs: Number(event.target.value) * 1000 })
							}
						/>
						<span className="voice-value mono">{(voiceInput.readingResumeMs / 1000).toFixed(1)}s</span>
					</span>
				</label>

				<label className="voice-row">
					<span className="voice-row-label">
						{t("连续听写", "Keep listening")}
						<span className="voice-row-hint">
							{t(
								"发完一句自动继续听，不用每次点麦克风。麦克风会一直占用（系统灯常亮），手动点停后不再自动恢复",
								"Keeps the mic open after each send so you never tap again. The mic stays busy (system light on) and a manual stop is respected",
							)}
						</span>
					</span>
					<input
						type="checkbox"
						checked={voiceInput.continuous}
						onChange={() => saveVoiceInputSettings({ ...voiceInput, continuous: !voiceInput.continuous })}
					/>
				</label>
				<label className="voice-row voice-row-select">
					<span className="voice-row-label">
						{t("近讲灵敏度", "Near-field only")}
						<span className="voice-row-hint">
							{t(
								"数字越大，越只认离麦克风近的声音（旁边同事说话会被挡掉）。离得远 / 说话轻就选小一档：0 = 关闭门限并打开自动增益",
								"Higher = only near-field voice gets through (blocks colleagues next to you). Sitting farther away or speaking softly: pick a lower step — 0 = gate off and auto gain on",
							)}
						</span>
					</span>
					{/*
					 * 滑杆换成下拉（用户 2026-11-21：「感觉现在这个不太好，要不你有那种下拉框的形式，让我选数字也行」）：
					 * 门限是个“调完才知道对不对”的值，滑杆要一点点试、还看不到“别人说话会不会被挡”，
					 * 不如给几档带人话描述的档位（宽松 / 中等 / 偏严…），一眼知道往哪边走。
					 * 已经存着的非档位值（比如 11）**原样列一项“当前”**，不会因为改控件把用户的值悄悄改掉。
					 */}
					<select
						className="voice-select"
						value={String(voiceInput.nearTalkDb)}
						onChange={(event) => saveVoiceInputSettings({ ...voiceInput, nearTalkDb: Number(event.target.value) })}
					>
						{NEAR_TALK_PRESETS.some((preset) => preset.db === voiceInput.nearTalkDb) ? null : (
							<option value={String(voiceInput.nearTalkDb)}>
								{t(`当前 · ${voiceInput.nearTalkDb} dB`, `Current · ${voiceInput.nearTalkDb} dB`)}
							</option>
						)}
						{NEAR_TALK_PRESETS.map((preset) => (
							<option key={preset.db} value={String(preset.db)}>
								{t(preset.zh, preset.en)}
							</option>
						))}
					</select>
				</label>

				<label className="voice-row voice-row-select">
					<span className="voice-row-label">
						{t("识别引擎", "Recognition engine")}
						<span className="voice-row-hint">
							{t(
								"自动 = 优先本地离线识别（不依赖 Google，带标点）；本地不可用时退回 Chrome",
								"Auto prefers the local offline engine (no Google, keeps punctuation) and falls back to Chrome",
							)}
						</span>
					</span>
					<select
						className="voice-select"
						value={voiceInput.engine}
						onChange={(event) =>
							saveVoiceInputSettings({
								...voiceInput,
								engine:
									event.target.value === "browser" || event.target.value === "local" ? event.target.value : "auto",
							})
						}
					>
						<option value="auto">{t("自动（优先本地）", "Auto (local first)")}</option>
						<option value="local">{t("本地（macOS 离线）", "Local (macOS, offline)")}</option>
						<option value="browser">{t("Chrome 原生（需连 Google）", "Chrome (needs Google)")}</option>
					</select>
				</label>

				{/* 本地引擎状态：只在选了「本地」或「自动」时才有意义 */}
				{voiceInput.engine !== "browser" ? (
					<>
						<div className="voice-row voice-row-status">
							<span className="voice-row-label">
								{t("本地识别", "Local recognition")}
								<span className="voice-row-hint">
									{asr === null
										? t("还没启动过", "Not started yet")
										: asr.state === "ready"
											? t(`就绪（${asr.locale ?? "zh-CN"}，离线）`, `Ready (${asr.locale ?? "zh-CN"}, offline)`)
											: asr.state === "authorizing"
												? t(
														"等待系统授权：屏幕上的提示点「允许」即可",
														"Waiting for permission — click Allow in the system prompt",
													)
												: asr.state === "starting"
													? t("正在启动…", "Starting…")
													: asr.state === "missing"
														? t(
																"还没装：一个后台小工具，点一下就能装好",
																"Not installed yet — a small background helper, one click installs it",
															)
														: (asr.message ?? asr.state)}
								</span>
							</span>
							{asr?.state === "missing" ? (
								<button
									type="button"
									className="btn btn-tiny"
									disabled={installingAsr || asr.install?.canAutoInstall === false}
									onClick={installAsr}
									title={t("下载并装好本地识别（不用装 Xcode）", "Download and install it — no Xcode needed")}
								>
									{installingAsr ? t("正在安装…", "Installing…") : t("安装本地识别", "Install it")}
								</button>
							) : (
								<button
									type="button"
									className="btn btn-tiny"
									onClick={() => refreshAsr(true)}
									title={t(
										"启动本地识别（首次会弹一次系统授权）",
										"Start the local engine (one system permission prompt the first time)",
									)}
								>
									{t("启动 / 重试", "Start / retry")}
								</button>
							)}
						</div>
						{asr?.state === "missing" && asr.install?.canAutoInstall !== false ? (
							<div className="voice-install">
								<ol className="voice-install-steps">
									<li>
										{t(
											"点「安装本地识别」：服务端会下载并解压到 Application Support（可离线、不联网识别）",
											"Click “Install it” — the server downloads and unpacks it into Application Support (recognition itself stays offline)",
										)}
									</li>
									<li>
										{t(
											"装好后这里会变成「就绪」；第一次说话会弹一次系统授权，点「允许」即可",
											"This row turns into “Ready”. The first time you speak, macOS asks once for permission — click Allow",
										)}
									</li>
								</ol>
								<div className="voice-install-actions">
									{asr.install ? (
										<a
											className="btn btn-tiny"
											href={asr.install.downloadUrl}
											target="_blank"
											rel="noreferrer"
											title={asr.install.appPath}
										>
											{t("手动下载 zip", "Download the zip")}
										</a>
									) : null}
									<button type="button" className="btn btn-tiny" onClick={() => refreshAsr()}>
										{t("装好了，重新检测", "Installed — check again")}
									</button>
								</div>
								{asrInstallError ? (
									<div className="voice-issue" role="status">
										<span className="voice-issue-text">{asrInstallError}</span>
									</div>
								) : null}
							</div>
						) : null}
						{asr?.state === "missing" && asr.install?.canAutoInstall === false ? (
							<div className="voice-issue voice-status" role="status">
								<span className="voice-issue-text">
									{t(
										"本地识别只有 macOS 版（跑服务端的那台机器）；这台机器请把上面的「识别引擎」改成 Chrome 原生",
										"Local recognition is macOS-only (on the machine running the server) — switch the engine above to Chrome",
									)}
								</span>
							</div>
						) : null}
					</>
				) : null}

				<label className="voice-row voice-row-select">
					<span className="voice-row-label">
						{t("说完时正在跑", "While a turn is running")}
						<span className="voice-row-hint">
							{steerSupported
								? t(
										"排队 = 等这一轮结束再发；插队 = 打断它，按新指令继续",
										"Queue = sends after this turn; Steer = interrupts it and continues with the new instruction",
									)
								: t(
										"当前引擎只能排队（插队需要 Pi 引擎）",
										"This engine can only queue — steering requires the Pi engine",
									)}
						</span>
					</span>
					<select
						className="voice-select"
						value={voiceInput.submitMode}
						disabled={!steerSupported}
						onChange={(event) =>
							saveVoiceInputSettings({
								...voiceInput,
								submitMode: event.target.value === "steer" ? "steer" : "queue",
							})
						}
					>
						<option value="queue">{t("排队", "Queue")}</option>
						<option value="steer">{t("插队", "Steer")}</option>
					</select>
				</label>
			</section>
		</div>
	);
}
