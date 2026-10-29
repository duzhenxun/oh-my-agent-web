/**
 * 右侧分栏「网页」页的地址栏解析（纯函数）。
 *
 * 只做三件事，多一件都不做：补协议、挡住不该嵌的协议、给标签栏取个短名字。
 * 不做搜索改写（用户输入的是网址，不是搜索词）：猜错会把 `github.com` 扔进搜索引擎。
 *
 * 唯一的小坑是 `localhost:3000` —— 形状跟 `javascript:` 一样，冒号后面却是端口号，
 * 所以「冒号后面是数字」的当成主机，其余当成协议。
 */
const SCHEME = /^([a-z][a-z0-9+.-]*):/i;
const PORT_TAIL = /^\d+(\/|$|\?|#)/;

export function normalizeUrl(raw: string): string | null {
	const text = raw.trim();
	if (!text) return null;
	const match = SCHEME.exec(text);
	if (match) {
		const scheme = match[1].toLowerCase();
		const rest = text.slice(match[0].length);
		// 看着像协议、其实是「主机:端口」的，落到最后那步去补协议
		if (rest.startsWith("//") || !PORT_TAIL.test(rest)) {
			// 真协议：只放行 http(s)，`javascript:` / `data:` / `file:` / `mailto:` 一律拒绝
			if (scheme !== "http" && scheme !== "https") return null;
			try {
				return new URL(text).toString();
			} catch {
				return null;
			}
		}
	}
	// 本机地址默认 http：`localhost:3000` 走 https 一定连不上（本地开发服务基本都是 http）
	const scheme = isLocalHost(text) ? "http://" : "https://";
	try {
		return new URL(`${scheme}${text}`).toString();
	} catch {
		return null;
	}
}

/** 是不是本机地址（`localhost` / `127.0.0.1` / `[::1]`，带不带端口都算） */
function isLocalHost(text: string): boolean {
	return /^(localhost|127\.0\.0\.1|\[::1\])(:|\/|$)/i.test(text);
}

/** 标签上显示什么：有域名用域名（去掉 www.），没有就用原文 */
export function hostOf(url: string): string {
	try {
		const parsed = new URL(url);
		return parsed.host.replace(/^www\./i, "") || url;
	} catch {
		return url;
	}
}

/**
 * 网页页的代理前缀（ADR-0047）：点开的页面由**本机服务端**取回来再吐给我们，
 * 这样 `X-Frame-Options: DENY` / `CSP frame-ancestors` 就不再拦得住它。
 *
 * 地址形状与服务端 `server/web-proxy/proxy-url.ts` 严格一致（镜像路径）：
 * `https://www.baidu.com/s?wd=x` → `/web/p/https/www.baidu.com/s?wd=x`。
 * 两边的拼法必须严格一致。
 */
export const PROXY_PREFIX = "/web/p/";

export function proxyUrlOf(target: string): string | null {
	try {
		const parsed = new URL(target);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		return `${PROXY_PREFIX}${parsed.protocol.slice(0, -1)}/${parsed.host}${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
}
