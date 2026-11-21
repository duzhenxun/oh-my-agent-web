/**
 * 「在对话里改外观字号」的宿主侧逻辑（ADR-0050）。
 *
 * 分层和 `cron/tool.ts` 一样：**纯函数 + 窄端口**留在宿主，引擎只负责把模型的参数递进来。
 * 这样三条规则能单测、引擎层也不用认识 settings.json / 快照。
 *
 * 三条规则（用户 2026-11-21 明确要的）：
 *   1. **先读后改**：`read()` 报当前值 —— 说「字太小」时先知道现在是 14 还是 20；
 *   2. **改完报差值**：`describeChange(before, after)` 一定给出 `14 → 18px` 这种可核对的话；
 *   3. **只认合法档**：2–30px、双数（和界面滑杆同刻度，见 `web/src/font-scale.ts`）。
 */
import type { AppearanceView } from "../protocol.js";

/** 三处字号的键（顺序固定：读 / 报都用这个顺序，别让模型每次输出顺序都不一样） */
export const APPEARANCE_LAYERS = ["chatPx", "projectPx", "sessionPx"] as const;
export type AppearanceLayer = (typeof APPEARANCE_LAYERS)[number];

export const APPEARANCE_LABEL: Record<AppearanceLayer, string> = {
	chatPx: "聊天正文",
	projectPx: "侧栏项目名",
	sessionPx: "侧栏会话名",
};

export const APPEARANCE_MIN_PX = 2;
export const APPEARANCE_MAX_PX = 30;

/** 宿主端口：读当前值 / 写一次（写的人负责落盘 + 推快照，浏览器据此自动应用） */
export type AppearancePort = {
	read(): AppearanceView;
	set(patch: Partial<AppearanceView>): Promise<AppearanceView>;
};

/** `target` 的三种写法都收：英文键、简写、中文（用户/模型都可能这么叫） */
const TARGET_ALIASES: Record<string, AppearanceLayer | "all"> = {
	all: "all",
	全部: "all",
	所有: "all",
	chat: "chatPx",
	chatpx: "chatPx",
	对话: "chatPx",
	正文: "chatPx",
	聊天: "chatPx",
	project: "projectPx",
	projectpx: "projectPx",
	项目: "projectPx",
	项目名: "projectPx",
	session: "sessionPx",
	sessionpx: "sessionPx",
	会话: "sessionPx",
	会话名: "sessionPx",
};

function numberOf(value: unknown): number | null {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim() !== "") {
		const parsed = Number(value.trim());
		if (Number.isFinite(parsed)) return parsed;
	}
	return null;
}

/**
 * 工具参数 → 要写的那几处。
 *
 * - `px` 是**绝对目标值**（"设成 18"）；
 * - `delta` 是**相对调整**（"大一点" → +2，"小一点" → -2）；
 * - 两个都给时以 `px` 为准；一个都没给就是错，别让模型"猜一个值"。
 */
export function appearancePatchFromArgs(
	args: { target?: unknown; px?: unknown; delta?: unknown },
	current: AppearanceView,
): { patch: Partial<AppearanceView> } | { error: string } {
	const rawTarget = typeof args.target === "string" ? args.target.trim().toLowerCase() : "all";
	const target = TARGET_ALIASES[rawTarget] ?? TARGET_ALIASES[rawTarget.replace(/\s+/g, "")] ?? null;
	if (target === null) {
		return { error: `未知的 target：${String(args.target)}（可用：chat / project / session / all）` };
	}
	const px = numberOf(args.px);
	const delta = numberOf(args.delta);
	if (px === null && delta === null) return { error: "要么给 px（目标字号，例如 18），要么给 delta（例如 2 / -2）" };
	const layers: AppearanceLayer[] = target === "all" ? [...APPEARANCE_LAYERS] : [target];
	const patch: Partial<AppearanceView> = {};
	for (const layer of layers) {
		patch[layer] = px ?? current[layer] + (delta as number);
	}
	return { patch };
}

/** 当前值（读接口的正文） */
export function describeAppearance(view: AppearanceView): string {
	const lines = APPEARANCE_LAYERS.map((layer) => `- ${APPEARANCE_LABEL[layer]}：${view[layer]}px`);
	return [
		`当前外观字号（范围 ${APPEARANCE_MIN_PX}–${APPEARANCE_MAX_PX}px，只能是双数）：`,
		...lines,
		"侧栏项目名 / 会话名是左边列表里那两行；聊天正文是对话里的字。",
	].join("\n");
}

/** 改前 → 改后（用户要的就是这个：能核对改了哪一处、从多少到多少） */
export function describeAppearanceChange(before: AppearanceView, after: AppearanceView): string {
	const changed = APPEARANCE_LAYERS.filter((layer) => before[layer] !== after[layer]);
	if (changed.length === 0) return "没有任何改动（给的值和当前一致）。";
	const lines = changed.map((layer) => `- ${APPEARANCE_LABEL[layer]}：${before[layer]}px → ${after[layer]}px`);
	return lines.join("\n");
}
