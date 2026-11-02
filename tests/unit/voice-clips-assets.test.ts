/**
 * 状态语音 = **预生成的本地音频片段**（不是浏览器语音合成）。
 *
 * 为什么改成音频文件（用户 2026-11-02：「这种语音播放老有问题，直接播放本地放好的声音」）：
 * 合成那条路在真机上不可控 —— 网络音色冷启动慢会被看门狗判死、`cancel()` 掐不断已经出声的句子、
 * `onstart` 还可能不回调，于是同一句「任务已完成」被反复重排、听起来就是播了两遍。
 *
 * 这里钉住三件事：
 *   ① 六个片段（完成 / 出错 / 审批 × 中文 / 英文）真的在仓库里，且是能播的 mp3；
 *   ② 组件真的引用了这六个文件（少引一个 → 那个语言/事件会静默没声）；
 *   ③ 通道判定：开了语音走片段、开了朗读回复且真有正文才走合成、其余退回提示音。
 */
import assert from "node:assert/strict";
import { readFileSync, statSync } from "node:fs";
import { describe, it } from "node:test";
import { voiceChannelOf } from "../../web/src/voice-cue-logic.ts";

const KINDS = ["done", "error", "approval"] as const;
const LANGS = ["zh", "en"] as const;
const cueFile = (kind: string, lang: string) =>
	new URL(`../../web/src/assets/cues/${kind}.${lang}.mp3`, import.meta.url);

const clipsSource = readFileSync(new URL("../../web/src/voice-clips.ts", import.meta.url), "utf8");

describe("语音片段资源", () => {
	it("六个片段都在（缺一个 → 那个事件在那种语言下会没声）", () => {
		for (const kind of KINDS) {
			for (const lang of LANGS) {
				const file = cueFile(kind, lang);
				const size = statSync(file).size;
				assert.ok(size > 2000, `${kind}.${lang}.mp3 只有 ${size}B，像是没生成成功`);
			}
		}
	});

	it("都是能播的 mp3（ID3 头或 MPEG 帧同步）", () => {
		for (const kind of KINDS) {
			for (const lang of LANGS) {
				const head = readFileSync(cueFile(kind, lang)).subarray(0, 3);
				const id3 = head[0] === 0x49 && head[1] === 0x44 && head[2] === 0x33;
				const frame = head[0] === 0xff && (head[1]! & 0xe0) === 0xe0;
				assert.ok(id3 || frame, `${kind}.${lang}.mp3 的头不是 mp3：${[...head].map((b) => b.toString(16)).join(" ")}`);
			}
		}
	});

	it("组件引用的是这六个文件（改文件名忘了同步会被抓到）", () => {
		for (const kind of KINDS) {
			for (const lang of LANGS) {
				assert.match(
					clipsSource,
					new RegExp(`from "\\./assets/cues/${kind}\\.${lang}\\.mp3\\?url"`),
					`voice-clips.ts 没引用 ${kind}.${lang}.mp3`,
				);
			}
		}
	});
});

describe("该走哪个声音通道", () => {
	const base = { voiceEnabled: true, readReplies: false, hasReply: false };

	it("语音开着：完成 / 出错 / 审批都播本地片段", () => {
		for (const kind of KINDS) {
			assert.equal(voiceChannelOf({ ...base, kind }), "clip", kind);
		}
	});

	it("语音关着：一律退回提示音", () => {
		for (const kind of KINDS) {
			assert.equal(voiceChannelOf({ ...base, kind, voiceEnabled: false }), "beep", kind);
		}
	});

	it("只有「完成 + 朗读回复 + 真有正文」才走语音合成", () => {
		assert.equal(voiceChannelOf({ ...base, kind: "done", readReplies: true, hasReply: true }), "reply");
		// 开了朗读但这一轮没有正文 → 仍然播片段，别把空字符串塞给合成
		assert.equal(voiceChannelOf({ ...base, kind: "done", readReplies: true, hasReply: false }), "clip");
		// 出错 / 审批没有「回复」可念，永远不走去合成
		assert.equal(voiceChannelOf({ ...base, kind: "error", readReplies: true, hasReply: true }), "clip");
		assert.equal(voiceChannelOf({ ...base, kind: "approval", readReplies: true, hasReply: true }), "clip");
	});

	it("「开始」只是轻响一声，从来不用语音", () => {
		assert.equal(voiceChannelOf({ ...base, kind: "start", readReplies: true, hasReply: true }), "beep");
	});
});
