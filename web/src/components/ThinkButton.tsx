import { useEffect, useRef, useState } from "react";
import { currentMobileShell } from "../mobile-shell-dom.ts";
import { useAppState } from "../store.ts";
import { refreshActions } from "../ws.ts";
import { useT } from "../use-language.ts";

/** 兜底：即使回包一直没来，也不会把按钮永久钉在置灰态（服务端自己也会超时中断） */
const GUARD_SLACK_SEC = 5;

/**
 * 「想想」：让模型基于当前上下文再给一批下一步建议。
 *
 * 为什么单独一个按钮：它是**生成动作**，和其它建议按钮（点了就发消息）语义不同，
 * 混在一排里容易误点；挪到工具行最左边后，建议行只剩真正可点的建议。
 * 服务端用隐藏回合生成，不污染对话；手机上只给 3 条（屏幕放不下更多）。
 *
 * **点一下立刻置灰**：服务端这一下是跑一个隐藏回合（默认最多 20 秒才回包，
 * 手机网络更慢），不回包前按钮要是照常亮着，看起来就是「点了没反应」。
 * 所以点击后马上本地进 `busy`（disabled + 变灰），等 `refreshActions` 的 promise
 * 在回包时 resolve 再亮回来；另外挂一个比服务端超时多一些的兜底定时器。
 */
export function ThinkButton({ conversationId, running }: { conversationId: string | null; running: boolean }) {
	const t = useT();
	const { snapshot } = useAppState();
	// 条数来自设置面板（1–5）；手机上再压到 3 条 —— 一排按钮放不下更多
	const configured = snapshot?.settings.thinkCount ?? 5;
	const count = currentMobileShell() ? Math.min(3, configured) : configured;
	const [busy, setBusy] = useState(false);
	const guard = useRef<ReturnType<typeof setTimeout> | null>(null);
	useEffect(
		() => () => {
			if (guard.current !== null) clearTimeout(guard.current);
		},
		[],
	);
	const disabled = running || conversationId === null || busy;
	const title = busy
		? t("正在想想…结果出来这颗按钮就亮回来", "Thinking… the button lights up again once the suggestions arrive")
		: running
			? t("这一轮还在跑，等结束再来一批", "This turn is still running — ask again when it ends")
			: conversationId === null
				? t("先打开一个会话，再让模型想想下一步", "Open a conversation first, then let the model suggest next steps")
				: t(
						"想想：让模型基于当前上下文再给几条下一步建议",
						"Think: ask the model for a few next-step suggestions from the current context",
					);
	const stopBusy = () => {
		if (guard.current !== null) {
			clearTimeout(guard.current);
			guard.current = null;
		}
		setBusy(false);
	};
	return (
		<button
			type="button"
			className={`tool-chip action-think${busy ? " action-think-busy" : ""}`}
			disabled={disabled}
			aria-busy={busy}
			title={title}
			onClick={() => {
				if (disabled) return;
				// 先置灰：这一行必须在发请求**之前**，手机上点完才能立刻看到反应
				setBusy(true);
				const timeoutSec = snapshot?.settings.thinkTimeoutSec ?? 20;
				if (guard.current !== null) clearTimeout(guard.current);
				guard.current = setTimeout(stopBusy, (timeoutSec + GUARD_SLACK_SEC) * 1000);
				void refreshActions(conversationId ?? undefined, count).finally(stopBusy);
			}}
		>
			<span className="tool-icon" aria-hidden="true">
				💡
			</span>
			{t("想想", "Think")}
		</button>
	);
}
