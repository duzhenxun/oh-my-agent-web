/**
 * markdown 里的「代码」与「图片」怎么落到界面上（纯函数）。
 *
 * 图片只放行三种来源，其余一律不加载（安全 + 不给模型一个任意发请求的口子）：
 *   1. http(s) 远程图片；
 *   2. 我们自己上传的 `/api/uploads/...`；
 *   3. **工作区里的图片文件**（还可能是模型刚截的图）→ 改写成 `/api/files/raw?path=`，
 *      服务端负责「只能看当前项目内」，前端不必也不该拼绝对路径。
 *
 * 还有一层「猜」：模型常常不写 `![]()`，只把路径写在正文里（`1. 色块：/tmp/a.png`），
 * 于是对话里只有一串蓝字。`promoteImagePaths` 负责把这种路径提升成图片，
 * 规则与「不动」的反例都写在它上面。
 */

/**
 * 回退一层 URL 编码（纯函数）。
 *
 * markdown 解析器会把目的地里的非 ASCII 字符百分号编码（`映客活动数据` → `%E6%98%A0%E5%AE%A2…`），
 * 于是「作者写的路径」和「组件拿到的 src」长得不一样，不处理会连锁出错：
 *   1. `imageSrcOf` 再编码一次 → `/api/files/raw?path=%25E6…`，服务端解一次得到的仍是编码串，
 *      直接报「路径不存在或无法解析」；
 *   2. 图加载失败回退成路径按钮时，用户看到的是 `%E6%98%A0…` 而不是中文。
 * 所以统一「先解码一次再当真值用」；不是合法编码串就原样返回。
 */
export function decodePathOnce(value: string): string {
	if (!value.includes("%")) return value;
	try {
		const decoded = decodeURIComponent(value);
		return decoded === value ? value : decoded;
	} catch {
		return value;
	}
}

/** 纯函数：把 markdown 的 img src 变成可用的地址（返回 null = 不显示） */
export function imageSrcOf(src: string): string | null {
	const value = src.trim();
	if (value === "") return null;
	if (/^https?:\/\//i.test(value)) return value;
	if (value.startsWith("/api/uploads/") || value.startsWith("/api/files/raw")) return value;
	// file:// 形式（模型有时会把本地路径写成链接）
	// Windows 的 file URL 会多一个前导斜杠（`file:///C:/x.png`）：不剥掉服务端就认不出盘符
	const local = value.startsWith("file://")
		? value.slice("file://".length).replace(/^\/(?=[A-Za-z]:[\\/])/, "")
		: value;
	if (/^(javascript|data|vbscript):/i.test(local)) return null;
	// 绝对路径或相对路径 → 交给服务端在工作区内解析
	// 先解一层：解析器已经把非 ASCII 编码过了，不再解就会变成双重编码（见 decodePathOnce）
	return `/api/files/raw?path=${encodeURIComponent(decodePathOnce(local).replace(/^\.\//, ""))}`;
}

/**
 * 「模型只写了路径」的图，怎么在对话里直接显示出来。
 *
 * 事故：让模型生成两张图，它回的是 `1. 随机几何色块：/Users/…/random_1.png` —— 于是对话里
 * 只有一串蓝色路径，用户还得自己去文件树/预览面板里翻。图片路径出现在消息里，就等于用户想看图。
 *
 * 只在 markdown 源码层面做一件事：把「指向图片文件的路径」改写成 `![](<path>)`，后面照常走
 * `imageSrcOf` → `/api/files/raw` 那条既有管线（权限、大小、MIME 白名单都在服务端）。
 * 四种写法都认：裸路径、行内代码、指向本地图片的链接、以及本来就正确的 `![]()`（原样不动）。
 */

/** 图片后缀白名单：只有这些后缀的路径才算「要显示的图」（其余扩展名一律原样保留成文字） */
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg", "ico"]);

/** 图片 token 的尾巴（供两个正则共用，避免两处各写一遍后缀列表） */
const IMAGE_SUFFIX = "\\.(?:png|jpe?g|gif|webp|avif|bmp|svg|ico)";

/** 纯函数：这一整段文字是不是一个图片文件路径（`/tmp/a.png`、`~/x.JPG`、`C:\\a.png`、`shot.webp`） */
export function isImagePath(value: string): boolean {
	// 链接可能被尖括号包着（`![](<…>)` 的写法），也允许反引号残留
	const token = value
		.trim()
		.replace(/^<+|>+$/g, "")
		.replace(/^`+|`+$/g, "");
	if (token === "" || /\s/.test(token)) return false;
	const match = /\.([A-Za-z0-9]{2,5})$/.exec(token);
	return match ? IMAGE_EXTENSIONS.has(match[1]!.toLowerCase()) : false;
}

/** 图片路径里的文件名（当 alt；图片加载失败时也用它兜底显示） */
function imageNameOf(path: string): string {
	const name = path.split(/[\\/]/).pop() ?? path;
	return name.trim() === "" ? path : name;
}

/** 拼成 markdown 图片；路径一律用 `<>` 包住（截图名里常有括号，例如 `a(1).png`） */
function imageMarkdownOf(path: string, label?: string): string {
	const alt = (label ?? "").trim() || imageNameOf(path);
	return `![${alt.replace(/[[\]]/g, "")}](<${path.replace(/>/g, "%3E")}>)`;
}

/** 「像路径的图片 token」：必须有路径形状（`~/`、`/`、`C:\`），且以图片后缀结尾 */
const IMAGE_TOKEN = new RegExp(`(?:~/|[A-Za-z]:[\\\\/]|/)[^\\s"'\`<>|*?]+${IMAGE_SUFFIX}\\b`, "gi");

/**
 * 这个 token 前面那个字符允不允许「从这里开始一个新路径」。
 *
 * 白名单而不是黑名单，因为要挡的其实是一堆「path 属于别的东西」的形状：
 * `http://host/a.png` 的中间段（前面是 `:`）、`[x](/abs/a.png)` 的 dst（前面是 `(`）、
 * 我们自己刚拼出来的 `![](</abs/a.png>)`（前面是 `<`）。宁可漏提升，不要拼出畸形 markdown。
 */
const TOKEN_LEAD = /^[\s，。、；：！？,;!?…—·（）【】「」『』“”‘’"'《》]$/;

/** 已经是 markdown 图片/链接的 `[…](…)` 或裸路径的行内代码：把它当图 */
function promotePlain(segment: string): string {
	if (segment === "") return segment;
	// 1) 链接指向本地图片：`[名字](/abs/a.png)` → `![名字](</abs/a.png>)`
	//    负向断言 `(?<!!)`：本来就是 `![alt](path)` 的图片语法不要再包一层
	const linked = segment.replace(/(?<!!)\[([^\]\n]*)\]\(([^)\s]+)\)/g, (whole, label: string, href: string) =>
		isImagePath(href) ? imageMarkdownOf(href, label) : whole,
	);
	// 2) 光秃秃的路径：`已保存到 /tmp/a.png`
	return linked.replace(IMAGE_TOKEN, (token: string, offset: number) => {
		const before = offset > 0 ? linked[offset - 1]! : "";
		if (before !== "" && !TOKEN_LEAD.test(before)) return token;
		return imageMarkdownOf(token);
	});
}

/** 一行里：行内代码整段是图片路径 → 图；其余部分交给 `promotePlain` */
function promoteLine(line: string): string {
	if (!line.includes(".")) return line;
	let out = "";
	let cursor = 0;
	for (const span of line.matchAll(/(`+)([^`]+?)\1/g)) {
		const start = span.index ?? 0;
		out += promotePlain(line.slice(cursor, start));
		const code = span[2] ?? "";
		out += isImagePath(code) ? imageMarkdownOf(code) : span[0];
		cursor = start + span[0].length;
	}
	return out + promotePlain(line.slice(cursor));
}

/**
 * 纯函数：把消息里的图片路径提升成 markdown 图片（代码块内一律不动 —— 那是代码，不是内容）。
 * 返回新字符串；没有可提升的就原样返回（同一个引用，调用方的 memo 可以直接跳过重渲染）。
 */
export function promoteImagePaths(text: string): string {
	if (!new RegExp(IMAGE_SUFFIX, "i").test(text)) return text;
	let fence: string | null = null;
	const out = text.split("\n").map((line) => {
		const fenceMark = /^\s*(```|~~~)/.exec(line);
		if (fence !== null) {
			if (fenceMark) fence = null;
			return line;
		}
		if (fenceMark) {
			fence = fenceMark[1]!;
			return line;
		}
		// 表格行（GFM）不提升：把单元格里的行内代码变成图片会把表格结构拆坏，
		// 而且表格里的路径多半是「给人看的简称」（如 `a/.../x.png`），本来就不是真实路径
		if (/^\s*\|/.test(line)) return line;
		return promoteLine(line);
	});
	return out.join("\n");
}

/** `![alt](<path>)` 这类图片 markdown 的整行匹配（一段里可以连着好几个） */
const IMAGE_ONLY_BLOCK = /^\s*(?:!\[[^\]]*\]\(\s*<?[^)\s>]+>?\s*\)\s*)+$/;

/**
 * 纯函数：把「连续若千个只有图片的段落」并成一段。
 *
 * 为什么需要：模型出图时习惯每张图占一行、段落之间空一行，于是 markdown 会渲染成多个 `<p>`；
 * 而 `<p>` 是块级容器，图就必然一张一行。合并成一段后，渲染层（`Markdown.tsx` 的 `p`）
 * 能把它换成 flex 容器，小图就能自动多列并排（样式见 `styles/markdown.css` 的 `.md-img-grid`）。
 *
 * 边界：代码块（fence）内的内容一律不动；列表项/引用里的图不合并（它们的缩进/前缀不匹配）。
 */
export function groupImageBlocks(text: string): string {
	if (!new RegExp(IMAGE_SUFFIX, "i").test(text)) return text;
	const out: string[] = [];
	let fence: string | null = null;
	let run: string[] = [];
	/** 收尾一段图片：补一个空行，保证不会和后面的正文粘成同一段（文末那次不补） */
	const flush = (atEnd = false) => {
		if (run.length === 0) return;
		out.push(run.join("\n"));
		if (!atEnd) out.push("");
		run = [];
	};
	for (const line of text.split("\n")) {
		const fenceMark = /^\s*(```|~~~)/.exec(line);
		if (fence !== null) {
			flush();
			if (fenceMark) fence = null;
			out.push(line);
			continue;
		}
		if (fenceMark) {
			flush();
			fence = fenceMark[1]!;
			out.push(line);
			continue;
		}
		// 空行：正在收集图片时直接吞掉（它就是我们要合并掉的那个段落分隔）
		if (line.trim() === "") {
			if (run.length > 0) continue;
			out.push(line);
			continue;
		}
		if (IMAGE_ONLY_BLOCK.test(line)) {
			run.push(line.trim());
			continue;
		}
		flush();
		out.push(line);
	}
	flush(true);
	return out.join("\n");
}

/** 代码块的语言标签（` ```ts title ` → "ts"；没有就返回空串） */
export function languageLabelOf(className: unknown): string {
	if (typeof className !== "string") return "";
	const match = /language-([\w+-]+)/.exec(className);
	return match?.[1] ?? "";
}
