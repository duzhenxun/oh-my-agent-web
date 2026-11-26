/** 电脑控制的前端接口（与 server/computer/ 的返回结构保持一致；见 /api/computer） */

export type ComputerStatus = {
	/** 服务进程所在平台：Windows 上 `supported` 是 false，但面板要给「敬请期待」而不是报错 */
	platform?: string;
	/** 这个平台将来会做、现在还没实现（Windows） */
	comingSoon?: boolean;
	supported: boolean;
	helper: { installed: boolean; path: string | null };
	running: boolean;
	helperVersion: string | null;
	permissions: { accessibility: boolean; screenRecording: boolean } | null;
	error: string | null;
	/**
	 * 没装时的安装指引（装了 / 非 macOS 为 null）。
	 * 电脑控制用**用户自己装的 Agent Computer.app**，不内嵌进 oh-my-agent-web（2026-11-24 拍定）。
	 */
	install: {
		downloadUrl: string;
		requiresRightClickOpen: boolean;
		steps: string[];
	} | null;
	skill: { enabled: boolean; dir: string; cli: string };
};

export type ComputerSettings = {
	activateTarget: boolean;
	borrowFront: boolean;
	previewEnabled: boolean;
	watermarkEnabled: boolean;
	pointerEnabled: boolean;
	pointerSpeed: number;
	typingKeyDelayMs: number;
	unprotectedApps: string[];
};

export const POINTER_SPEED_RANGE = { min: 0.25, max: 4 } as const;
export const KEY_DELAY_RANGE = { min: 0, max: 200 } as const;

async function call<T>(path: string, init?: { method?: string; body?: unknown; signal?: AbortSignal }): Promise<T> {
	const response = await fetch(`/api/computer${path}`, {
		method: init?.method ?? "GET",
		credentials: "same-origin",
		cache: "no-store",
		...(init?.signal ? { signal: init.signal } : {}),
		...(init?.body === undefined
			? {}
			: { headers: { "content-type": "application/json" }, body: JSON.stringify(init.body) }),
	});
	const data = (await response.json().catch(() => ({}))) as { error?: string };
	if (!response.ok) throw new Error(data.error ?? `HTTP ${response.status}`);
	return data as T;
}

/** 已安装应用（给「解除保护的应用」做模糊搜索） */
export type InstalledAppOption = { name: string; bundleId: string; path: string };

export const fetchComputerStatus = () => call<ComputerStatus>("/status");
export const fetchComputerApps = (query: string, signal?: AbortSignal) =>
	call<{ apps: InstalledAppOption[]; total: number }>(`/apps?query=${encodeURIComponent(query)}`, { signal });
export const fetchComputerSettings = () => call<ComputerSettings>("/settings");
export const saveComputerSettings = (patch: Partial<ComputerSettings>) =>
	call<ComputerSettings>("/settings", { method: "PUT", body: patch });
/**
 * 打开 macOS「系统设置 → 隐私与安全性」里对应的那一页。
 *
 * 为什么不让前端直接 `window.open("x-apple.systempreferences:...")`：自定义 scheme
 * 在浏览器里处理不一致（有的静默丢掉）——交给服务端 `open` 一条命令最稳。
 */
/** 主动申请权限：会触发系统弹框，并把 App 登记进「辅助功能 / 屏幕录制」列表 */
export const requestComputerAccess = () => call<ComputerStatus>("/request-access", { method: "POST" });

export const openComputerPrivacyPane = (pane: "accessibility" | "screen") =>
	call<{ ok: boolean }>("/open-privacy", { method: "POST", body: { pane } });

export const setComputerSkill = (enabled: boolean) =>
	call<ComputerStatus>("/skill", { method: "POST", body: { enabled } });
