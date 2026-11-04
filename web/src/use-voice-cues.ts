/**
 * 把「回合状态变化」翻译成提示音 + 语音播报。
 *
 * 为什么集中在 hook 里而不是散在组件里：提示音只关心**状态跳变**（开始 / 结束 /
 * 出错 / 等审批），跟谁渲染那一块界面无关；放一处才能保证「一轮只响一次」。
 *
 * 判定逻辑全部在 `voice-cue-logic.ts`（纯函数、可回归）；这里只负责：
 *   1. 把 snapshots 喂给判定器；
 *   2. 按判定结果放声音、念句子。
 */
import { useEffect, useRef } from "react";
import { loadSoundSettings, playSound } from "./sound.ts";
import type { Snapshot } from "./types.ts";
import { loadTtsSettings, speak, stripMarkdownForSpeech } from "./tts.ts";
import type { TtsSettings } from "./tts.ts";
import type { UiMessage } from "./types.ts";
import { playVoiceClip, preloadVoiceClips } from "./voice-clips.ts";
import {
	createAnnounceMemory,
	createCueMemory,
	planCues,
	shouldAnnounceDone,
	voiceChannelOf,
} from "./voice-cue-logic.ts";
import type { Cue } from "./voice-cue-logic.ts";

/**
 * 自动播报：**失败不弹提示**（以前是「每次打开页面最多一条」的长红字 toast，用户要求去掉）。
 *
 * 为什么现在敢静默：那条 toast 出现得最频繁的场景，恰恰是「这台机器的语音服务本来就念不出来」——
 * 于是它变成了每次开场必弹的一条噪声，而且信息量跟用户的动作无关（他没点任何东西）。
 * 现在失败仍然**不丢**，只是换了出口：
 *   - `tts.ts` 的 `speak()` 在 console 里留 `[tts] …` 现场（错误码 / 挑到的音色 / 可用音色数）；
 *   - 用户主动去 设置 → 声音与语音 点「试听 / 诊断」时，面板照样给一行能照做的红字和「唤醒并重试」。
 * 换句话说：**不主动打扰，但一查就有**。
 *
 * 另外自动播报**自己会多试一次**（见 `speakAuto`）：用户报的现象是「任务已完成」经常没声，
 * 而系统语音服务被唤醒之后，往往要隔一拍再重新排一句才真的出声（那时候队列也干净）。
 */
function speakAuto(text: string, tts: TtsSettings, attempt = 0): void {
	// 自愈失败（服务真的卡了一下）时再给一次机会：`speak()` 里那两轮唤醒已经把系统语音服务
	// 踢过了，隔一拍重新排一句往往就出声了（此时队列也是干净的，不会再被 cancel 连坐）。
	// 只补一次：再往上堆就变成延迟播报，用户已经走神了。
	speak(
		text,
		tts,
		attempt >= 1
			? {}
			: {
					onIssue: (_message, issue) => {
						if (!issue.wakeable) return;
						window.setTimeout(() => speakAuto(text, tts, attempt + 1), AUTO_RETRY_MS);
					},
				},
	);
}

/** 自动播报失败后再试一次的间隔：够唤醒落地，又不至于让人以为「刚才那声是别的」 */
const AUTO_RETRY_MS = 1200;

/** 助手消息里的纯文本（正文块，去掉 markdown） */
function assistantSpeech(message: UiMessage): string {
	const text = message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((chunk) => chunk.trim() !== "")
		.join("\n");
	return stripMarkdownForSpeech(text);
}

type DoneCue = Extract<Cue, { kind: "done" }>;
/** 收尾那两类：「跑完了」和「被停掉」—— 都要出声，但说的不是同一句话 */
type EndCue = Extract<Cue, { kind: "done" | "stopped" }>;
const isDoneCue = (cue: EndCue): cue is DoneCue => cue.kind === "done";

/**
 * 一拍里的多条完成只朗读**一条**回复（开了「朗读回复」才会走到这里）。
 *
 * 优先当前会话：并行 / 后台会话一起收尾时，把两条回复串起来念只会糊成一团，
 * 而用户最想听的就是眼前这条。没有可用文本就返回空串（那就只响提示音）。
 */
function replyToRead(cues: DoneCue[], activeId: string | null): string {
	const ordered = activeId === null ? cues : [...cues.filter((cue) => cue.conversationId === activeId), ...cues];
	for (const cue of ordered) {
		if (!cue.message) continue;
		const body = assistantSpeech(cue.message);
		if (body !== "") return body;
	}
	return "";
}

export function useVoiceCues(snapshot: Snapshot | null): void {
	const memory = useRef(createCueMemory());
	// 「完成」声音那一层的去抖记忆（同一拍合并 + 1.5s 内只响一次），见 voice-cue-logic.ts
	const announced = useRef(createAnnounceMemory());

	useEffect(() => {
		if (!snapshot) return;
		const cues = planCues(memory.current, snapshot);
		if (cues.length === 0) return;
		const tts = loadTtsSettings();
		const sound = loadSoundSettings();
		/** 收尾（完成 / 被停掉）单独攒起来：并行 / 后台会话一起收尾时，它们得合成一次 */
		const ends: EndCue[] = [];
		for (const cue of cues) {
			if (cue.kind === "done" || cue.kind === "stopped") {
				ends.push(cue);
				continue;
			}
			/**
			 * 插队有自己的开关（设置 → 声音 → 插队，用户 2026-11-03）：关掉就**彻底不响** ——
			 * 提示音和语音片段都不播。别的事件是「提示音归勾选、片段归语音总开关」，
			 * 唯独插队只有这一句「有新任务插队」，不在这里拦一道的话，取消勾选在开了语音时等于没效果。
			 */
			if (cue.kind === "steer" && !sound.steer) continue;
			// 开始 / 出错 / 等审批 / 插队：语音开着就播**预生成的本地片段**，否则只响提示音。
			// 不再走语音合成（固定句子合成在真机上会重复播，2026-11-02）。
			const channel = voiceChannelOf({
				kind: cue.kind,
				voiceEnabled: tts.enabled,
				readReplies: tts.readReplies,
				hasReply: false,
			});
			// 「开始」只有一记轻响、没有片段；插队现在有自己的片段和提示音（`BEEP_OF.steer`）
			if (channel === "clip" && cue.kind !== "start") playVoiceClip(cue.kind);
			else playSound(cue.kind);
		}
		if (ends.length === 0) return;
		/**
		 * 两条会话在同一拍收尾时，以前是两句「任务已完成」先后出声（音频层还会把前一句咬掉重念），
		 * 听感就是「重复播了两遍」。现在：**同一拍合并成一次**（只念一条回复 / 只播一个片段），并且
		 * 1.5s 内不再重复响（并行收尾也常落在相邻的两拍里）。
		 *
		 * 合并时当前会话优先：用户最关心眼前这条是「完成」还是「被停掉」（2026-11-03）。
		 */
		const primary = ends.find((cue) => cue.conversationId === snapshot.active.conversationId) ?? ends[0]!;
		const reply =
			primary.kind === "done" && tts.enabled && tts.readReplies
				? replyToRead(ends.filter(isDoneCue), snapshot.active.conversationId)
				: "";
		const channel = voiceChannelOf({
			kind: primary.kind,
			voiceEnabled: tts.enabled,
			readReplies: tts.readReplies,
			hasReply: reply !== "",
		});
		const nature = primary.kind === "stopped" ? "stopped" : "done";
		if (!shouldAnnounceDone(announced.current, channel === "reply" ? reply : null, Date.now(), nature)) return;
		if (channel === "reply") speakAuto(reply, tts);
		else if (channel === "clip") playVoiceClip(nature);
		else playSound("done");
	}, [snapshot]);
	// 空闲时先把三类片段拉下来解码好：回答一结束就要出声，那一拍主线程正在收尾渲染，
	// 现场 fetch + decode 可能把声音拖后半秒（只解码、不播放，不需要先解锁上下文）。
	useEffect(() => {
		const timer = window.setTimeout(preloadVoiceClips, 2000);
		return () => window.clearTimeout(timer);
	}, []);
}
