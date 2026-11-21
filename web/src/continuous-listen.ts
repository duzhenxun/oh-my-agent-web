/**
 * 「连续听写」的决策（纯函数，好测）。
 *
 * 诉求：发完一句不用再点麦克风，接着说就行。但常开麦有几个容易踩的坑，所以判断集中放这里：
 *   - 用户**手动**点了停止 / 撤销：不能再偷偷开麦，否则「我说停它还在听」；
 *   - 页面不可见（切到别的标签页）：不该一直占着麦克风；
 *   - 连续失败（桥没起来、权限被撤）：要能停下来，不能无限重开（热循环比不工作更烦人）。
 *
 * 光看这一层不够的地方也写在这里：真正开麦前还得有机会让 `AudioContext` 处于 running
 * （见 `speech-input-local.ts` 里共享 context 的说明），否则「听着但没字」。
 */
export type ResumeInput = {
	/** 设置里开了「连续听写」 */
	continuous: boolean;
	/** 用户主动停过（手动点浮条 / 撤销自动发送），需要重新点击才恢复 */
	manualPause: boolean;
	status: "idle" | "listening" | "sending";
	/** 页面当前不可见 */
	hidden: boolean;
	/** 连续出错次数（成功出过字会清零） */
	errorStreak: number;
	/** 允许的最大连续出错次数 */
	maxErrorStreak: number;
};

export function shouldResumeListening(input: ResumeInput): boolean {
	if (!input.continuous) return false;
	if (input.manualPause) return false;
	// 只从 idle 重新开：还在听 / 正在发的时候再开一次就是两个会话抢麦克风
	if (input.status !== "idle") return false;
	if (input.hidden) return false;
	return input.errorStreak < input.maxErrorStreak;
}
