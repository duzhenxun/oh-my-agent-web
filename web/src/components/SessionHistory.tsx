/**
 * 「完整历史」：把 pi 的**会话导出页**原样嵌进来（右侧面板里的一张标签）。
 *
 * 为什么整页 iframe，而不是把导出内容搬进 React：
 *   - 那本来就是一整页独立文档（自己的 CSS / JS / 语法高亮 / marked），pi 的
 *     `/export` 与 `pi --export` 用的都是这套模板 —— 搬进来就等于抄一份迟早过期的副本；
 *   - 它自己就带「Toggle thinking / Toggle tools / Show hidden messages / ↓ JSONL」这排开关，
 *     以及分支树和顶部统计，搬进来还得重做一遍。
 *
 * 数据从 `/api/sessions/<id>/history` 来（服务端调 pi 的导出器现算），
 * 所以**只有 pi 引擎有**：其它引擎下这颗入口在状态栏里根本不画（见 capabilities.historyExport）。
 *
 * 为什么 iframe 跟着**当前会话**走（`conversationId` 是活的）：这张卡片看的是「我现在这条会话
 * 的全部内容」，切会话时它就该跟着换 —— 就像文件标签会记住自己的路径那样，
 * 只是这里的「路径」是当前会话。
 */
import { useT } from "../use-language.ts";

export function SessionHistory({ conversationId }: { conversationId: string | null }) {
	const t = useT();
	if (!conversationId) {
		return <div className="session-view-empty">{t("先打开一条会话。", "Open a session first.")}</div>;
	}
	return (
		<div className="session-history">
			<iframe
				key={conversationId}
				className="session-history-frame"
				title={t("完整历史", "Full history")}
				src={`/api/sessions/${encodeURIComponent(conversationId)}/history`}
			/>
		</div>
	);
}
