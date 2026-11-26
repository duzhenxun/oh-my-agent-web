/**
 * 一次性清理**旧的本机界面偏好**，让新默认值真正生效。
 *
 * 为什么要它：这些偏好都按「本地存过的值永远优先」读（`readStoredBool`），
 * 这对升级是正确的（用户选过的东西不能被新版悄悄改回去），但也意味着
 * **改默认值只对新装的机器有效** —— 已经用过的机器上还留着旧的一批
 * （顶栏勾了语音/MCP、底部全显示、内容宽度是满宽、快捷指令那排开着…）。
 * 用户 2026-11-24：「清空旧配置让默认生效」。
 *
 * 三个纪律：
 *   1. **只清我们重新定过默认值的那几类**（见下面的表），不碰主题、语言、栏宽、
 *      会话折叠这些跟本次默认值无关的选择 —— 一次「恢复默认」不该顺手把人家的配色也抹了；
 *   2. **只跑一次**：跑完写一个标记 key，之后永远不再动。要再来一遍就删掉那个 key
 *      （`localStorage.removeItem("agent-web.prefs-reset.v1")`，或用设置里的「恢复默认」）；
 *   3. **首帧前跑**：`main.tsx` 里放在 `initChatDisplay()` 之前 —— 清完再读，
 *      第一屏画出来的就是新默认，不会先按旧值排一遍再跳。
 *
 * 清完之后各处的读法不变：读到「没存过」就走默认值（顶栏 模型/定时任务/技能、
 * 底部 设置/引擎/审批、外观全用标准档）。
 */

/** 标记：这一轮清理做过了。改清理范围时把版本号 +1（v2…），老的标记就自然失效 */
const RESET_MARKER = "agent-web.prefs-reset.v1";

/** 前缀命中的整组 key（一组里每一项都是「显隐勾选」这类可以回默认的东西） */
const PREFIXES = ["agent-web.appbar.", "agent-web.statusbar.", "agent-web.composer."];

/** 逐个点名的 key：外观尺寸 + 底部顺序（顺序是 `statusbar-order.ts` 自己的一份） */
const EXACT = [
	// 底部状态栏顺序（`statusbar-order.ts`）
	"agent-web.statusbar-order.v1",
	// 外观：内容宽度 + 三处字号（含各自的老 key，见 chat-display / sidebar-font）
	"agent-web.chat-width",
	"agent-web.chat-font.v2",
	"agent-web.chat-font",
	"agent-web.sidebar-project-font.v2",
	"agent-web.sidebar-project-font",
	"agent-web.sidebar-session-font.v2",
	"agent-web.sidebar-session-font",
	// 顶栏高度：设置已移除（2026-11-24），这里留着只为把老用户存过的值清掉
	"agent-web.appbar-scale.v2",
	"agent-web.appbar-scale",
];

/**
 * 清一次旧偏好（幂等：清过就直接返回）。
 *
 * 读不了 localStorage（隐私模式 / 配额满）就当没这回事：这时候本来也没有旧值可清。
 */
export function resetLegacyPrefsOnce(): void {
	try {
		if (localStorage.getItem(RESET_MARKER) === "1") return;
		// 先收集再删：边遍历边删会让索引错位，漏掉一半
		const doomed: string[] = [];
		for (let index = 0; index < localStorage.length; index += 1) {
			const key = localStorage.key(index);
			if (key === null || key === RESET_MARKER) continue;
			if (EXACT.includes(key) || PREFIXES.some((prefix) => key.startsWith(prefix))) doomed.push(key);
		}
		for (const key of doomed) localStorage.removeItem(key);
		localStorage.setItem(RESET_MARKER, "1");
	} catch {
		// 隐私模式禁 localStorage：没存过值，本来就用的是默认值
	}
}
