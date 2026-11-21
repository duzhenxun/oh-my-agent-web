import type { TtsVoiceList } from "./types.js";

export const DEFAULT_EDGE_VOICE = "zh-CN-XiaoxiaoNeural";

/** Deliberately bounded, offline catalogue; IDs are also the synthesis allowlist. */
export function edgeVoices(): TtsVoiceList {
	return {
		voices: [
			{ id: DEFAULT_EDGE_VOICE, name: "晓晓", lang: "zh-CN", gender: "Female" },
			{ id: "zh-CN-XiaoyiNeural", name: "晓伊", lang: "zh-CN", gender: "Female" },
			{ id: "zh-CN-YunxiNeural", name: "云希", lang: "zh-CN", gender: "Male" },
			{ id: "zh-CN-YunjianNeural", name: "云健", lang: "zh-CN", gender: "Male" },
			{ id: "zh-CN-YunyangNeural", name: "云扬", lang: "zh-CN", gender: "Male" },
			{ id: "zh-HK-HiuMaanNeural", name: "曉曼（粤语）", lang: "zh-HK", gender: "Female" },
			{ id: "zh-TW-HsiaoChenNeural", name: "曉臻", lang: "zh-TW", gender: "Female" },
			{ id: "en-US-AriaNeural", name: "Aria", lang: "en-US", gender: "Female" },
			{ id: "en-US-JennyNeural", name: "Jenny", lang: "en-US", gender: "Female" },
			{ id: "en-US-GuyNeural", name: "Guy", lang: "en-US", gender: "Male" },
			{ id: "en-GB-SoniaNeural", name: "Sonia", lang: "en-GB", gender: "Female" },
			{ id: "en-GB-RyanNeural", name: "Ryan", lang: "en-GB", gender: "Male" },
		],
		note: "静态常用音色列表，未请求动态目录；实际可用性以 Microsoft Edge 在线服务为准。",
	};
}
