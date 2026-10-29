/**
 * ADR-0047：右侧「网页」页的代理地址规则（纯函数）。
 *
 * 为什么需要代理：GitHub / 百度 / 知乎这类站点一律回 `X-Frame-Options: DENY` 或
 * `CSP frame-ancestors`，浏览器直接拒嵌 —— 前端再怎么写都绕不过去，只能在**我们自己的源**
 * 上把文档取回来再吐出去（响应头由我们说了算）。
 *
 * 地址形状刻意做成「镜像路径」而不是 `?url=` 查询：
 *
 *     https://www.baidu.com/s?wd=x   →   /web/p/https/www.baidu.com/s?wd=x
 *
 * 这样页面里的**相对地址**（`img/a.png`、`./x.css`）由浏览器自己按目录规则解析，
 * 天然落到代理前缀下，不需要我们解析整棵 HTML 依赖树。只有「根相对」（`/img/a.png`）
 * 会跑到我们的根上，那一类由 `rewriteHtml` / `rewriteCss` 改写。
 *
 * 与 `web/src/url-bar.ts` 的 `proxyUrlOf` 是**同一个规则的两处实现**：
 * 服务端要反解、客户端要正拼，两边必须保持一致。
 */

/** 代理前缀：不用 `/api` 是为了让页面里的相对地址解析得干净（不做 API 鉴权以外的事情） */
export const PROXY_PREFIX = "/web/p/";

/** 目标地址 → 代理路径。非 http(s) 返回 null（调用方自己决定怎么报错） */
export function proxyPathOf(target: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(target);
	} catch {
		return null;
	}
	if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
	const scheme = parsed.protocol.slice(0, -1);
	// host 里可能带端口（`localhost:3000`）：路径段里冒号是合法的，不用转义
	return `${PROXY_PREFIX}${scheme}/${parsed.host}${parsed.pathname}${parsed.search}`;
}

/**
 * 代理路径 → 目标地址。
 *
 * 传进来的 `pathname` / `search` 是浏览器原样的（未解码）：目标站自己的编码（`%20`、中文）
 * 必须原封不动地带回去，解一次就会把 `%2F` 变成 `/`，那是另一条资源。
 */
export function targetOfProxyPath(pathname: string, search = ""): string | null {
	if (!pathname.startsWith(PROXY_PREFIX)) return null;
	const rest = pathname.slice(PROXY_PREFIX.length);
	const slash = rest.indexOf("/");
	// `https/<host>` 至少要有一个 `/` 把协议与主机分开
	if (slash < 0) return null;
	const scheme = rest.slice(0, slash).toLowerCase();
	const afterScheme = rest.slice(slash + 1);
	const nextSlash = afterScheme.indexOf("/");
	const host = nextSlash < 0 ? afterScheme : afterScheme.slice(0, nextSlash);
	const path = nextSlash < 0 ? "/" : afterScheme.slice(nextSlash);
	if (scheme !== "http" && scheme !== "https") return null;
	if (!host) return null;
	return `${scheme}://${host}${path}${search}`;
}
