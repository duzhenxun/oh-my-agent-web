/**
 * 语音输入按钮：默认**放进输入框**（左下角那颗小圆钮，用户 2026-11-21：「放到输入框里面去，
 * 放最前面」）；也可以作为可拖动的浮条（`inline={false}`，保留给以后需要浮动的场景）。
 *
 * 为什么是浮条而不是输入框里的一颗按钮（用户 2026-11-21 要的）：输入框右下角已经被
 * 「发送 / 排队 / 插队 / 停止」占满，再加一颗会把文字挤没；浮条还能在手机上放到顺手的位置。
 *
 * 三个阶段（状态机在 `voice-input.ts`）：
 *   - 空闲：🎤 点一下开始听；
 *   - 在听：变红呼吸 —— 说完静音 2.2s 自动发出，点一下是「停」；
 *     这 2.2s 里外圈会按静音进度填充（见 `silence-ring.ts`），填满就发送；
 *   - 要发了：说完就直接发，**没有撤销窗口**（用户 2026-11-21 明确不要这个功能）。
 */
import type { CSSProperties } from "react";
import { useT } from "../use-language.ts";
import { useDraggableBadge } from "../use-draggable-badge.ts";
import { toggleVoiceInput, useVoiceInputStatus, useVoiceSilenceRatio } from "../voice-input.ts";

const POS_KEY = "agent-web.voice.badge.pos";

export function VoiceInputBadge({ inline = false }: { inline?: boolean } = {}) {
	const t = useT();
	const status = useVoiceInputStatus();
	const silence = useVoiceSilenceRatio();
	const drag = useDraggableBadge<HTMLButtonElement>({ storageKey: POS_KEY });
	/** 放进输入框里时：纯按钮，不拖动、不记位置（位置由布局决定） */
	const floating = !inline;
	const listening = status === "listening";
	const sending = status === "sending";

	const title = sending
		? t("正在发送…", "Sending…")
		: listening
			? t(
					"正在听…说完停 2.2 秒会自动发送；点一下立刻停止并保留文字",
					"Listening… it auto-sends after 2.2s of silence; tap to stop and keep the text",
				)
			: t(
					"点一下开始语音输入（按住可拖到任意位置，右键回到默认位置）",
					"Tap to start voice input (drag to move, right-click to reset)",
				);

	const activate = () => {
		// 发送中（本地引擎收尾那几十毫秒）点一下不做任何事：没有撤销窗口了
		if (!sending) toggleVoiceInput();
	};

	return (
		<button
			type="button"
			ref={drag.ref}
			className={`voice-mic${inline ? " is-inline" : ""}${listening ? " is-listening" : ""}${
				sending ? " is-sending" : ""
			}${drag.dragging ? " is-dragging" : ""}`}
			style={floating ? drag.style : undefined}
			onPointerDown={floating ? drag.onPointerDown : undefined}
			onPointerMove={floating ? drag.onPointerMove : undefined}
			onPointerUp={(event) => {
				// 拖完了松手不算点击，否则拖一下就会顺手把听写开关一次
				if (floating && drag.onPointerUp(event)) return;
				activate();
			}}
			onPointerCancel={floating ? drag.onPointerCancel : undefined}
			onClick={(event) => {
				// 键盘（Enter / Space）激活时 detail === 0；指针的点击已在 pointerup 里处理
				if (event.detail === 0) activate();
			}}
			onContextMenu={(event) => {
				// 右键回到默认位置（双击不行：双击就是两次开关）；放进输入框后没有位置可重置
				if (!floating) return;
				event.preventDefault();
				drag.resetPosition();
			}}
			aria-pressed={listening || sending}
			aria-label={title}
			title={title}
		>
			{/* 静音等待的进度环：填满就进那 0.6s 的「⏳ 撤销」窗口 */}
			{listening && silence > 0.02 ? (
				<span
					className="voice-mic-ring"
					style={{ "--voice-progress": String(silence) } as CSSProperties}
					aria-hidden="true"
				/>
			) : null}
			<span aria-hidden="true">{listening || sending ? "■" : "🎤"}</span>
		</button>
	);
}
