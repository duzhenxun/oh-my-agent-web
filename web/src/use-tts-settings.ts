import { useEffect, useState } from "react";
import { loadTtsSettings, onTtsSettingsChange, type TtsSettings } from "./tts.ts";

/**
 * 当前语音设置（`localStorage` 里那份）+ 跟着「设置 → 语音播报」的改动实时更新。
 *
 * 存在的理由只有一个：**消息尾注要按「启用语音播报」显隐朗读控件**
 * （用户 2026-11-24：「语音设置中没有启动的话，就默认不需要显示这个」）。
 * 语音设置不走服务端快照，所以订阅的是 `tts.ts` 那个自定义事件（跨标签页另有 `storage`）。
 */
export function useTtsSettings(): TtsSettings {
	const [settings, setSettings] = useState<TtsSettings>(() => loadTtsSettings());
	useEffect(() => onTtsSettingsChange(setSettings), []);
	return settings;
}
