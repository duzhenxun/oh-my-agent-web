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
 * 兄弟回环主机：`127.0.0.1` ↔ `localhost`（`[::1]` 也归到 `127.0.0.1`）。
 *
 * 为什么要换个主机名：网页页需要一个「真实的源」才跑得起来（有的页面启动就读 cookie /
 * `window.parent` 上的桥属性，不透明源直接抛错 → 整页黑屏），而直接给它
 * `allow-same-origin` 等于把**工作台自己的源**交出去。换成兄弟回环主机后，页面有了真源，
 * 却是另一个 origin（cookie 罐、localStorage 都与工作台隔离）—— 两全。
 *
 * 拿不到兄弟主机（局域网 IP / 域名 / 自建反代访问）时返回 null，调用方回落到原来的沙箱。
 */
export function siblingLoopbackHost(hostname: string): string | null {
	const name = hostname.toLowerCase();
	if (name === "127.0.0.1") return "localhost";
	if (name === "localhost") return "127.0.0.1";
	if (name === "::1" || name === "[::1]") return "127.0.0.1";
	return null;
}

/**
 * 同源外壳地址（服务端见 `server/web-proxy/wrapper.ts`）：外壳与页面同源、与工作台不同源。
 *
 * 只有三个前提都满足才给：
 *   - 访问方式是 `http:`（`https:` 下换成 `localhost` 会撞证书主机名不符，宁可不开）；
 *   - 当前主机是回环地址（远程访问没有兄弟回环主机，那类情况照旧走原沙箱）；
 *   - 原网址能走代理（非 http(s) 就没有代理地址，也就没外壳）。
 */
export function wrapperUrlOf(
	target: string,
	page: { protocol: string; hostname: string; port: string },
	options: { mobile?: boolean } = {},
): string | null {
	if (page.protocol !== "http:") return null;
	const sibling = siblingLoopbackHost(page.hostname);
	if (sibling === null) return null;
	if (proxyUrlOf(target) === null) return null;
	const port = page.port === "" ? "" : `:${page.port}`;
	// `m=1`：手机模式。外壳里那一帧要落进手机前缀，UA 才会跟着换（见 proxy-routes.ts）。
	const mobile = options.mobile === true ? "&m=1" : "";
	return `${page.protocol}//${sibling}${port}/web/w?u=${encodeURIComponent(target)}${mobile}`;
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

/**
 * 手机模式的代理前缀：同一套镜像路径，上游换成手机 User-Agent（服务端见 `proxy-url.ts`）。
 *
 * 为什么要换：不少站点按 **User-Agent** 决定发电脑版还是手机版，跟视口宽度无关 ——
 * 只把 iframe 收窄到 390px，它们还是回电脑版，「手机尺寸预览」就成了「一台窄电脑」。
 * 换前缀而不是加查询参数：页面里的**相对地址**由浏览器按目录规则解析，前缀一换自动跟上。
 */
export const MOBILE_PREFIX = "/web/m/";

export function proxyUrlOf(target: string, options: { mobile?: boolean } = {}): string | null {
	try {
		const parsed = new URL(target);
		if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
		const prefix = options.mobile === true ? MOBILE_PREFIX : PROXY_PREFIX;
		return `${prefix}${parsed.protocol.slice(0, -1)}/${parsed.host}${parsed.pathname}${parsed.search}`;
	} catch {
		return null;
	}
}

/**
 * 代理地址 → 原始网址（`proxyUrlOf` 的反向）。
 *
 * 为什么前端也需要反向：iframe 里 `location.href` 报的是**代理**地址
 * （`/web/p/http/host/path`），而面板记的是用户输入的那个网址 —— 两边不换算，
 * 「这一页标了几处」就永远对不上（编号框一个也画不出来），写进注释里的地址
 * 也会变成一串 `/web/p/...` 的内部路径给模型看。
 *
 * 规则与服务端 `server/web-proxy/proxy-url.ts` 的 `targetOfProxyPath` 严格一致；
 * 只有一处不同：那边的 `pathname` / `search` 是浏览器原样的两段，这里拿到的是整条 URL。
 */
export function targetOfProxyUrl(href: string): string | null {
	let parsed: URL;
	try {
		parsed = new URL(href);
	} catch {
		return null;
	}
	const prefix = parsed.pathname.startsWith(MOBILE_PREFIX) ? MOBILE_PREFIX : PROXY_PREFIX;
	if (!parsed.pathname.startsWith(prefix)) return null;
	const rest = parsed.pathname.slice(prefix.length);
	const slash = rest.indexOf("/");
	if (slash < 0) return null;
	const scheme = rest.slice(0, slash).toLowerCase();
	const afterScheme = rest.slice(slash + 1);
	const nextSlash = afterScheme.indexOf("/");
	const host = nextSlash < 0 ? afterScheme : afterScheme.slice(0, nextSlash);
	const path = nextSlash < 0 ? "/" : afterScheme.slice(nextSlash);
	if (scheme !== "http" && scheme !== "https") return null;
	if (!host) return null;
	return `${scheme}://${host}${path}${parsed.search}${parsed.hash}`;
}
