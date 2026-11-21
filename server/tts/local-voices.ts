import type { TtsVoiceList } from "./types.js";

// Mirrors ~/tts/tts.py so discovery and request validation never start Python.
export const LOCAL_VOICES = {
	kokoro: {
		defaultVoice: "zf_xiaoxiao",
		voices: [
			["zf_xiaobei", "女·小北", "Female"],
			["zf_xiaoni", "女·小妮", "Female"],
			["zf_xiaoxiao", "女·晓晓", "Female"],
			["zf_xiaoyi", "女·小艺", "Female"],
			["zm_yunjian", "男·云健", "Male"],
			["zm_yunxi", "男·云希", "Male"],
			["zm_yunxia", "男·云夏", "Male"],
			["zm_yunyang", "男·云扬", "Male"],
		],
	},
	qwen3: {
		defaultVoice: "serena",
		voices: [
			["serena", "Serena", "Female"],
			["vivian", "Vivian", "Female"],
			["sohee", "Sohee", "Female"],
			["ono_anna", "Ono Anna", "Female"],
			["aiden", "Aiden", "Male"],
			["eric", "Eric", "Male"],
			["ryan", "Ryan", "Male"],
			["dylan", "Dylan", "Male"],
			["uncle_fu", "Uncle Fu", "Male"],
		],
	},
} as const;

export type LocalEngineId = keyof typeof LOCAL_VOICES;

export function localVoices(engine: LocalEngineId): TtsVoiceList {
	return {
		voices: LOCAL_VOICES[engine].voices.map(([id, name, gender]) => ({ id, name, lang: "zh-CN", gender })),
	};
}
