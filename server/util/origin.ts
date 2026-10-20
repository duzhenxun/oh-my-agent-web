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
 * 全是纯函数，单测直接覆盖。
 */

export const LOOPBACK_HOSTNAMES = ["127.0.0.1", "localhost", "::1", "[::1]"];

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

export function allowedPorts(policy: OriginPolicy): number[] {
	return [policy.port, ...(policy.devPorts ?? [])];
}

export function isLoopbackHostname(hostname: string): boolean {
	const normalized = hostname.toLowerCase();
	return LOOPBACK_HOSTNAMES.includes(normalized) || normalized === "::1";
}

/** 主机名在白名单里（loopback 或用户显式配置的域名/局域网 IP） */
export function isAllowedHostname(hostname: string, policy: OriginPolicy): boolean {
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

/** 校验 `Host` 请求头（缺失时放行；带了就必须是 loopback + 白名单端口） */
export function isAllowedHost(host: string | undefined, policy: OriginPolicy): boolean {
	if (!host) return true;
	const trimmed = host.trim();
	const [hostname, port] = trimmed.startsWith("[")
		? [trimmed.slice(0, trimmed.indexOf("]") + 1), trimmed.slice(trimmed.indexOf("]") + 2)]
		: trimmed.split(":");
	if (!isAllowedHostname(hostname ?? "", policy)) return false;
	if (port === undefined || port === "" || port === "80" || port === "443")
		return isAllowedHostname(hostname ?? "", policy);
	return portMatches(port, policy);
}

/** 给人类看的错误信息（连不上时能立刻明白原因，而不是干瞪眼） */
export function describePolicy(policy: OriginPolicy): string {
	const hosts = [...LOOPBACK_HOSTNAMES, ...(policy.extraHosts ?? [])];
	return `允许的来源：${hosts.join(" / ")}；端口 ${allowedPorts(policy).join(" / ")}`;
}
