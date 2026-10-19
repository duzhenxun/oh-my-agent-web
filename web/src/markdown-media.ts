/**
 * markdown 里的「代码」与「图片」怎么落到界面上（纯函数，便于单测）。
 *
 * 图片只放行三种来源，其余一律不加载（安全 + 不给模型一个任意发请求的口子）：
 *   1. http(s) 远程图片；
 *   2. 我们自己上传的 `/api/uploads/...`；
 *   3. **工作区里的图片文件**（还可能是模型刚截的图）→ 改写成 `/api/files/raw?path=`，
 *      服务端负责「只能看当前项目内」，前端不必也不该拼绝对路径。
 */

/** 纯函数：把 markdown 的 img src 变成可用的地址（返回 null = 不显示） */
export function imageSrcOf(src: string): string | null {
	const value = src.trim();
	if (value === "") return null;
	if (/^https?:\/\//i.test(value)) return value;
	if (value.startsWith("/api/uploads/") || value.startsWith("/api/files/raw")) return value;
	// file:// 形式（模型有时会把本地路径写成链接）
	const local = value.startsWith("file://") ? value.slice("file://".length) : value;
	if (/^(javascript|data|vbscript):/i.test(local)) return null;
	// 绝对路径或相对路径 → 交给服务端在工作区内解析
	return `/api/files/raw?path=${encodeURIComponent(local.replace(/^\.\//, ""))}`;
}

/** 代码块的语言标签（` ```ts title ` → "ts"；没有就返回空串） */
export function languageLabelOf(className: unknown): string {
	if (typeof className !== "string") return "";
	const match = /language-([\w+-]+)/.exec(className);
	return match?.[1] ?? "";
}
