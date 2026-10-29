/**
 * 简单节流（thinking 增量推帧用）：窗口内只执行一次。
 * 抽成独立模块只是为了 runtime.ts 守住 400 行，逻辑本身没什么特别。
 */
export function createThrottle(windowMs: number, run: () => void): () => void {
	let last = 0;
	return () => {
		const now = Date.now();
		if (now - last < windowMs) return;
		last = now;
		run();
	};
}
