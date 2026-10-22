import type { ActionItem } from "../types.ts";
import { setDraft } from "../store.ts";
import { sendMessage } from "../ws.ts";

/**
 * 模型给出的「下一步建议」（ADR-0022）：
 * 模型在回复里写 `[[action:suggest:…]]`，服务端剥掉标记后把建议项放进快照，这里渲染成按钮。
 *
 * 交互与快捷短语一致：**点击直接发送**，**Shift+点击只填入输入框**。
 * 触发「再给一批」的按钮不在这里（在输入区工具行最左边，见 ThinkButton）。
 */
export function ActionSuggestions({ actions, running }: { actions: ActionItem[]; running: boolean }) {
	// 回合进行中不显示：建议是「这一轮结束后往哪走」，边生成边挂在下面会跟着流式乱跳，
	// 也容易被误点（点下去只会变成排队）。等这一轮结束再出现。
	if (running) return null;
	if (actions.length === 0) return null;
	return (
		<div className="action-row">
			{actions.map((action) => (
				<button
					type="button"
					key={action.id}
					className="action-btn"
					disabled={running}
					title={`${action.label}\n发送：${action.prompt}\n（Shift+点击只填入输入框）`}
					onClick={(event) => {
						if (event.shiftKey) {
							setDraft(action.prompt);
							return;
						}
						if (running) return;
						sendMessage(action.prompt);
					}}
				>
					{action.label}
				</button>
			))}
		</div>
	);
}
