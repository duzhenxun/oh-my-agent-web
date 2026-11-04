#!/usr/bin/env node
/**
 * 生成「状态语音」片段（本地音频，随源码一起发布）。
 *
 * 为什么要预生成、而不是用浏览器的 SpeechSynthesis：合成在真机上太不可控 —— 网络音色冷启动
 * 慢、`cancel()` 掐不断已经出声的句子、`onstart` 不一定回调，于是同一句「任务已完成」会被
 * 反复重排、听起来像播了两遍（2026-11-02 的现场）。换成**固定的本地音频**之后，播放就是一次
 * `AudioBufferSource.start()`：没有重试、没有取消、没有网络、也没有音色差异。
 *
 * 输出：`web/src/assets/cues/<kind>.<lang>.mp3`（10 个文件，合计 ≈70KB）
 *   kind: done / stopped / steer / error / approval
 *   lang: zh / en
 *
 * 用法：`npm run cues`（需要 macOS 的 `say` + `ffmpeg`；没有 `say` 就跳过，已生成的文件保持不动）
 * 只重生成某几条：`npm run cues -- stopped steer`（其余文件不动）
 *
 * 换成别的声音：改 VOICES（按优先级找第一个装了的）。中文默认用婷婷，英文用 Samantha。
 * 注意体积：48kbps 单声道 24kHz 足够清楚，一条 1 秒 ≈ 7KB，再高只是白占体积（手机上听不出差别）。
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, existsSync, statSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const outDir = join(root, "web/src/assets/cues");

/** 每条语音的文案（跟着 TTS_LINE 以前那三句走，改了这里要重新生成） */
const LINES = {
	done: { zh: "任务已完成", en: "Task complete." },
	// 用户点「停止」/ 看门狗中断：这一轮没跑完，不能说「已完成」（2026-11-03）
	stopped: { zh: "任务已停止", en: "Task stopped." },
	// 用户把新消息「插队」进正在跑的回合（ADR-0043），模型已经收到了
	steer: { zh: "有新任务插队", en: "A new task cut in." },
	error: { zh: "出错了，请查看对话", en: "Something went wrong. Check the chat." },
	approval: { zh: "有一条工具调用等待你的批准", en: "A tool call is waiting for your approval." },
};

/** 音色优先级：找一个装了的（别人机器上可能没有 Tingting） */
const VOICES = {
	zh: ["Tingting", "Meijia", "Sinji"],
	en: ["Samantha", "Ava", "Alex", "Daniel"],
};

/** 语速：系统默认 175 偏快，中文长句（等待审批那句）稍慢一点更清楚 */
const RATE = { zh: 170, en: 175 };

function hasCommand(name) {
	try {
		execFileSync("which", [name], { stdio: "pipe" });
		return true;
	} catch {
		return false;
	}
}

function installedVoices() {
	try {
		return execFileSync("say", ["-v", "?"], { encoding: "utf8" })
			.split("\n")
			.map((line) => line.trim().split(/\s{2,}/)[0])
			.filter(Boolean);
	} catch {
		return [];
	}
}

function pickVoice(lang, available) {
	const wanted = VOICES[lang];
	return wanted.find((name) => available.includes(name)) ?? null;
}

if (!hasCommand("say")) {
	console.error("[cues] 这台机器没有 `say`（只有 macOS 有）：保持现有音频文件不动。");
	process.exit(0);
}
if (!hasCommand("ffmpeg")) {
	console.error("[cues] 缺少 ffmpeg（brew install ffmpeg）才能压成 mp3。");
	process.exit(1);
}

const available = installedVoices();
mkdirSync(outDir, { recursive: true });

/** 只重生成点名的几条（`npm run cues -- stopped steer`）：没点名就全量 */
const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const wanted = Object.entries(LINES).filter(([kind]) => only.length === 0 || only.includes(kind));
if (wanted.length === 0) {
	console.error(`[cues] 不认识的 kind：${only.join(", ")}（可选：${Object.keys(LINES).join(" / ")}）`);
	process.exit(1);
}

let made = 0;
for (const [kind, texts] of wanted) {
	for (const [lang, text] of Object.entries(texts)) {
		const voice = pickVoice(lang, available);
		const target = join(outDir, `${kind}.${lang}.mp3`);
		if (!voice) {
			console.warn(`[cues] 没有可用的 ${lang} 音色，跳过 ${kind}.${lang}${existsSync(target) ? "（保留旧文件）" : ""}`);
			continue;
		}
		const aiff = join(outDir, `.${kind}.${lang}.aiff`);
		execFileSync("say", ["-v", voice, "-r", String(RATE[lang]), "-o", aiff, text]);
		execFileSync("ffmpeg", [
			"-y",
			"-loglevel",
			"error",
			"-i",
			aiff,
			"-ac",
			"1",
			"-ar",
			"24000",
			"-b:a",
			"48k",
			// 六条都走同一套响度归一：不然「出错了」比「任务已完成」响一截，听着像两套东西
			"-af",
			"loudnorm=I=-16:TP=-1.5:LRA=11",
			target,
		]);
		execFileSync("rm", ["-f", aiff]);
		const size = statSync(target).size;
		made += 1;
		console.log(`[cues] ${kind}.${lang}.mp3  ${voice}  ${size}B  「${text}」`);
	}
}
console.log(`[cues] 完成：${made} 个文件 → ${outDir.replace(root + "/", "")}`);
