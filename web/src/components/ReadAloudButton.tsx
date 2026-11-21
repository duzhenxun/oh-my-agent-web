import { useEffect, useRef, useState } from "react";
import { showToast } from "../toast.ts";
import { requestStopSpeech } from "../speech-control.ts";
import { isSpeechAvailable, loadTtsSettings, speak, stopSpeaking, stripMarkdownForSpeech } from "../tts.ts";
import { useT } from "../use-language.ts";

/** 显式朗读整条回复，沿用语音设置；同一时间只有一条回复处于播放状态。 */
export function ReadAloudButton({ text }: { text: string }) {
	const t = useT();
	const [reading, setReading] = useState(false);
	const stop = useRef<(() => void) | null>(null);

	useEffect(() => () => stop.current?.(), [text]);

	const toggle = () => {
		if (stop.current) {
			stop.current();
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
			aria-pressed={reading}
			title={
				!isSpeechAvailable()
					? t("当前浏览器不支持所选语音引擎", "This browser does not support the selected speech engine")
					: reading
						? t("停止朗读", "Stop reading")
						: t("朗读这条回复", "Read this reply aloud")
			}
		>
			<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" strokeWidth={1.5} aria-hidden="true">
				{reading ? (
					<rect x="4" y="4" width="8" height="8" rx="1" fill="currentColor" stroke="none" />
				) : (
					<>
						<path d="M7 3 3.5 6H1.5v4h2L7 13Z" strokeLinejoin="round" />
						<path d="M10 5.5a3.5 3.5 0 0 1 0 5m2-7a6.5 6.5 0 0 1 0 9" strokeLinecap="round" />
					</>
				)}
			</svg>
			<span>{reading ? t("停止朗读", "Stop reading") : t("朗读", "Read aloud")}</span>
		</button>
	);
}
