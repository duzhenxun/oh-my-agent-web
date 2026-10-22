import { currentMobileShell } from "../mobile-shell-dom.ts";
import { useAppState } from "../store.ts";
import { refreshActions } from "../ws.ts";

/**
 * 「想想」：让模型基于当前上下文再给一批下一步建议。
 *
 * 为什么单独一个按钮：它是**生成动作**，和其它建议按钮（点了就发消息）语义不同，
 * 混在一排里容易误点；挪到工具行最左边后，建议行只剩真正可点的建议。
 * 服务端用隐藏回合生成，不污染对话；手机上只给 3 条（屏幕放不下更多）。
 */
export function ThinkButton({ conversationId, running }: { conversationId: string | null; running: boolean }) {
	const { snapshot } = useAppState();
	// 条数来自设置面板（1–5）；手机上再压到 3 条 —— 一排按钮放不下更多
	const configured = snapshot?.settings.thinkCount ?? 5;
	const count = currentMobileShell() ? Math.min(3, configured) : configured;
	const disabled = running || conversationId === null;
	const title = running
		? "这一轮还在跑，等结束再来一批"
		: conversationId === null
			? "先打开一个会话，再让模型想想下一步"
			: "想想：让模型基于当前上下文再给几条下一步建议";
	return (
		<button
			type="button"
			className="tool-chip action-think"
			disabled={disabled}
			title={title}
			onClick={() => {
				if (disabled) return;
				refreshActions(conversationId ?? undefined, count);
			}}
		>
			<span className="tool-icon" aria-hidden="true">
				💡
			</span>
			想想
		</button>
	);
}
