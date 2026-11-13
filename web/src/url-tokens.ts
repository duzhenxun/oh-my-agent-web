/**
 * 消息里的「网址」识别（纯函数）。
 *
 * 为什么单独一层：正文里**裸写**的地址，`remark-gfm` 已经自动认成链接（Markdown.tsx 那边一律
 * `target="_blank"`）；但有三种地方绕过了 markdown 解析，地址在那里只是一串字：
 *   1. 行内代码 `` `https://…/index.html` `` —— 以前被 `looksLikePath` 认成「工作区文件」，
 *      渲染成点状下划线的路径按钮，点了是去右侧面板找一个**不存在**的文件；
 *   2. 代码块里的「地址清单」（贴一组环境地址，见 path-tokens 的 pathTokens）；
 *   3. 用户自己发的消息 —— 按原文纯文字显示（不解析 markdown，贴进来的 HTML 才不会被吞掉）。
 * 三处共用这里的识别结果：**网址就是网址，一律新标签页打开**（用户 2026-11-10）。
 */

/** 一段文字里的 http(s) 网址：到空白或引号 / 尖括号 / 竖线 / 反斜杠为止 */
const URL_IN_TEXT = /https?:\/\/[^\s<>"'`|\\]+/gi;

/** 网址尾巴上常被句子带进来的标点（`,` `。` 之类不属于地址），当链接时剥掉 */
const TRAILING_PUNCT = /[.,;:!?，。、；：！？]+$/;

/** 「协议 + 主机」这一段（`https://` 后面什么都没有的不算网址） */
const HAS_HOST = /^https?:\/\/[^/\s]+/i;

/**
 * 纯函数：把一个「可能是网址」的 token 收干净 —— 剥掉句尾标点，再确认它真的有主机。
 * 不是网址（`https://`、`https:///x`）返回 null，调用方原样当文字处理。
 */
export function trimUrlToken(raw: string): string | null {
	const url = raw.replace(TRAILING_PUNCT, "");
	return HAS_HOST.test(url) ? url : null;
}

/** 纯函数：这一整段文字就是一个网址（行内代码 `` `https://…` ``） */
export function isUrl(value: string): boolean {
	const text = value.trim();
	if (text === "" || /\s/.test(text)) return false;
	return trimUrlToken(text) !== null && trimUrlToken(text) === text;
}

export type TextOrUrl = { text: string; url?: string };

/**
 * 纯函数：把一段纯文字切成「文字 / 网址」片段（用户消息的正文渲染）。
 * 没有网址时返回单个片段（调用方据此走原来的纯文字分支，不多包一层节点）。
 */
export function urlTokens(line: string): TextOrUrl[] {
	const parts: TextOrUrl[] = [];
	let last = 0;
	for (const match of line.matchAll(URL_IN_TEXT)) {
		const url = trimUrlToken(match[0]);
		const start = match.index ?? 0;
		// 不是网址（`https://` 光秃秃一个协议）就跳过：原文留在下一段文字里
		if (url === null) continue;
		if (start > last) parts.push({ text: line.slice(last, start) });
		parts.push({ text: url, url });
		// 句尾被剥掉的标点不算进网址：下标只前进网址那一段，标点会跟着下一段文字出来
		last = start + url.length;
	}
	if (last < line.length) parts.push({ text: line.slice(last) });
	return parts.length > 0 ? parts : [{ text: line }];
}
