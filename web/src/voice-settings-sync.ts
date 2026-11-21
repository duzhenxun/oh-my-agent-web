/**
 * 语音设置的跨设备同步（浏览器 ↔ 宿主）。
 *
 * 分工：
 *   - **localStorage 仍是第一来源**（同步读、离线可用、页面一打开就能用对值）；
 *   - 宿主那份（`/api/voice-settings`）是**共享的权威副本**：手机上改了，电脑下次打开就是手机那套。
 *
 * 两条时序：
 *   1. 启动：先用本地值把界面撑起来 → 异步拉宿主那份 → 宿主有记录就以它为准（写回本地并通知界面）；
 *      宿主**没有**记录时（首次升级），把本地值推上去当基线，别让旧用户丢设置。
 *   2. 保存：立刻写本地 + 通知界面（不等网络），同时 fire-and-forget 推给宿主。
 *
 * 失败一律静默：同步不上就继续用本地的，绝不能因为网络问题让麦克风用不了。
 */
import { normalizeVoiceSettings, type VoiceSettingsShape } from "./voice-settings-shape.ts";

const ENDPOINT = "/api/voice-settings";

type ServerPayload = { settings?: unknown; stored?: boolean };

/** 拉宿主那份；拿不到就返回 null（调用方继续用本地值） */
export async function fetchVoiceSettings(): Promise<{ settings: VoiceSettingsShape; stored: boolean } | null> {
	try {
		const response = await fetch(ENDPOINT, { headers: { Accept: "application/json" } });
		if (!response.ok) return null;
		const payload = (await response.json()) as ServerPayload;
		return { settings: normalizeVoiceSettings(payload.settings), stored: payload.stored === true };
	} catch {
		return null;
	}
}

/** 把当前设置推给宿主（失败静默） */
export function pushVoiceSettings(settings: VoiceSettingsShape): void {
	try {
		void fetch(ENDPOINT, {
			method: "PUT",
			headers: { "Content-Type": "application/json" },
			body: JSON.stringify(settings),
			keepalive: true,
		}).catch(() => undefined);
	} catch {
		// fetch 不可用（极老浏览器）：同步功能降级，本地照常保存
	}
}

/** 两份设置是否等价（避免「宿主值没变」也去重写 localStorage / 触发重渲染） */
export function sameSettings(a: VoiceSettingsShape, b: VoiceSettingsShape): boolean {
	return (
		a.autoSend === b.autoSend &&
		a.continuous === b.continuous &&
		a.submitMode === b.submitMode &&
		a.engine === b.engine &&
		a.nearTalkDb === b.nearTalkDb &&
		a.silenceMs === b.silenceMs &&
		a.readingResumeMs === b.readingResumeMs &&
		a.idleStopSec === b.idleStopSec &&
		a.showReadingDock === b.showReadingDock
	);
}
