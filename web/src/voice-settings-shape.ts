/**
 * 语音设置的形状 shim（同 `types.ts` 的做法：只重导出，不写逻辑）。
 *
 * 真正的归一化在 `server/session/voice-settings.ts`：服务端写入时用它、前端读回时也用它，
 * 只维护一份口径 —— 否则「前端存的 3000 服务端当 2200」这类偏差迟早出现。
 */
export {
	IDLE_STOP_RANGE_SEC,
	NEAR_TALK_RANGE_DB,
	SILENCE_RANGE_MS,
	VOICE_SETTINGS_DEFAULTS,
	normalizeVoiceSettings,
} from "../../server/session/voice-settings.ts";
export type { VoiceSettingsShape } from "../../server/session/voice-settings.ts";
