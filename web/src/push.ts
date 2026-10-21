/**
 * 浏览器侧推送订阅（服务端见 server/push）。
 *
 * 注意：Web Push 要求 **https 或 localhost**，远程用 http://192.168.x.x 打开时
 * 浏览器会直接拒绝订阅 —— 所以手机上要用域名（https）。
 */
export type PushState = "unsupported" | "default" | "granted" | "denied" | "subscribed";

function urlBase64ToUint8Array(base64: string): Uint8Array {
	const padded = `${base64}${"=".repeat((4 - (base64.length % 4)) % 4)}`.replace(/-/g, "+").replace(/_/g, "/");
	const raw = atob(padded);
	const out = new Uint8Array(raw.length);
	for (let i = 0; i < raw.length; i += 1) out[i] = raw.charCodeAt(i);
	return out;
}

/**
 * 设备别名：用浏览器自报的平台 + 浏览器名，尽量像人话（"iPhone PWA"、"Android · Chrome"）。
 * 用户之后可以在推送面板里改名，这个名字只是默认值。
 */
export function deviceName(): string {
	const ua = navigator.userAgent;
	const standalone = window.matchMedia?.("(display-mode: standalone)").matches ? " PWA" : "";
	if (/iPhone/i.test(ua)) return `iPhone${standalone || " · Safari"}`;
	if (/iPad/i.test(ua)) return `iPad${standalone || " · Safari"}`;
	if (/Android/i.test(ua)) {
		const browser = /EdgA/.test(ua) ? "Edge" : /Firefox/.test(ua) ? "Firefox" : "Chrome";
		return `Android · ${browser}`;
	}
	if (/Macintosh/i.test(ua))
		return `Mac${standalone} · ${/Firefox/.test(ua) ? "Firefox" : /Edg/.test(ua) ? "Edge" : "Chrome"}`;
	if (/Windows/i.test(ua)) return `Windows · ${/Edg/.test(ua) ? "Edge" : "Chrome"}`;
	return "未知设备";
}

export function pushSupported(): boolean {
	return "serviceWorker" in navigator && "PushManager" in window;
}

async function registration(): Promise<ServiceWorkerRegistration> {
	const existing = await navigator.serviceWorker.getRegistration("/sw.js");
	if (existing) return existing;
	return navigator.serviceWorker.register("/sw.js");
}

export async function currentPushState(): Promise<PushState> {
	if (!pushSupported()) return "unsupported";
	const reg = await registration();
	const sub = await reg.pushManager.getSubscription();
	if (sub) return "subscribed";
	return Notification.permission as PushState;
}

export async function subscribePush(): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!pushSupported()) return { ok: false, message: "这个浏览器不支持推送（需要 https 或 localhost）" };
	const permission = await Notification.requestPermission();
	if (permission !== "granted") return { ok: false, message: "通知权限被拒绝" };

	const reg = await registration();
	const keyResponse = await fetch("/api/push/key");
	const { publicKey } = (await keyResponse.json()) as { publicKey: string };
	const sub =
		(await reg.pushManager.getSubscription()) ??
		(await reg.pushManager.subscribe({
			userVisibleOnly: true,
			applicationServerKey: urlBase64ToUint8Array(publicKey) as BufferSource,
		}));

	const json = sub.toJSON() as { endpoint?: string; keys?: { p256dh: string; auth: string } };
	const response = await fetch("/api/push/subscribe", {
		method: "POST",
		headers: { "content-type": "application/json", "x-agent-client": sessionStorage.getItem("agent-web-client") ?? "" },
		body: JSON.stringify({ endpoint: json.endpoint, keys: json.keys, name: deviceName() }),
	});
	if (!response.ok) return { ok: false, message: `订阅保存失败：HTTP ${response.status}` };
	return { ok: true };
}

export async function unsubscribePush(): Promise<{ ok: true } | { ok: false; message: string }> {
	if (!pushSupported()) return { ok: false, message: "不支持推送" };
	const reg = await registration();
	const sub = await reg.pushManager.getSubscription();
	if (!sub) return { ok: true };
	await fetch("/api/push/unsubscribe", {
		method: "POST",
		headers: { "content-type": "application/json" },
		body: JSON.stringify({ endpoint: sub.endpoint }),
	});
	await sub.unsubscribe();
	return { ok: true };
}

export async function sendTestPush(): Promise<{ sent: number; failed: number }> {
	const response = await fetch("/api/push/test", { method: "POST" });
	return (await response.json()) as { sent: number; failed: number };
}
