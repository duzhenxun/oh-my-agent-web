/**
 * 文件大小的人话写法：小于 1KB 保留字节数，之后按 KB / MB 取一位小数。
 *
 * 1024 进制（和 `ls -h`、Finder 的「大小」一致）。纯函数，没有 i18n 依赖：
 * 单位 KB / MB 中英文通用，只有「字节」那一档需要调用方自己决定怎么说。
 */
export function formatByteSize(bytes: number): { value: string; unit: "B" | "KB" | "MB" } {
	if (bytes < 1024) return { value: String(Math.round(bytes)), unit: "B" };
	if (bytes < 1024 * 1024) return { value: (bytes / 1024).toFixed(1), unit: "KB" };
	return { value: (bytes / (1024 * 1024)).toFixed(1), unit: "MB" };
}
