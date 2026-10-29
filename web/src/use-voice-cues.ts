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
import { playSound } from "./sound.ts";
import type { Snapshot } from "./types.ts";
import { loadTtsSettings, speak, speakLine, stripMarkdownForSpeech } from "./tts.ts";
import type { TtsSettings } from "./tts.ts";
import type { UiMessage } from "./types.ts";
import { createCueMemory, planCues } from "./voice-cue-logic.ts";

/**
 * 自动播报：**失败不弹提示**（以前是「每次打开页面最多一条」的长红字 toast，用户要求去掉）。
 *
 * 为什么现在敢静默：那条 toast 出现得最频繁的场景，恰恰是「这台机器的语音服务本来就念不出来」——
 * 于是它变成了每次开场必弹的一条噪声，而且信息量跟用户的动作无关（他没点任何东西）。
 * 现在失败仍然**不丢**，只是换了出口：
 *   - `tts.ts` 的 `speak()` 在 console 里留 `[tts] …` 现场（错误码 / 挑到的音色 / 可用音色数）；
 *   - 用户主动去 设置 → 声音与语音 点「试听 / 诊断」时，面板照样给一行能照做的红字和「唤醒并重试」。
 * 换句话说：**不主动打扰，但一查就有**。
 */
function speakAuto(text: string, tts: TtsSettings): void {
	speak(text, tts);
}

/** 助手消息里的纯文本（正文块，去掉 markdown） */
function assistantSpeech(message: UiMessage): string {
	const text = message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((chunk) => chunk.trim() !== "")
		.join("\n");
	return stripMarkdownForSpeech(text);
}

export function useVoiceCues(snapshot: Snapshot | null): void {
	const memory = useRef(createCueMemory());

	useEffect(() => {
		if (!snapshot) return;
		for (const cue of planCues(memory.current, snapshot)) {
			if (cue.kind === "start") {
				playSound("start");
				continue;
			}
			if (cue.kind === "approval") {
				playSound("approval");
				const tts = loadTtsSettings();
				if (tts.enabled && tts.announce) speakLine("approval", tts);
				continue;
			}
			if (cue.kind === "error") {
				playSound("error");
				const tts = loadTtsSettings();
				if (tts.enabled && tts.announce) speakLine("error", tts);
				continue;
			}
			// done
			playSound("done");
			const tts = loadTtsSettings();
			if (!tts.enabled) continue;
			if (tts.readReplies && cue.message) {
				const body = assistantSpeech(cue.message);
				if (body !== "") {
					speakAuto(body, tts);
					continue;
				}
			}
			if (tts.announce) speakLine("done", tts);
		}
	}, [snapshot]);
}
