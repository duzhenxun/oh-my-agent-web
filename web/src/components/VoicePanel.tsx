/**
 * 「声音与语音」面板（独立 Tab，排在 MCP 后面）。
 *
 * 两块：
 *   - 声音提示：开始 / 结束 / 出错 / 等待审批各一枚提示音，可单独开关 + 试听，带总音量；
 *   - 语音播报（本地 TTS）：用浏览器内置语音合成，回答结束时说一句「工作已完成」
 *     （也可以改成朗读 AI 的最终回复），可调语速、挑音色。
 *
 * 设置全部存本机（localStorage）：音量/音色/语速都是「这台机器」的属性，不该多端同步。
 */
import { useEffect, useState } from "react";
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
	TTS_LINE,
	describeSpeechError,
	diagnoseSpeech,
	isTtsAvailable,
	listVoices,
	loadTtsSettings,
	saveTtsSettings,
	speak,
	stopSpeaking,
	subscribeVoices,
	wakeSpeechService,
	type TtsSettings,
	type VoiceOption,
} from "../tts.ts";
import { useT } from "../use-language.ts";

const SOUND_KINDS: SoundKind[] = ["start", "done", "error", "approval"];

export function VoicePanel() {
	const t = useT();
	const [sound, setSound] = useState<SoundSettings>(() => loadSoundSettings());
	const [tts, setTts] = useState<TtsSettings>(() => loadTtsSettings());
	const [voices, setVoices] = useState<VoiceOption[]>(() => listVoices());
	/** 试听失败/没响的原因（成功开始念就清掉）：合成失败在浏览器里是静默的，不给提示就只能瞎猜 */
	const [voiceIssue, setVoiceIssue] = useState<string | null>(null);
	/**
	 * 这次失败「唤一下服务再重试」有没有意义（`SpeakIssue.wakeable` / 诊断结论）。
	 * 只有它是 true 时才显示「唤醒并重试」—— 换音色、联网这类问题给这颗按钮只是让人白点。
	 */
	const [issueWakeable, setIssueWakeable] = useState(false);
	/** 正在念（按钮跟着变）：「点了没反应」本身就是个 bug */
	const [previewing, setPreviewing] = useState(false);
	/** 中性状态行（正在播放 / 已念完），与红色失败原因分开 */
	const [voiceStatus, setVoiceStatus] = useState<string | null>(null);
	const available = isTtsAvailable();
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

	const patchSound = (patch: Partial<SoundSettings>) => {
		const next = { ...sound, ...patch };
		setSound(next);
		saveSoundSettings(next);
	};
	const patchTts = (patch: Partial<TtsSettings>) => {
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
	const noOnlineVoice = tts.allowOnline && voices.length === 0;
	/** 试听：跳过「总开关关着」「这一项关着」的判断 —— 试听本来就是显式意图 */
	const preview = (kind: SoundKind) => playSound(kind, { ...sound, enabled: true, [kind]: true, volume: sound.volume });
	/**
	 * 试听语音：**必须给反馈**。
	 * 浏览器的合成失败是静默的（不报错、就是没声音），没有这条提示用户只能猜「是不是坏了」。
	 * 所以每种结果都落到界面上：按钮变「试听中」、念完恢复、失败给一句能照做的原因。
	 */
	const previewVoice = () => {
		setVoiceIssue(null);
		setIssueWakeable(false);
		setVoiceStatus(t("正在播放…", "Speaking…"));
		setPreviewing(true);
		let started = false;
		const settle = () => setPreviewing(false);
		speak(
			TTS_LINE.done,
			{ ...tts, enabled: true },
			{
				onStart: () => {
					started = true;
					setVoiceIssue(null);
					setVoiceStatus(t("正在念：任务已完成", "Speaking: task complete"));
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
		// tts.ts 自己会报更具体的原因（音色不可用 / 语音服务没响应），这里只当最后的兼底
		window.setTimeout(() => {
			if (started) return;
			settle();
			setVoiceStatus(null);
			setIssueWakeable(true);
			setVoiceIssue(
				(prev) =>
					prev ??
					t(
						"点了没出声：系统语音服务没有响应（换一个音色再试；若选了在线音色，先确保能联网）",
						"No sound: the system speech service did not respond (try another voice; online voices need network)",
					),
			);
		}, 4000);
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
							{t(SOUND_LABEL[kind].title)}
							<span className="voice-row-hint">{t(SOUND_LABEL[kind].hint)}</span>
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
							{available
								? t("使用浏览器内置语音合成，不联网", "Uses the browser's built-in speech synthesis, no network")
								: t("当前浏览器不支持语音合成", "This browser does not support speech synthesis")}
						</span>
					</span>
					<input type="checkbox" checked={tts.enabled} onChange={() => patchTts({ enabled: !tts.enabled })} />
				</label>

				<label className="voice-row">
					<span className="voice-row-label">
						{t("播报事件", "Announce events")}
						<span className="voice-row-hint">
							{t("完成 / 出错 / 等待审批时念一句短话", "Speaks a short line on finish / error / waiting for approval")}
						</span>
					</span>
					<input type="checkbox" checked={tts.announce} onChange={() => patchTts({ announce: !tts.announce })} />
				</label>

				<label className="voice-row">
					<span className="voice-row-label">
						{t("朗读回复", "Read replies aloud")}
						<span className="voice-row-hint">
							{t("回答结束时朗读 AI 的最终回复", "Reads the AI's final reply when the answer ends")}
						</span>
					</span>
					<input
						type="checkbox"
						checked={tts.readReplies}
						onChange={() => patchTts({ readReplies: !tts.readReplies })}
					/>
				</label>

				<div className="voice-row voice-row-slider">
					<span className="voice-row-label">{t("语速", "Rate")}</span>
					<input
						type="range"
						min={0.5}
						max={2}
						step={0.1}
						value={tts.rate}
						onChange={(event) => patchTts({ rate: Number(event.target.value) })}
					/>
					<span className="voice-value mono">{tts.rate.toFixed(1)}×</span>
				</div>

				{/* 音量跟着「语速」放：两块都是滑杆，挨在一起才好对比着调。
				    它管的是**提示音**（提示音走 WebAudio，播报的是浏览器自己的响度），
				    标签写成「提示音音量」，免得被当成语音播报的音量。 */}
				<div className="voice-row voice-row-slider">
					<span className="voice-row-label">{t("提示音音量", "Cue volume")}</span>
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
				</div>

				<div className="voice-row voice-row-select">
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
				<label className="voice-row">
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
						onClick={previewVoice}
						disabled={!available || previewing}
						title={t("点一下就会念一句，成功/失败都有提示", "Speaks a line; you always get a result")}
					>
						{previewing ? t("试听中…", "Speaking…") : `${t("试听", "Preview")}「${t(TTS_LINE.done)}」`}
					</button>
					<button type="button" className="btn btn-tiny" onClick={stopSpeaking}>
						{t("停止", "Stop")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => void runDiagnosis()}
						title={t("绕过本项目所有设置，直接问浏览器能不能念", "Bypasses all settings and asks the browser directly")}
					>
						{t("诊断", "Diagnose")}
					</button>
					<button
						type="button"
						className="btn btn-tiny"
						onClick={() => {
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
						{issueWakeable && available ? (
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
		</div>
	);
}
