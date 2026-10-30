/**
 * 生成一个随机 id（UUID v4 形状）。
 *
 * 为什么不能直接 `crypto.randomUUID()`：它是**安全上下文**（https / localhost）专属 API。
 * 用 `http://192.168.17.100:25257` 这种局域网 IP 打开时 `window.crypto.randomUUID` 是
 * undefined —— 调用直接抛 `crypto.randomUUID is not a function`，整个前端在启动时就挂了
 * （用户 2026-10-30 实测：远程用 IP 访问只看到「等待服务端快照…」）。
 *
 * `crypto.getRandomValues` 在非安全上下文里仍然可用，所以降级用它拼 v4；
 * 连它都没有（极老浏览器 / 单测 stub）才退到 Math.random —— 这些 id 只用来区分
 * 标签页、侧栏通道和请求序号，不需要密码学强度。
 */
export function newId(): string {
	const cryptoApi = typeof globalThis === "undefined" ? undefined : globalThis.crypto;
	if (cryptoApi && typeof cryptoApi.randomUUID === "function") {
		try {
			return cryptoApi.randomUUID();
		} catch {
			// 某些环境里存在但会抛（例如被策略禁用）：继续走降级
		}
	}
	const bytes = new Uint8Array(16);
	if (cryptoApi && typeof cryptoApi.getRandomValues === "function") {
		cryptoApi.getRandomValues(bytes);
	} else {
		for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
	}
	// RFC 4122 §4.4：version = 4，variant = 10xx
	bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
	bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
	const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
	return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
