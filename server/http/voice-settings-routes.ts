/**
 * 语音设置的宿主侧存取（`<dataDir>/voice-settings.json`）。
 *
 * 为什么需要：这些设置以前只在浏览器 localStorage 里 —— 换设备（手机 ↔ 电脑）、换浏览器、
 * 清缓存就全没了，而且两边要各调一遍（用户 2026-11-21：「手机电脑共用一套」）。
 *
 * 三条约定：
 *   1. **服务端是权威**：GET 返回的就是「这一台机器上大家共享的那套」；
 *   2. 文件坏了不覆盖（`readJsonObject` 会报错），只在 PUT 时整体重写；
 *   3. 写入前一律过 `normalizeVoiceSettings`：手改过的值、老版本缺字段、越界都收敛到合法区间。
 */
import type { Express } from "express";
import { join } from "node:path";
import { readJsonObject, writeJsonObject } from "../util/json-file.js";
import type { Logger } from "../util/log.js";
import { normalizeVoiceSettings } from "../session/voice-settings.js";

export function registerVoiceSettingsRoutes(app: Express, options: { dataDir: string; logger: Logger }): void {
	const file = join(options.dataDir, "voice-settings.json");
	const log = options.logger.child("voice-settings");

	app.get("/api/voice-settings", (_request, response) => {
		const read = readJsonObject(file);
		if ("error" in read) {
			// 坏文件：告诉调用方「还没存过」，同时留一条 warn —— 别静默把用户的设置当不存在
			log.warn(read.error);
			response.json({ settings: normalizeVoiceSettings({}), stored: false });
			return;
		}
		response.json({ settings: normalizeVoiceSettings(read.json), stored: read.exists });
	});

	app.put("/api/voice-settings", (request, response) => {
		const settings = normalizeVoiceSettings(request.body);
		try {
			writeJsonObject(file, settings as unknown as Record<string, unknown>);
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			log.warn(`写入失败：${message}`);
			response.status(500).json({ error: "语音设置保存失败" });
			return;
		}
		response.json({ settings });
	});
}
