/**
 * 握手校验（ADR-0006 §握手）—— 本 ADR 的核心条目。
 *
 * 为什么必须有：WebSocket **不受同源策略保护**。你浏览器里打开的任意网页都能向
 * `ws://127.0.0.1:<port>` 发起升级请求；若服务端不校验 Origin，那个网页就能驱动
 * 你这台机器上的 shell。所以「只绑 loopback」并不够，握手是第一道也是唯一一道门。
 *
 * 规则：
 *   - 无 Origin（非浏览器客户端：测试脚本 / CLI / 健康检查）→ 放行；
 *   - 有 Origin → 主机名在允许列表（loopback 或 `AGENT_WEB_ALLOWED_HOSTS` 里配的域名）+ 端口匹配；
 *   - Host 头：如果带了，必须是 loopback 且端口在白名单里（防 DNS rebinding 一类）。
 *
 * 全是纯函数。
 */

const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "[::1]"];

export type OriginPolicy = {
	/** 服务自己的端口（默认 25257；开发态同样用它） */
	port: number;
	/** 额外放行的端口（vite 开发服务器） */
	devPorts?: number[];
	/**
	 * 额外放行的主机名（域名 / 局域网 IP）—— 从 `AGENT_WEB_ALLOWED_HOSTS` 或
	 * `--allow-host` 来。**只有显式配置了才会放行**：默认仍然只认 loopback。
	 */
	extraHosts?: string[];
};

function allowedPorts(policy: OriginPolicy): number[] {
	return [policy.port, ...(policy.devPorts ?? [])];
}

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return LOOPBACK_HOSTNAMES.includes(normalized) || normalized === "::1";
}

/** 主机名在白名单里（loopback 或用户显式配置的域名/局域网 IP） */
function isAllowedHostname(hostname: string, policy: OriginPolicy): boolean {
	if (isLoopbackHostname(hostname)) return true;
	const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
	return (policy.extraHosts ?? []).some((item) => item.toLowerCase() === normalized);
}

function portMatches(port: string | undefined, policy: OriginPolicy): boolean {
	// 缺端口时按默认端口推断：http→80 / https→443，都不可能命中，视为不匹配
	if (!port) return false;
	return allowedPorts(policy).includes(Number.parseInt(port, 10));
}

/** 校验 `Origin` 请求头 */
export function isAllowedOrigin(origin: string | undefined, policy: OriginPolicy): boolean {
	if (!origin) return true; // 非浏览器客户端
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	if (url.protocol !== "http:" && url.protocol !== "https:") return false;
	if (!isAllowedHostname(url.hostname, policy)) return false;
	// 配置了域名（反向代理场景）时端口可能是 80/443，那两种按名字放行
	if (isLoopbackHostname(url.hostname) === false && (url.port === "" || url.port === "80" || url.port === "443")) {
		return true;
	}
	return portMatches(url.port, policy);
}

/** 把 `Host` 头切成「主机名 + 端口」（IPv6 带方括号） */
function splitHost(host: string): { name: string; port: string } {
	const trimmed = host.trim();
	if (trimmed.startsWith("[")) {
		const end = trimmed.indexOf("]");
		if (end < 0) return { name: trimmed.toLowerCase(), port: "" };
		const rest = trimmed.slice(end + 1);
		return { name: trimmed.slice(0, end + 1).toLowerCase(), port: rest.startsWith(":") ? rest.slice(1) : "" };
	}
	const index = trimmed.lastIndexOf(":");
	if (index < 0) return { name: trimmed.toLowerCase(), port: "" };
	return { name: trimmed.slice(0, index).toLowerCase(), port: trimmed.slice(index + 1) };
}

function normalizePort(port: string, protocol: string): string {
	if (port !== "") return port;
	return protocol === "https:" ? "443" : "80";
}

/**
 * `Host` 头是不是「本机回环」（`127.0.0.1:25257` / `localhost:25257` / `[::1]:25257`）。
 *
 * 为什么鉴权要用它：只看 TCP 对端地址是不够的 —— **同机反代 / 隧道**
 * （nginx、cloudflared、tailscale serve、frp…）打过来的连接，对端永远是 127.0.0.1。
 * 于是「从公网域名访问」和「在电脑前点开」在网络层长得一模一样。
 * 判据必须是「这个请求**是发往谁的**」（Host），而不只是「是谁连过来的」。
 *
 * 没有 Host 头（HTTP/1.0、老客户端）→ 认为无法判断，按回环处理：
 * 浏览器与任何反代都会带 Host，不带的一定是本机脚本。
 */
export function isLoopbackHostHeader(host: string | undefined): boolean {
	if (!host) return true;
	const { name } = splitHost(host);
	const bare = name.replace(/^\[|\]$/g, "");
	// 127.0.0.0/8 整段都是回环（与 auth.ts 的 isLoopback 同一口径），不只是 127.0.0.1
	return isLoopbackHostname(bare) || bare.startsWith("127.");
}

/**
 * `Origin` 和 `Host` 是不是同一个源。
 *
 * HTTP 面的门禁靠它：**同源请求永远放行**（不管你用什么域名/域名解析进来 —— 页面是从这儿加载的，
 * 它的 POST 当然该能用），跨源的才去比白名单。跨站请求这两个头一定不一致
 * （Host 由 URL 决定，Origin 由页面自己的源决定，浏览器两边都不给脚本改）。
 */
export function isSameOrigin(origin: string | undefined, host: string | undefined): boolean {
	if (!origin || !host) return false;
	let url: URL;
	try {
		url = new URL(origin);
	} catch {
		return false;
	}
	const target = splitHost(host);
	const originName = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
	const targetName = target.name.replace(/^\[|\]$/g, "");
	return (
		originName === targetName && normalizePort(url.port, url.protocol) === normalizePort(target.port, url.protocol)
	);
}
