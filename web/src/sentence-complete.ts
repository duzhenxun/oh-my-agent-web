/**
 * 「这句话说完了吗」的启发式判断（纯函数，好测）。
 *
 * 为什么需要：静音阈值只能表达「停顿多久」，表达不了「句子是否讲完」。实测里用户说
 * 「诶，为什么你刚才」这种半句时，停顿同样是 2 秒以上 —— 阈值调多大都会切。
 *
 * 判据很土但有效：**结尾是逗号 / 顿号 / 分号 / 冒号 / 破折号 / 左引号左括号**，说明话还没落地，
 * 这时不自动发送（继续等他说完）。识别结果里这些标点是随停顿一起出来的，所以命中率不低。
 */
const CONTINUING_ENDINGS = [
	"，",
	",",
	"、",
	"；",
	";",
	"：",
	":",
	"—",
	"-",
	"…",
	"“",
	"「",
	"「",
	"（",
	"(",
];

export function looksUnfinished(text: string): boolean {
	const trimmed = text.trim();
	if (trimmed === "") return false;
	const last = trimmed.slice(-1);
	return CONTINUING_ENDINGS.includes(last);
}
