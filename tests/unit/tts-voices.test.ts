import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { DEFAULT_TTS_SETTINGS, resolveVoice, type VoiceOption } from "../../web/src/tts.ts";

const localChinese: VoiceOption = {
	voiceURI: "local-zh",
	name: "本机中文",
	lang: "zh-CN",
	localService: true,
};
const localEnglish: VoiceOption = {
	voiceURI: "local-en",
	name: "Local English",
	lang: "en-US",
	localService: true,
};
const remoteGoogle: VoiceOption = {
	voiceURI: "google-zh",
	name: "Google 普通话（中国大陆）",
	lang: "zh-CN",
	localService: false,
};

describe("TTS voice selection", () => {
	it("旧设置存了 Google 在线音色时，回退到同语言的本机音色", () => {
		assert.equal(resolveVoice(remoteGoogle.voiceURI, [remoteGoogle, localChinese], "zh-CN"), localChinese);
	});

	it("明确选择本机音色时仍然精确使用它", () => {
		assert.equal(
			resolveVoice(localEnglish.voiceURI, [remoteGoogle, localChinese, localEnglish], "zh-CN"),
			localEnglish,
		);
	});

	it("自动选择也跳过在线音色；没有本机音色时才交给浏览器默认", () => {
		assert.equal(resolveVoice("", [remoteGoogle, localEnglish], "en-US"), localEnglish);
		assert.equal(resolveVoice(remoteGoogle.voiceURI, [remoteGoogle], "zh-CN"), null);
	});
});

describe("TTS 在线音色：勾选后可用", () => {
	it("勾选后可以真的选中 Google 在线音色", () => {
		assert.equal(
			resolveVoice(remoteGoogle.voiceURI, [remoteGoogle, localChinese], "zh-CN", { allowOnline: true }),
			remoteGoogle,
		);
	});

	it("勾选「只列在线音色」后，「自动」也优先挑在线的（本机音色在这台机器上念不出来）", () => {
		assert.equal(resolveVoice("", [remoteGoogle, localChinese], "zh-CN", { allowOnline: true }), remoteGoogle);
	});

	it("只有在线音色时也能挑到（以前只能回落到浏览器默认）", () => {
		assert.equal(resolveVoice("", [remoteGoogle], "zh-CN", { allowOnline: true }), remoteGoogle);
	});

	it("没有本机音色可挑时，允许落到在线音色（不返回 null）", () => {
		assert.equal(resolveVoice("", [remoteGoogle, localEnglish], "zh-CN", { allowOnline: true }), remoteGoogle);
	});
});

describe("在线音色默认保留", () => {
	it("默认设置就列出在线音色（不再需要先去勾选）", () => {
		assert.equal(DEFAULT_TTS_SETTINGS.allowOnline, true);
	});

	it("取消勾选只是不列出；已选的音色仍然保留在设置里，重新勾上立刻生效", () => {
		assert.equal(
			resolveVoice(remoteGoogle.voiceURI, [remoteGoogle, localChinese], "zh-CN", { allowOnline: false }),
			localChinese,
		);
		assert.equal(
			resolveVoice(remoteGoogle.voiceURI, [remoteGoogle, localChinese], "zh-CN", { allowOnline: true }),
			remoteGoogle,
		);
	});
});
