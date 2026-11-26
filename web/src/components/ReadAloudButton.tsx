import { useEffect, useRef, useState } from "react";
import { showToast } from "../toast.ts";
import { onStopManualSpeechRequest, requestStopSpeech, useReading } from "../speech-control.ts";
import { isSpeechAvailable, loadTtsSettings, speak, stopSpeaking, stripMarkdownForSpeech } from "../tts.ts";
import { useT } from "../use-language.ts";

/**
 * 「朗读」那颗按钮 —— **朗读 / 停止一体**（用户 2026-11-24：「点一下朗读就变成停止」
 * 「朗读时让那个小喇叭变成蓝色、在动的样子」）。
 *
 * 以前它旁边还挂着两条独立的「暂停 / 停止」（`SpeechStopBadge` 的 docked 档），
 * 用户后来把那一块撤了：同一件事分三颗按钮，尾注太吵。现在只有这一颗：
 *   没在念 → 喇叭 + 「朗读」，点一下开始念；
 *   正在念 → 同一个喇叭**变蓝并跳动**，文字变「停止」，点一下停掉（自己念的、或者后台
 *            自动播报的那一轮都停：`requestStopSpeech()` 同时叫停流式朗读）。
 *
 * 「暂停」不再有按钮（说话时自动暂停那条机制还在，见 `speech-control.ts`）。
 */
export function ReadAloudButton({ text }: { text: string }) {
	const t = useT();
	const [reading, setReading] = useState(false);
	const stop = useRef<(() => void) | null>(null);
	/** 后台/自动播报在念：按钮也要显示成「停止」，否则点它等于同时开第二路朗读 */
	const autoReading = useReading();
	const active = reading || autoReading;

	useEffect(() => () => stop.current?.(), [text]);
	/**
	 * 「往下走了」就把这条朗读停掉：发下一条消息（含插队）、切会话、别处点停止都会广播
	 * （见 `speech-control.ts` 的 `requestStopManualSpeech`）。用户 2026-11-24：
	 * 「我都在操作下一个了，播放还在上面」—— 旧消息不该在后台继续念。
	 */
	useEffect(
		() =>
			onStopManualSpeechRequest(() => {
				if (!stop.current) return;
				stop.current();
			}),
		[],
	);

	const toggle = () => {
		if (stop.current) {
			stop.current();
			return;
		}
		// 自动播报正在念：这一下是「停」，不是「再念一遍」
		if (autoReading) {
			requestStopSpeech();
			stopSpeaking();
			setReading(false);
			return;
		}
		// 自动播报仍用默认的 400 字上限；手动点「朗读」要能听完整条回复。
		const body = stripMarkdownForSpeech(text, Infinity);
		if (!body) {
			showToast({ text: t("这条回复没有可朗读的文字", "This reply has no text to read aloud") });
			return;
		}

		let active = true;
		const reset = () => {
			if (!active) return;
			active = false;
			stop.current = null;
			setReading(false);
		};
		const finish = () => {
			if (!active) return;
			// 同时叫停流式朗读：否则这条读完，后台那一条还在接着念
			requestStopSpeech();
			stopSpeaking();
			reset();
		};
		stop.current = finish;
		setReading(true);
		speak(body, loadTtsSettings(), {
			onCancel: reset,
			onEnd: finish,
			onIssue: (message) => {
				finish();
				showToast({ text: message });
			},
		});
	};

	return (
		<button
			type="button"
			className="msg-foot-copy msg-foot-read-aloud"
			onClick={toggle}
			disabled={!isSpeechAvailable()}
			aria-pressed={active}
			title={
				!isSpeechAvailable()
					? t("当前浏览器不支持所选语音引擎", "This browser does not support the selected speech engine")
					: active
						? t("停止朗读", "Stop reading")
						: t("朗读这条回复", "Read this reply aloud")
			}
		>
			{/* 图标始终是那只喇叭：念起来的时候**变蓝 + 跳动**（CSS 里按 aria-pressed 走），
			 * 不再换成方块 —— 方块读起来像「播放器」，跟「在念」这个状态对不上。 */}
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
				<path d="M7 3 3.5 6H1.5v4h2L7 13Z" strokeLinejoin="round" />
				<path d="M10 5.5a3.5 3.5 0 0 1 0 5m2-7a6.5 6.5 0 0 1 0 9" strokeLinecap="round" />
			</svg>
			<span>{active ? t("停止", "Stop") : t("朗读", "Read aloud")}</span>
		</button>
	);
}
