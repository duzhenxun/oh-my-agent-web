/**
 * 把「回合状态变化」翻译成提示音 + 语音播报。
 *
 * 为什么集中在 hook 里而不是散在组件里：提示音只关心**状态跳变**（开始 / 结束 /
 * 出错 / 等审批），跟谁渲染那一块界面无关；放一处才能保证「一轮只响一次」。
 *
 * 判定逻辑全部在 `voice-cue-logic.ts`（纯函数、可回归）；这里只负责：
 *   1. 把 snapshots 喂给判定器；
 *   2. 按判定结果放声音、念句子。
 */
import { useEffect, useRef } from "react";
import { loadSoundSettings, playSound } from "./sound.ts";
import type { Snapshot } from "./types.ts";
import { loadTtsSettings, speak, stopSpeaking, stripMarkdownForSpeech } from "./tts.ts";
import type { TtsSettings } from "./tts.ts";
import type { UiMessage } from "./types.ts";
import { createStreamReader } from "./stream-speech.ts";
import { voiceLog } from "./voice-log.ts";
import { isVoiceListening } from "./voice-input.ts";
import { isSpeechPausedNow, onSpeechPauseChange, onStopSpeechRequest, setReading } from "./speech-control.ts";
import { playVoiceClip, preloadVoiceClips } from "./voice-clips.ts";
import {
	createAnnounceMemory,
	createCueMemory,
	planCues,
	shouldAnnounceDone,
	voiceChannelOf,
} from "./voice-cue-logic.ts";
import type { Cue } from "./voice-cue-logic.ts";

/**
 * 自动播报：**失败不弹提示**（以前是「每次打开页面最多一条」的长红字 toast，用户要求去掉）。
 *
 * 为什么现在敢静默：那条 toast 出现得最频繁的场景，恰恰是「这台机器的语音服务本来就念不出来」——
 * 于是它变成了每次开场必弹的一条噪声，而且信息量跟用户的动作无关（他没点任何东西）。
 * 现在失败仍然**不丢**，只是换了出口：
 *   - `tts.ts` 的 `speak()` 在 console 里留 `[tts] …` 现场（错误码 / 挑到的音色 / 可用音色数）；
 *   - 用户主动去 设置 → 声音与语音 点「试听 / 诊断」时，面板照样给一行能照做的红字和「唤醒并重试」。
 * 换句话说：**不主动打扰，但一查就有**。
 *
 * 另外自动播报**自己会多试一次**（见 `speakAuto`）：用户报的现象是「任务已完成」经常没声，
 * 而系统语音服务被唤醒之后，往往要隔一拍再重新排一句才真的出声（那时候队列也干净）。
 */
function speakAuto(text: string, tts: TtsSettings, attempt = 0): void {
	// 自愈失败（服务真的卡了一下）时再给一次机会：`speak()` 里那两轮唤醒已经把系统语音服务
	// 踢过了，隔一拍重新排一句往往就出声了（此时队列也是干净的，不会再被 cancel 连坐）。
	// 只补一次：再往上堆就变成延迟播报，用户已经走神了。
	speak(
		text,
		tts,
		attempt >= 1
			? {}
			: {
					onIssue: (_message, issue) => {
						if (!issue.wakeable) return;
						window.setTimeout(() => speakAuto(text, tts, attempt + 1), AUTO_RETRY_MS);
					},
				},
	);
}

/** 自动播报失败后再试一次的间隔：够唤醒落地，又不至于让人以为「刚才那声是别的」 */
const AUTO_RETRY_MS = 1200;

/** 助手消息里的正文原文（正文块拼起来，还没剥 markdown） */
function assistantText(message: UiMessage): string {
	return message.blocks
		.map((block) => (block.kind === "text" ? block.text : ""))
		.filter((chunk) => chunk.trim() !== "")
		.join("\n");
}

/** 助手消息里能念的纯文本（去掉 markdown，按默认上限截断） */
function assistantSpeech(message: UiMessage): string {
	return stripMarkdownForSpeech(assistantText(message));
}

type DoneCue = Extract<Cue, { kind: "done" }>;
/** 收尾那两类：「跑完了」和「被停掉」—— 都要出声，但说的不是同一句话 */
type EndCue = Extract<Cue, { kind: "done" | "stopped" }>;
const isDoneCue = (cue: EndCue): cue is DoneCue => cue.kind === "done";

/**
 * 一拍里的多条完成只朗读**一条**回复（开了「朗读回复」才会走到这里）。
 *
 * 优先当前会话：并行 / 后台会话一起收尾时，把两条回复串起来念只会糊成一团，
 * 而用户最想听的就是眼前这条。没有可用文本就返回空串（那就只响提示音）。
 */
function replyToRead(cues: DoneCue[], activeId: string | null): string {
	const ordered = activeId === null ? cues : [...cues.filter((cue) => cue.conversationId === activeId), ...cues];
	for (const cue of ordered) {
		if (!cue.message) continue;
		const body = assistantSpeech(cue.message);
		if (body !== "") return body;
	}
	return "";
}

export function useVoiceCues(snapshot: Snapshot | null): void {
	const memory = useRef(createCueMemory());
	// 「完成」声音那一层的去抖记忆（同一拍合并 + 1.5s 内只响一次），见 voice-cue-logic.ts
	const announced = useRef(createAnnounceMemory());
	/** 「朗读开关是关的」这条日志只写一次（每帧都写会把日志刷满） */
	const loggedReadOff = useRef(false);
	/**
	 * 流式朗读：边出字边念。`queue` 里的句子按顺序播，上一句念完才排下一句
	 * （`speak()` 本身是「新的顶掉旧的」，直接连调会让每句刚开口就被掐掉）。
	 */
	const stream = useRef({
		key: "",
		reader: createStreamReader(),
		queue: [] as string[],
		busy: false,
		/** 每次开念自增：上一句收尾时迟到的 onCancel 不该把新排的句子清掉 */
		token: 0,
		/** 这一轮真的通过流式念出过句子（收尾时据此决定要不要整条重念） */
		spoke: false,
		/** 流式念过的是哪条会话（后台会话收尾时不能拿它当依据） */
		spokeConversation: "",
		/** 当前正在念的会话 / 这一轮的开始时间（停止时要知道静音哪一轮） */
		conversationId: "",
		turnStartedAt: 0,
	});
	/**
	 * 用户按了「停止朗读」之后，**这一轮**余下的文字都不再自动念（含收尾那半句）。
	 * 只认会话，不认消息 id：同一个回合里引擎可能分几段吐字，按 id 记会被一次分段就「解禁」。
	 * 下一轮（收尾之后）自然恢复。
	 */
	const muted = useRef({ conversationId: "", turnStartedAt: 0, on: false });
	/** 最近一次 drain 用的朗读设置：暂停后恢复时要用同一套（音色/语速不能突然变） */
	const lastTts = useRef<TtsSettings | null>(null);

	/**
	 * 预取时向队列要下一句：`speakRemote` 会在**当前句还在播**时调它，所以下一句的合成
	 * 和这一句的播放是并行的（以前必须等这句播完才发下一句的请求，句子之间白等一个往返）。
	 * 暂停 / 听写期间一律不给：那会儿既不该出声，也不该继续打上游。
	 */
	const takeNextSpeech = (): string | undefined => {
		if (isSpeechPausedNow() || isVoiceListening()) return undefined;
		return stream.current.queue.shift();
	};

	const drain = (tts: TtsSettings): void => {
		const state = stream.current;
		// 暂停中：队列原地不动。恢复时由下面那个订阅再叫一次 drain ——
		// 否则暂停期间会把剩下的句子一口气全排进合成器，恢复那一刻直接念完。
		if (isSpeechPausedNow()) return;
		// 正在听写：一句都别念（用户 2026-11-21：「我讲话的时候你就别朗读了，要不然乱」）。
		// 麦克风会把朗读声一起录进去，识别结果和用户说的话搅成一团；已经在播的那句由
		// `voice-input.ts` 开始听写时暂停。手动「朗读 / 试听」不走这里，不受影响。
		if (isVoiceListening()) return;
		lastTts.current = tts;
		if (state.busy) return;
		const next = state.queue.shift();
		if (next === undefined) return;
		state.busy = true;
		setReading(true);
		const my = ++state.token;
		const advance = () => {
			if (my !== state.token) return;
			state.busy = false;
			if (state.queue.length === 0) setReading(false);
			drain(tts);
		};
		speak(next, tts, {
			onEnd: advance,
			nextText: takeNextSpeech,
			onIssue: (message) => {
				// 自动朗读被浏览器拦住时没有任何提示，只表现为"没声音" —— 至少留一条可查的日志
				voiceLog("read:issue", { message: message.slice(0, 80) });
				advance();
			},
			onCancel: () => {
				if (my !== state.token) return;
				state.busy = false;
				state.queue.length = 0;
				setReading(false);
			},
		});
	};

	const enqueue = (units: readonly string[], tts: TtsSettings): void => {
		if (units.length === 0) return;
		// 听写期间进来的新句子直接丢掉，不排进队列：等听完再补念一遍反而更乱
		if (isVoiceListening()) return;
		// 诊断：朗读确实排上了（排查「怎么不念了」时，有这行说明卡在合成而不是开关）
		voiceLog("read:enqueue", { units: units.length, provider: tts.provider, firstLen: units[0]?.length ?? 0 });
		stream.current.queue.push(...units);
		drain(tts);
	};

	/** 停掉流式朗读（用户点停止、这一轮被停掉、或换了会话） */
	const stopStream = (): void => {
		const state = stream.current;
		state.token += 1;
		state.busy = false;
		state.queue.length = 0;
		state.spoke = false;
		state.spokeConversation = "";
		state.key = "";
		state.reader.reset();
		setReading(false);
		stopSpeaking();
	};

	/**
	 * 「停止朗读」（悬浮条 / 快捷键 / 面板）：停掉当前这句，并且**这一轮不再自动开口**。
	 * 只 stopSpeaking 是不够的：下一批 delta 一到又会念下一句，听起来就像没停。
	 */
	const stopReading = (): void => {
		muted.current = {
			conversationId: stream.current.conversationId,
			turnStartedAt: stream.current.turnStartedAt,
			on: true,
		};
		stopStream();
	};

	useEffect(() => onStopSpeechRequest(stopReading), []);

	// 暂停 → 继续：把停在队列里的句子接着念（drain 的暂停守卫让它们没被提前取走）
	useEffect(
		() =>
			onSpeechPauseChange(() => {
				if (isSpeechPausedNow()) return;
				const tts = lastTts.current;
				if (tts) drain(tts);
			}),
		[],
	);

	/** 把「到目前为止的正文」喂给切句器，新出来的句子立刻排队念 */
	const readStreaming = (current: Snapshot, tts: TtsSettings): void => {
		const state = stream.current;
		if (!tts.enabled || !tts.readReplies) {
			// 排查「怎么不念了」第一现场：开关到底开没开（每次只记一次，不刷屏）
			if (!loggedReadOff.current) {
				loggedReadOff.current = true;
				voiceLog("read:off", { enabled: tts.enabled, readReplies: tts.readReplies });
			}
			return;
		}
		const conversationId = current.active.conversationId;
		if (conversationId === null) return;
		const messages = current.active.messages;
		let last: UiMessage | null = null;
		for (let index = messages.length - 1; index >= 0; index -= 1) {
			const message = messages[index];
			if (message && message.role === "assistant") {
				last = message;
				break;
			}
		}
		// 只在这条回复**还在跑**的时候增量念；收尾那一拍的补念交给 done 分支（flush）
		if (!last || last.endedAt !== undefined) return;
		const own = current.runningByConversation[conversationId];
		const global = current.running.conversationId === conversationId ? current.running : null;
		const status = own?.status ?? global?.status ?? "idle";
		if (status === "idle") return;
		const body = last.blocks
			.map((block) => (block.kind === "text" ? block.text : ""))
			.filter((chunk) => chunk.trim() !== "")
			.join("\n");
		if (body === "") return;
		const turnStartedAt = own?.turnStartedAt ?? global?.turnStartedAt ?? 0;
		// 用户叫停了这一轮：整轮不再开口。只有**真正的新一轮**（开始时间变了）才解禁 ——
		// 同一轮里引擎可能分几段吐字、中途还有短暂的「完成」跳变，按那些去解禁就等于没停。
		if (muted.current.on && muted.current.conversationId === conversationId) {
			if (muted.current.turnStartedAt === turnStartedAt) return;
			muted.current = { conversationId: "", turnStartedAt: 0, on: false };
		}
		const key = `${conversationId}:${last.id}:${turnStartedAt}`;
		if (key !== state.key) {
			// 新一轮（或换了会话）：上一轮排队的句子作废，切句游标从头开始
			state.token += 1;
			state.busy = false;
			state.queue.length = 0;
			state.reader.reset();
			state.spoke = false;
			state.spokeConversation = "";
			state.key = key;
			state.conversationId = conversationId;
			state.turnStartedAt = turnStartedAt;
			stopSpeaking();
		}
		const units = state.reader.push(body);
		if (units.length > 0) {
			state.spoke = true;
			state.spokeConversation = conversationId;
		}
		enqueue(units, tts);
	};

	useEffect(() => {
		if (!snapshot) return;
		const tts = loadTtsSettings();
		// 先按这一帧的流式正文增量朗读（可能还没到收尾）
		readStreaming(snapshot, tts);
		const cues = planCues(memory.current, snapshot);
		if (cues.length === 0) return;
		const sound = loadSoundSettings();
		/** 收尾（完成 / 被停掉）单独攒起来：并行 / 后台会话一起收尾时，它们得合成一次 */
		const ends: EndCue[] = [];
		for (const cue of cues) {
			if (cue.kind === "done" || cue.kind === "stopped") {
				ends.push(cue);
				continue;
			}
			/**
			 * 插队有自己的开关（设置 → 声音 → 插队，用户 2026-11-03）：关掉就**彻底不响** ——
			 * 提示音和语音片段都不播。别的事件是「提示音归勾选、片段归语音总开关」，
			 * 唯独插队只有这一句「有新任务插队」，不在这里拦一道的话，取消勾选在开了语音时等于没效果。
			 */
			if (cue.kind === "steer" && !sound.steer) continue;
			// 开始 / 出错 / 等审批 / 插队：语音开着就播**预生成的本地片段**，否则只响提示音。
			// 不再走语音合成（固定句子合成在真机上会重复播，2026-11-02）。
			const channel = voiceChannelOf({
				kind: cue.kind,
				voiceEnabled: tts.enabled,
				readReplies: tts.readReplies,
				hasReply: false,
			});
			// 「开始」只有一记轻响、没有片段；插队现在有自己的片段和提示音（`BEEP_OF.steer`）
			if (channel === "clip" && cue.kind !== "start") playVoiceClip(cue.kind);
			else playSound(cue.kind);
		}
		if (ends.length === 0) return;
		/**
		 * 两条会话在同一拍收尾时，以前是两句「任务已完成」先后出声（音频层还会把前一句咬掉重念），
		 * 听感就是「重复播了两遍」。现在：**同一拍合并成一次**（只念一条回复 / 只播一个片段），并且
		 * 1.5s 内不再重复响（并行收尾也常落在相邻的两拍里）。
		 *
		 * 合并时当前会话优先：用户最关心眼前这条是「完成」还是「被停掉」（2026-11-03）。
		 */
		const primary = ends.find((cue) => cue.conversationId === snapshot.active.conversationId) ?? ends[0]!;
		const reply =
			primary.kind === "done" && tts.enabled && tts.readReplies
				? replyToRead(ends.filter(isDoneCue), snapshot.active.conversationId)
				: "";
		const channel = voiceChannelOf({
			kind: primary.kind,
			voiceEnabled: tts.enabled,
			readReplies: tts.readReplies,
			hasReply: reply !== "",
		});
		const nature = primary.kind === "stopped" ? "stopped" : "done";
		// 这一轮被停掉：静音状态可以收掉了（下一轮照常）
		if (nature === "stopped" && muted.current.conversationId === primary.conversationId) {
			muted.current = { conversationId: "", turnStartedAt: 0, on: false };
		}
		// 被停掉的那一轮：立刻收声，别再念剩下的半句（也不要把尾巴留到下一轮）
		if (nature === "stopped") stopStream();
		if (!shouldAnnounceDone(announced.current, channel === "reply" ? reply : null, Date.now(), nature)) return;
		if (channel === "reply") {
			const state = stream.current;
			const silenced = muted.current.on && muted.current.conversationId === primary.conversationId;
			if (silenced) {
				// 用户已经叫停这一轮：收尾这半句也不念，只把状态清干净
				state.spoke = false;
				state.spokeConversation = "";
				state.key = "";
				state.reader.reset();
			} else if (state.spoke && state.spokeConversation === primary.conversationId) {
				// 边出字边念过了：收尾只补还没念到的部分（有的引擎最后一段是收尾时才整段到的）
				const rest = primary.message ? state.reader.push(assistantText(primary.message)) : [];
				enqueue([...rest, ...state.reader.flush()], tts);
				state.spoke = false;
				state.spokeConversation = "";
				state.key = "";
				state.reader.reset();
			} else {
				// 这一轮没有流式念过（比如刚打开开关、或回复太短没赶上流式帧）：照旧整条念
				speakAuto(reply, tts);
			}
		} else if (channel === "clip") {
			playVoiceClip(nature);
		} else playSound("done");
	}, [snapshot]);
	// 空闲时先把三类片段拉下来解码好：回答一结束就要出声，那一拍主线程正在收尾渲染，
	// 现场 fetch + decode 可能把声音拖后半秒（只解码、不播放，不需要先解锁上下文）。
	useEffect(() => {
		const timer = window.setTimeout(preloadVoiceClips, 2000);
		return () => window.clearTimeout(timer);
	}, []);
}
