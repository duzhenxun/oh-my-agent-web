/** 电脑控制的前端接口（与 server/computer/ 的返回结构保持一致；见 /api/computer） */

export type ComputerStatus = {
	supported: boolean;
	helper: { installed: boolean; path: string | null };
	running: boolean;
	helperVersion: string | null;
	permissions: { accessibility: boolean; screenRecording: boolean } | null;
	error: string | null;
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

async function call<T>(
	path: string,
	init?: { method?: string; body?: unknown; signal?: AbortSignal },
): Promise<T> {
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
export const setComputerSkill = (enabled: boolean) =>
	call<ComputerStatus>("/skill", { method: "POST", body: { enabled } });
