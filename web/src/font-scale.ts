/**
 * 字号：**一个连续区间 + 每处一套四档预设**。
 *
 * 三处 = 聊天正文（`chat-display.ts`）、侧栏项目名 / 侧栏会话名（`sidebar-font.ts`）。
 * 它们并排在「设置 → 外观」里：滑杆负责"我就要 11.5px 这种"，四个预设只是**快捷档**
 * （点一下就到位，省得拖着找）。
 *
 * 「标准」那一档同时是**默认值**（没存过字号的机器用它）。
 *
 * 2026-10-29 按用户要求统一：**三处的「标准」都是 14px**，而且**所有字号都是双数**——
 * 档位 12 / 14 / 16 / 18，滑杆步长也从 0.5 改成 2，拖出来的永远只有偶数。
 * 起因是「侧栏项目名和会话标题看着像被压扁了」：当时两处是 12 / 13px + 项目名半粗体，
 * 中文在半粗体小字号下笔画会糊在一起；14px 起步就恢复正常的字面比了。
 */
export type FontScaleId = "s" | "m" | "l" | "xl";

/** 三处字号：聊天正文 / 侧栏项目名 / 侧栏会话名 */
export type FontLayer = "chat" | "project" | "session";

type FontScaleDef = {
	id: FontScaleId;
	/** 卡片上的名字（中文，`t()` 的第一参） */
	label: string;
	labelEn: string;
	px: number;
};

/** 以「标准」为基准生成四档：-2 / 标准 / +2 / +4（等距 2px；标准是双数时四档都是双数） */
function ladder(standard: number): readonly FontScaleDef[] {
	return [
		{ id: "s", label: "特小", labelEn: "Extra small", px: standard - 2 },
		{ id: "m", label: "标准", labelEn: "Default", px: standard },
		{ id: "l", label: "大", labelEn: "Large", px: standard + 2 },
		{ id: "xl", label: "特大", labelEn: "Extra large", px: standard + 4 },
	];
}

/**
 * 三处各自的四档：**都是 12 / 14 / 16 / 18**（双数，且三处同一套刻度）。
 *
 * 以前项目名那套的「标准」是 13（想让它比会话名醒目一档），但 13 是单数、和用户
 * 「都改成双数」的要求冲突；而且项目名本来就靠 `font-weight: 600` 区分层级，
 * 不靠大 1px —— 现在三处同刻度，看着更像同一套系统。
 */
export const FONT_LADDERS: Record<FontLayer, readonly FontScaleDef[]> = {
	chat: ladder(14),
	project: ladder(14),
	session: ladder(14),
};

/** 各处的默认字号（像素）= 那一处的「标准」档 = 14 */
export const DEFAULT_FONT_PX: Record<FontLayer, number> = {
	chat: 14,
	project: 14,
	session: 14,
};

/**
 * 滑杆区间：**2–30px**（两端都是双数；下限 2 是用户要的「能拖到很低」，
 * 上限 30 = 用户 2026-10-29 要的「最大号能拖到 30px」，三处（聊天正文 / 侧栏项目名 /
 * 侧栏会话名）共用同一个区间）。两端刻度就画在滑杆下面。
 * 默认值是「标准」那一档（现在是 14px）—— 区间宽，不代表默认跟着变。
 */
export const FONT_MIN_PX = 2;
export const FONT_MAX_PX = 30;
/** 步长 2px：**只要双数**（用户 2026-10-29：「字体大小都改成双数」）——
 * 以前是 0.5px，能拖出 13.5 这种奇数值。 */
export const FONT_STEP_PX = 2;

/** 某一层的档位表里按 id 找（老存储值 `s/m/l/xl` 靠它映射到该层对应的像素） */
function findFontScale(id: string | null | undefined, layer: FontLayer = "chat"): FontScaleDef | null {
	return FONT_LADDERS[layer].find((item) => item.id === id) ?? null;
}

/**
 * 夹到滑杆区间内，并对齐到 `FONT_STEP_PX`（现在的步长 2 → **结果一定是双数**）。
 *
 * 为什么在这里就规整：滑杆会给 12.000000001 这种浮点尾巴，直接写进 CSS 变量再读回来
 * 会变成 "12.0000000001px"；而且老存储里可能有 13 / 12.5 这种不在新刻度上的值，
 * 读取时对齐一下，老用户的字号会自动挪到最近的偶数（13 → 14、12.5 → 12）。
 */
export function clampFontPx(px: number, layer: FontLayer = "chat"): number {
	if (!Number.isFinite(px)) return DEFAULT_FONT_PX[layer];
	const clamped = Math.min(Math.max(px, FONT_MIN_PX), FONT_MAX_PX);
	// 先对步长取整，再夹一次：取整有可能把下限 2 抬上去，也可能把上限 30 顶出去
	const snapped = Math.round(clamped / FONT_STEP_PX) * FONT_STEP_PX;
	return Math.min(Math.max(snapped, FONT_MIN_PX), FONT_MAX_PX);
}

/**
 * 读本机存的字号（像素）。
 * 兼容三种值：新版存的像素（"16"）、老版存的档位（"m"）、以及坏值 —— 像素值会被
 * `clampFontPx` 对到偶数，档位 / 坏值回落到对应的像素，绝不抛错
 * （隐私模式下 localStorage 禁用时调用方会先兜住）。
 */
export function readStoredFontPx(raw: string | null | undefined, layer: FontLayer = "chat"): number {
	if (raw === null || raw === undefined || raw === "") return DEFAULT_FONT_PX[layer];
	const asNumber = Number(raw);
	if (Number.isFinite(asNumber)) return clampFontPx(asNumber, layer);
	// 老值：档位 id（按**这一层**新刻度换算；三处现在同一套，"m" 都是 14）
	const preset = findFontScale(raw, layer);
	return preset ? preset.px : DEFAULT_FONT_PX[layer];
}

/** 纯函数：像素 → CSS 变量取值（不碰 DOM） */
export function fontPxCss(px: number): string {
	return `${clampFontPx(px)}px`;
}

/** 这个像素值正好等于某一档吗（是 → 那张快捷卡片高亮；档位之间返回 null） */
export function presetOfPx(px: number, layer: FontLayer = "chat"): FontScaleId | null {
	const value = clampFontPx(px, layer);
	return FONT_LADDERS[layer].find((item) => item.px === value)?.id ?? null;
}

/**
 * 老刻度 → 新刻度的**一次性**迁移。
 *
 * 2026-10-29 把「标准」从 12 / 13px 抬到 14px。滑杆存的是**绝对像素**，
 * 所以老用户存着的 12px 不会自己变成 14px（那就继续看着发扁）。
 *
 * 迁移不能一律 +2：项目名那套的老「标准」是 13px，+2 会落到 15 → 偶数对齐后变 16，
 * 而它应该跟新标准 14 对齐。所以：
 *   ① 老值正好在老档位上（10/12/14/16 或 11/13/15/17）→ **按档位序号映射**，
 *     老「标准」→ 新「标准」（14），老「大」→ 新「大」（16），相对选择一字不差；
 *   ② 老值是滑杆拖出来的奇数值（13.5、20 这种）→ 按两层标准的差**等量平移**
 *     （聊天 / 会话 +2px，项目名 +1px），再对到双数。
 *
 * 无论走哪条，结果都是**双数**且夹在滑杆区间内。
 */
const LEGACY_STANDARD_PX: Record<FontLayer, number> = { chat: 12, project: 13, session: 12 };

/** 老刻度的四档像素（跟现在的 `ladder()` 同形，只是标准不同） */
function legacyLadderPx(layer: FontLayer): readonly number[] {
	const standard = LEGACY_STANDARD_PX[layer];
	return [standard - 2, standard, standard + 2, standard + 4];
}

/** 把老刻度的像素值换算到新刻度（结果仍是双数，且夹在区间内） */
export function upgradeLegacyFontPx(px: number, layer: FontLayer = "chat"): number {
	if (!Number.isFinite(px)) return DEFAULT_FONT_PX[layer];
	const old = Math.min(Math.max(px, FONT_MIN_PX), FONT_MAX_PX);
	// ① 正好在老档位上：按序号搬到新档位
	const index = legacyLadderPx(layer).indexOf(old);
	if (index >= 0) return FONT_LADDERS[layer][index]?.px ?? DEFAULT_FONT_PX[layer];
	// ② 其它值：按「新标准 − 老标准」平移，再夹 / 对偶数
	return clampFontPx(old + (DEFAULT_FONT_PX[layer] - LEGACY_STANDARD_PX[layer]), layer);
}

/**
 * 迁移用：老存储值 → 新刻度的像素。
 *
 * 分两种：存的是像素（"12"）→ 平移 +2；存的是老档位 id（"m"）→ 不平移
 * （`readStoredFontPx` 会按**新**档位表映射，m 本来就是新的「标准」）。
 */
export function upgradeStoredFontPx(raw: string, layer: FontLayer = "chat"): number {
	const asNumber = Number(raw);
	if (Number.isFinite(asNumber)) return upgradeLegacyFontPx(asNumber, layer);
	return readStoredFontPx(raw, layer);
}
