/**
 * 浏览器诊断日志（临时观测通道）。
 *
 * 为什么需要：语音输入的状态机几乎全在浏览器里（麦克风、静音判定、flush、自动发送），
 * 宿主侧只看得到「最后有没有提交」，中间卡在哪一步完全不可见 —— 排查时只能靠猜。
 * 这个端点把网页里那几个关键节点写进**同一份服务端日志**，出问题直接 grep。
 *
 * 与「网页代理」「终端」那些口子不同，这条通道**只能写日志**：
 *   - 不读文件、不执行命令、不影响会话状态；
 *   - 请求体限长（`express.json` 默认 100KB），字段一律裁剪成短字符串 / 数字 / 布尔；
 *   - 越界或畸形的请求直接丢，不报错（诊断日志不该反过来变成噪声源）。
 *
 * 级别是 `info`：终端里不刷屏（前台只显示 warn/error），但一定会进日志文件 ——
 * 「下次一试就能查到」是这个通道存在的唯一意义，所以不压到 debug。
 */
import type { Express } from "express";
import type { Logger } from "../util/log.js";

/** 事件名上限：够写 `flush:end` 这种，又不至于被塞进来一整段文本 */
const MAX_EVENT_CHARS = 48;
/** 单个上下文值的上限（和 logger 的裁剪口径一致） */
const MAX_VALUE_CHARS = 160;
/** 上下文最多几项（防止有人把整个快照 POST 上来） */
const MAX_CONTEXT_KEYS = 12;
/** 数组最多保留几项 */
const MAX_ARRAY_ITEMS = 8;

type Detail = Record<string, unknown>;

/** 裁剪一个值：只留能一眼看懂的短标量（嵌套对象一律字符串化后截断） */
function trimValue(value: unknown): unknown {
	if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
	if (typeof value === "boolean" || value === null) return value;
	if (typeof value === "string") return value.length > MAX_VALUE_CHARS ? `${value.slice(0, MAX_VALUE_CHARS)}…` : value;
	if (Array.isArray(value)) return value.slice(0, MAX_ARRAY_ITEMS).map((item) => (typeof item === "object" ? "[object]" : item));
	if (typeof value === "object" && value !== null) {
		// 展开**一层**：嵌套对象写成 `[object]` 等于没记，展开一层既看得懂又不会无界
		const nested: Detail = {};
		for (const [key, child] of Object.entries(value as Detail).slice(0, 4)) {
			nested[key.slice(0, 16)] = typeof child === "object" ? "[object]" : trimValue(child);
		}
		return nested;
	}
	return "[object]";
}

function trimDetail(detail: unknown): Detail | undefined {
	if (!detail || typeof detail !== "object" || Array.isArray(detail)) return undefined;
	const out: Detail = {};
	for (const [key, value] of Object.entries(detail as Detail).slice(0, MAX_CONTEXT_KEYS)) {
		out[key.slice(0, 24)] = trimValue(value);
	}
	return Object.keys(out).length > 0 ? out : undefined;
}

export function registerClientLogRoutes(app: Express, logger: Logger): void {
	const webLog = logger.child("web");
	app.post("/api/client-log", (request, response) => {
		// 先回包：诊断日志失败绝不能阻塞页面（发送端是 fire-and-forget，也不看响应）
		response.json({ ok: true });
		const body = request.body as { event?: unknown; detail?: unknown } | undefined;
		const event = typeof body?.event === "string" ? body.event.trim() : "";
		if (!event) return;
		webLog.info(event.slice(0, MAX_EVENT_CHARS), trimDetail(body?.detail));
	});
}
