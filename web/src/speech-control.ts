/**
 * 「正在朗读」的全局状态 + 停止 / 暂停请求。
 *
 * 为什么单独一个模块：朗读发生在 `use-voice-cues.ts`（流式逐句念），而「停止」的入口有
 * 三处 —— 设置面板的「停止」、消息上那颗按钮、以及随时要能按的快捷键 / 悬浮条。
 * 谁都不能直接去 import 那个 hook，所以用一份极小的模块级状态把两边接起来。
 *
 * 暂停 / 继续也放这里：真正的冻住发生在 `tts.ts`（浏览器 pause / AudioContext 挂起），
 * 而「暂停后别再取下一句」发生在 `use-voice-cues.ts` 的队列里 —— 浮条（App）和队列都得订阅它。
 */
import { useSyncExternalStore } from "react";
import { isSpeechPaused as isTtsPaused, onSpeechPauseChange as onTtsPauseChange, pauseSpeaking, resumeSpeaking } from "./tts.ts";

let reading = false;
const listeners = new Set<() => void>();
const stopListeners = new Set<() => void>();

function notify(): void {
	for (const listener of listeners) listener();
}

export function setReading(next: boolean): void {
	if (reading === next) return;
	reading = next;
	notify();
}

export function isReading(): boolean {
	return reading;
}

function subscribe(listener: () => void): () => void {
	listeners.add(listener);
	return () => listeners.delete(listener);
}

/** 界面用：现在是不是正在朗读（悬浮条据此显示） */
export function useReading(): boolean {
	return useSyncExternalStore(subscribe, isReading, isReading);
}

/**
 * 请朗读端停下来。**同时会让这一轮剩下的文字不再自动念** ——
 * 用户按「停止」的意图是「别念了」，不是「念完这一句再接着念下一句」（那样等于没停）。
 */
export function requestStopSpeech(): void {
	for (const listener of stopListeners) listener();
}

/** 朗读端订阅停止请求；返回取消订阅 */
export function onStopSpeechRequest(listener: () => void): () => void {
	stopListeners.add(listener);
	return () => stopListeners.delete(listener);
}

/* ---- 暂停 / 继续 ---- */

/**
 * 暂停状态的唯一真相在 `tts.ts`（真正被冻住的是那儿的语音队列 / AudioContext）。
 * 这里只做两件事：把它的变化转成 React 订阅，以及把界面上的点击转给它。
 *
 * 为什么绕这一层：悬浮条在 `App.tsx`、流式队列在 `use-voice-cues.ts`，两边都不能直接
 * 依赖对方；而「暂停之后不要接着从队列取下一句」只能由队列那边做（见 use-voice-cues.ts
 * 的 drain）。所以暂停要能广播给两边。
 */
let paused = false;
const pauseListeners = new Set<() => void>();

function emitPaused(): void {
	for (const listener of pauseListeners) listener();
}

// tts 自己复位（新的朗读顶掉暂停中的旧段、点停止）时，这里的按钮状态跟着回去
onTtsPauseChange(() => {
	const actual = isTtsPaused();
	if (actual === paused) return;
	paused = actual;
	emitPaused();
});

function subscribePaused(listener: () => void): () => void {
	pauseListeners.add(listener);
	return () => pauseListeners.delete(listener);
}

/** 界面用：现在是不是停在「暂停」上（浮条据此换字、换色） */
export function useSpeechPaused(): boolean {
	return useSyncExternalStore(subscribePaused, isSpeechPausedNow, isSpeechPausedNow);
}

/** 同步读：流式队列取下一句前用它挡一下 */
export function isSpeechPausedNow(): boolean {
	return paused;
}

/** 浮条上的「暂停 / 继续」。没在念的时候点它什么也不会发生（tts 那边会直接拒） */
export function setSpeechPaused(next: boolean): void {
	if (next === paused) return;
	if (next) pauseSpeaking();
	else resumeSpeaking();
	// 以 tts 的真实状态为准：`pauseSpeaking` 在「根本没在放」时是无动作的
	const actual = isTtsPaused();
	if (actual === paused) return;
	paused = actual;
	emitPaused();
}

/** 订阅暂停状态变化（队列解冻时接着 drain）；返回取消订阅 */
export function onSpeechPauseChange(listener: () => void): () => void {
	pauseListeners.add(listener);
	return () => pauseListeners.delete(listener);
}
