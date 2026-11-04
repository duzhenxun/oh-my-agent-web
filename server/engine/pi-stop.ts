/**
 * 「停止」要真的停下来（pi 的 `abort()` 有竞态，见 pi-sdk.ts 的 `interrupt`）。
 *
 * 竞态的形状：一轮刚结束、pi 正准备自动重试的那个窗口里调用 `abort()`，既没有在跑的流，
 * 也还没建好退避控制器，停止无效；重试照跑、`agent_settled` 迟迟不来，界面一直「正在跑」。
 *
 * 所以发出停止之后，只要**这一轮**还没 settle，就隔一会儿补一次「取消重试 + abort」。
 * 这里只放策略本身（何时补、补几次、何时放弃），时钟与会话都从外面注入，便于测试。
 */

export type StopLoopOptions = {
	/** 这一轮还在跑，并且仍是发出停止的那一轮（序号没变）。false 就收手 */
	stillStopping: () => boolean;
	/** 取消 pi 的退避重试（没有退避时是空操作） */
	cancelRetry: () => void;
	/** 再发一次 abort（失败就下一拍再试） */
	abortOnce: () => Promise<void>;
	sleep: (ms: number) => Promise<void>;
	/** 最多补几次（默认 8） */
	maxTicks?: number;
	/** 两次之间隔多久（默认 1000ms） */
	tickMs?: number;
};

export async function keepAbortingUntilSettled(options: StopLoopOptions): Promise<number> {
	const maxTicks = options.maxTicks ?? 8;
	const tickMs = options.tickMs ?? 1000;
	let sent = 0;
	for (let tick = 0; tick < maxTicks; tick += 1) {
		await options.sleep(tickMs);
		if (!options.stillStopping()) return sent;
		options.cancelRetry();
		try {
			await options.abortOnce();
		} catch {
			// 补发失败不算数：下一拍再来
		}
		sent += 1;
	}
	return sent;
}
