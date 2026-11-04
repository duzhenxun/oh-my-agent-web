/**
 * 「状态语音」——**预生成的本地音频片段**（不是浏览器语音合成）。
 *
 * 为什么不用 SpeechSynthesis：这套东西在真机上几乎每次都出点岔子（2026-11-02 的现场）：
 * 网络音色（Chrome 的 Google 普通话）冷启动要 1~2s → 看门狗判死 → 换音色重排；紧接着的
 * `canceled` 又触发唤醒重排；而网络音色的 `cancel()` **掐不断已经出声的句子** —— 于是同一句
 * 「任务已完成」被排了四五次，听起来就是「播了两遍」。`onstart` 还可能根本不回调，代码只能靠猜。
 *
 * 预生成之后播放只有一步：`AudioBufferSourceNode.start()`。没有重试、没有取消、没有网络、
 * 也没有「这台机器装了什么音色」。片段由 `scripts/make-voice-cues.mjs` 生成（中文 + 英文各一套），
 * 合计 130KB 左右，随源码一起发布。
 *
 * 播放仍然借 `sound.ts` 那个 AudioContext：Safari / iOS 只放行「用户手势里建好并 resume 过的」
 * 上下文，另开一个的话，自动触发的那一声永远不响。
 */
import doneZh from "./assets/cues/done.zh.mp3?url";
import doneEn from "./assets/cues/done.en.mp3?url";
import stoppedZh from "./assets/cues/stopped.zh.mp3?url";
import stoppedEn from "./assets/cues/stopped.en.mp3?url";
import steerZh from "./assets/cues/steer.zh.mp3?url";
import steerEn from "./assets/cues/steer.en.mp3?url";
import errorZh from "./assets/cues/error.zh.mp3?url";
import errorEn from "./assets/cues/error.en.mp3?url";
import approvalZh from "./assets/cues/approval.zh.mp3?url";
import approvalEn from "./assets/cues/approval.en.mp3?url";
import { readLanguage, type Language } from "./language.ts";
import {
	audioContextNow,
	isAudioRunning,
	loadSoundSettings,
	playSound,
	soundVolumeOf,
	withinResumeWindow,
	type SoundKind,
} from "./sound.ts";

/** 现在有片段的事件（`start` 只是「嗒」一声，没必要做成语音） */
export type VoiceClipKind = "done" | "stopped" | "steer" | "error" | "approval";

/** 片段清单：kind × language → 打包后的静态资源 URL */
const CLIPS: Record<VoiceClipKind, Record<Language, string>> = {
	done: { zh: doneZh, en: doneEn },
	stopped: { zh: stoppedZh, en: stoppedEn },
	steer: { zh: steerZh, en: steerEn },
	error: { zh: errorZh, en: errorEn },
	approval: { zh: approvalZh, en: approvalEn },
};

/**
 * 片段播不了的时候退回哪个提示音。
 *
 * 「已停止」没有单独的设置项：它听起来就是一轮结束（用完成的「叮」）。
 * 「插队」现在**有**自己的一行了（用户 2026-11-03），提示音也是它自己的两声轻响。
 */
const BEEP_OF: Record<VoiceClipKind, SoundKind> = {
	done: "done",
	stopped: "done",
	steer: "steer",
	error: "error",
	approval: "approval",
};

/** 某个事件 + 语言对应哪个片段（导出给测试用：漏了一条会被当场抓到） */
export function voiceClipUrl(kind: VoiceClipKind, language: Language): string {
	return CLIPS[kind][language];
}

/** 解码结果按 URL 缓存：同一个片段只 decode 一次（decodeAudioData 是这里唯一的重活） */
const decoded = new Map<string, Promise<AudioBuffer | null>>();

function bufferOf(context: AudioContext, url: string): Promise<AudioBuffer | null> {
	const cached = decoded.get(url);
	if (cached) return cached;
	const pending = fetch(url)
		.then((response) => (response.ok ? response.arrayBuffer() : Promise.reject(new Error(String(response.status)))))
		.then((data) => context.decodeAudioData(data))
		.catch((error: unknown) => {
			// 解不出来就忘掉这一次的结果：下次还有机会（比如网络恢复后重新拉到文件）
			decoded.delete(url);
			console.warn("[voice-clips] 状态语音解码失败", url, error);
			return null;
		});
	decoded.set(url, pending);
	return pending;
}

/**
 * 播一句状态语音。
 *
 * 只受「语音播报」总开关（`enabled`）和共用音量控制 —— 每类事件要不要响，是「声音与提示音」
 * 那三行在管（它管的是提示音）；语音是另一层，开了就按事件播对应片段。
 *
 * 响不了（不支持 WebAudio / 自动化被拦 / 解码失败）就**退回提示音**：用户至少知道「跑完了」，
 * 而不是一片安静。
 */
export function playVoiceClip(
	kind: VoiceClipKind,
	options: { language?: Language; volume?: number; force?: boolean } = {},
): void {
	const settings = loadSoundSettings();
	// `force`：面板上的「试听」不受总开关限制（否则用户先关了声音就再也听不到试听的反馈）
	if (!settings.enabled && options.force !== true) return;
	const language = options.language ?? readLanguage();
	const volume = options.volume ?? soundVolumeOf(settings);
	const context = audioContextNow();
	if (!context) {
		playSound(BEEP_OF[kind], settings);
		return;
	}
	const requestedAt = Date.now();
	void bufferOf(context, voiceClipUrl(kind, language))
		.then((buffer) => {
			if (!buffer) {
				playSound(BEEP_OF[kind], settings);
				return;
			}
			// 和提示音一样：用户十秒后才点了一下页面，这时候再念「任务已完成」只会让人误会又完成了一轮
			if (!withinResumeWindow(requestedAt)) return;
			const start = (): void => {
				const source = context.createBufferSource();
				const gain = context.createGain();
				source.buffer = buffer;
				gain.gain.value = volume;
				source.connect(gain);
				gain.connect(context.destination);
				source.start();
			};
			if (isAudioRunning(context)) {
				start();
				return;
			}
			void context
				.resume()
				.then(() => {
					if (!withinResumeWindow(requestedAt)) return;
					if (isAudioRunning(context)) start();
					else playSound(BEEP_OF[kind], settings);
				})
				.catch(() => playSound(BEEP_OF[kind], settings));
		})
		.catch(() => playSound(BEEP_OF[kind], settings));
}

/**
 * 热身：把五类片段提前拉下来解码好。
 *
 * 第一次播报要「fetch + decode」≈几十毫秒，正常情况下感觉不到；但**回答一结束就要出声**，
 * 而那时主线程正在收尾渲染（markdown 重解析最贵的一拍），很可能把这一声拖到半秒后。
 * 所以面板打开 / 应用启动后空闲时先摸一遍，之后每次都是纯播放。
 */
export function preloadVoiceClips(): void {
	const context = audioContextNow();
	if (!context) return;
	for (const kind of Object.keys(CLIPS) as VoiceClipKind[]) {
		for (const language of ["zh", "en"] as const) {
			void bufferOf(context, voiceClipUrl(kind, language));
		}
	}
}
