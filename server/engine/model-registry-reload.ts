/**
 * 重新加载 pi 的模型注册表。
 *
 * pi 的注册表是**进程内缓存**：改完 models.json / models-store.json 之后不重建，
 * `getAvailable()` 还是旧列表 —— 界面上就是「加完模型却看不到」。
 *
 * 做法：丢掉预热会话（内存会话，重建无副作用）→ 新建 → 活着会话逐个 refresh（只读本地）。
 * 单独成文件是为了让 pi-sdk.ts 守住 400 行护栏。
 */
type WarmSession = {
	unsubscribe: () => void;
	session: { dispose: () => void; modelRuntime?: { refresh?: (options?: unknown) => Promise<unknown> } };
};

export async function reloadModelRegistry(
	sessions: Map<string, WarmSession>,
	prewarmId: string,
	prewarm: () => Promise<void> | undefined,
): Promise<void> {
	const warm = sessions.get(prewarmId);
	if (warm) {
		try {
			warm.unsubscribe();
			warm.session.dispose();
		} catch {
			// 预热会话无关紧要，dispose 失败忽略
		}
		sessions.delete(prewarmId);
	}
	await prewarm();
	for (const handle of sessions.values()) {
		await handle.session.modelRuntime?.refresh?.({ allowNetwork: false }).catch(() => undefined);
	}
}
