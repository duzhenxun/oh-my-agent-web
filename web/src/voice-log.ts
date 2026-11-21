/**
 * 语音诊断日志：把状态机的关键节点 POST 给宿主，写进**服务端**那一份日志。
 *
 * 为什么走服务端日志而不是 `console.log`：语音出问题的时候人往往不看 DevTools，
 * 而宿主日志是唯一「事后能翻」的地方（`~/.oh-my-agent-web/logs/agent-web.log`）。
 *
 * 三条约束：
 *   1. **绝不影响功能**：fire-and-forget，失败一律吞掉，没有重试；
 *   2. **不刷屏**：10 秒窗口内最多 120 条，超了直接丢（识别 partial 每 300ms 一条，
 *      一次长听写也就几十条）；
 *   3. **不写长文本**：只发长度 + 前若干字，正文不进日志（`server/http/client-log-routes.ts`
 *      那边还会再裁一遍）。
 */
const ENDPOINT = "/api/client-log";
/** 窗口内上限：正常一次听写远达不到，只有在死循环里才会触发，那时丢日志比拖慢页面好 */
const MAX_PER_WINDOW = 120;
const WINDOW_MS = 10_000;

let windowStart = 0;
let windowCount = 0;

/**
 * 文本摘要：只留长度和前 24 个字（排查看的是「出没出字」和「出到哪」）。
 *
 * 字段是**扁平**的两个 key（`textLen` / `textHead`），调用方用展开语法放进 detail：
 * 服务端那层只保留短标量，嵌套对象会被压成 `[object]` —— 那就白记了。
 */
export function textSummary(text: string): { textLen: number; textHead: string } {
	return { textLen: text.length, textHead: text.slice(0, 24) };
}

export function voiceLog(event: string, detail?: Record<string, unknown>): void {
	const now = Date.now();
	if (now - windowStart > WINDOW_MS) {
		windowStart = now;
		windowCount = 0;
	}
	if (windowCount >= MAX_PER_WINDOW) return;
	windowCount += 1;
	try {
		void fetch(ENDPOINT, {
			method: "POST",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(detail ? { event, detail } : { event }),
			// 页面正在关 / 切换会话时也要发出去（keepalive 允许在卸载后继续）
			keepalive: true,
		}).catch(() => undefined);
	} catch {
		// fetch 本身不可用（极老浏览器 / 被策略禁用）：诊断日志没了就没了吧
	}
}
