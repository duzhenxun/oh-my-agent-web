/**
 * 浮条上的「静音进度环」（纯函数，好测）。
 *
 * 问题：说完之后要等 1.2 秒静音才进那 0.6 秒的撤销窗口，前面这 1.2 秒界面上毫无变化 ——
 * 用户不知道「它到底在等，还是根本没听见」，只能干等或者再点一下（点了就变成手动停）。
 *
 * 所以把这段等待画成环：说话时环归零，静音开始填充，填满的那一刻正好进撤销窗口。
 * 环只表示**进度**，不参与判断 —— 判定仍是 `startSilenceWatch` 那一处。
 */
export function silenceRatio(elapsedMs: number, thresholdMs: number): number {
	if (!Number.isFinite(elapsedMs) || !Number.isFinite(thresholdMs) || thresholdMs <= 0) return 0;
	if (elapsedMs <= 0) return 0;
	if (elapsedMs >= thresholdMs) return 1;
	return elapsedMs / thresholdMs;
}

/** 环的填充量要不要真的发出去（0.08 的粒度：200ms 一拍约等于每次涨一点，不至于刷屏） */
export function ringChanged(previous: number, next: number): boolean {
	return Math.abs(next - previous) >= 0.08 || (previous > 0 && next === 0);
}

/** 「说完多久算说完」的可调范围（毫秒）：0.6 秒太容易切断，10 秒以上用户会以为坏了 */
export const SILENCE_MIN_MS = 600;
export const SILENCE_MAX_MS = 10_000;

/**
 * 设置面板填的是**秒**，状态机用的是毫秒 —— 这里统一换算并夹到合法范围。
 * 存坏了（手改 localStorage / 老版本没有这一项）就回落默认。
 */
export function clampSilenceMs(seconds: unknown, fallbackMs: number): number {
	if (typeof seconds !== "number" || !Number.isFinite(seconds)) return fallbackMs;
	const ms = Math.round(seconds * 1000);
	return Math.min(SILENCE_MAX_MS, Math.max(SILENCE_MIN_MS, ms));
}

/** 「多久没说话就自动关麦」的范围（秒）：0 = 不自动关。太短会把正常思考当成不说话 */
export const IDLE_STOP_MIN_SEC = 3;
export const IDLE_STOP_MAX_SEC = 120;

export function clampIdleStopSec(value: unknown): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return 0;
	if (value <= 0) return 0;
	return Math.min(IDLE_STOP_MAX_SEC, Math.max(IDLE_STOP_MIN_SEC, Math.round(value)));
}
