/**
 * 语音设置的「归一化」（纯函数，前后端共用口径）。
 *
 * 为什么会有一份服务端版本：设置以前只存在浏览器 localStorage 里 —— 换设备（手机 ↔ 电脑）、
 * 换浏览器、清一次缓存就全没了，而且两边各调一遍很烦（用户 2026-11-21 要「手机电脑共用一套」）。
 * 现在落一份在数据目录，谁读到都以它为准。
 *
 * 归一化放在这里、只写一遍的好处：服务端写入前用一次、前端读到之后再用一次，
 * 手改过的文件 / 老版本缺字段 / 越界值都不会把状态机喂成奇怪的状态。
 */
export type VoiceSettingsShape = {
	autoSend: boolean;
	continuous: boolean;
	submitMode: "queue" | "steer";
	engine: "auto" | "browser" | "local" | "cloud";
	/** 近讲灵敏度（dB）：0 = 关闭（同时打开自动增益） */
	nearTalkDb: number;
	/** 说完多久算说完（毫秒）—— 决定「自动发送」 */
	silenceMs: number;
	/** 用户安静多久之后朗读继续（毫秒）—— 和发送阈值拆开，互不影响 */
	readingResumeMs: number;
	/** 空闲多久自动关麦（秒）：0 = 不关 */
	idleStopSec: number;
	/** 是否在界面上显示「朗读控制条」（暂停 / 停止） */
	showReadingDock: boolean;
};

/** 静音阈值范围（与服务端 speech-input-local / silence-ring 的口径一致） */
export const SILENCE_RANGE_MS = { min: 600, max: 10_000 } as const;
export const NEAR_TALK_RANGE_DB = { min: 0, max: 30 } as const;
export const IDLE_STOP_RANGE_SEC = { min: 0, max: 120 } as const;

export const VOICE_SETTINGS_DEFAULTS: VoiceSettingsShape = {
	autoSend: true,
	continuous: false,
	submitMode: "queue",
	engine: "auto",
	nearTalkDb: 12,
	silenceMs: 2000,
	readingResumeMs: 4000,
	idleStopSec: 0,
	showReadingDock: true,
};

function num(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

function clamp(value: number, min: number, max: number): number {
	return Math.min(max, Math.max(min, value));
}

/**
 * 把任意来源（localStorage / 服务端文件 / 请求体）的一段数据收敛成合法设置。
 * 只认白名单字段，其它一律丢弃 —— 设置里塞别的东西没有意义，也免得越权写入。
 */
export function normalizeVoiceSettings(input: unknown, fallback = VOICE_SETTINGS_DEFAULTS): VoiceSettingsShape {
	const raw = input && typeof input === "object" && !Array.isArray(input) ? (input as Record<string, unknown>) : {};
	return {
		autoSend: typeof raw.autoSend === "boolean" ? raw.autoSend : fallback.autoSend,
		continuous: typeof raw.continuous === "boolean" ? raw.continuous : fallback.continuous,
		submitMode: raw.submitMode === "steer" ? "steer" : raw.submitMode === "queue" ? "queue" : fallback.submitMode,
		engine:
			raw.engine === "local" || raw.engine === "browser" || raw.engine === "auto" || raw.engine === "cloud"
				? raw.engine
				: fallback.engine,
		nearTalkDb: Math.round(clamp(num(raw.nearTalkDb, fallback.nearTalkDb), NEAR_TALK_RANGE_DB.min, NEAR_TALK_RANGE_DB.max)),
		silenceMs: Math.round(
			clamp(num(raw.silenceMs, fallback.silenceMs), SILENCE_RANGE_MS.min, SILENCE_RANGE_MS.max),
		),
		readingResumeMs: Math.round(
			clamp(num(raw.readingResumeMs, fallback.readingResumeMs), SILENCE_RANGE_MS.min, SILENCE_RANGE_MS.max),
		),
		showReadingDock: typeof raw.showReadingDock === "boolean" ? raw.showReadingDock : fallback.showReadingDock,
		idleStopSec: Math.round(
			clamp(num(raw.idleStopSec, fallback.idleStopSec), IDLE_STOP_RANGE_SEC.min, IDLE_STOP_RANGE_SEC.max),
		),
	};
}
