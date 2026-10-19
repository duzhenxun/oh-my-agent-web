/**
 * 粘底滚动的纯函数（放在没有 DOM 依赖的文件里：单测环境不加载 DOM lib）。
 */

/** 距底部多少像素以内算「还粘着底」（给用户手指一点余地） */
export const STICK_THRESHOLD_PX = 80;

/** 纯函数：判断滚动容器是否还粘着底部 */
export function isNearBottom(
	scrollHeight: number,
	scrollTop: number,
	clientHeight: number,
	threshold = STICK_THRESHOLD_PX,
): boolean {
	return scrollHeight - scrollTop - clientHeight <= threshold;
}
