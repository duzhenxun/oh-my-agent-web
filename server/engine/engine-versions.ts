/**
 * 引擎版本表（切换面板的每一行右上角那串 `v0.16.2`）。
 *
 * 为什么单独一层：版本号属于**每个引擎各自**（pi 的 SDK 版本、codex CLI、claude-code-acp
 * 适配器…），而快照里原先只有 `versions.engine`（当前那个）。这里把「有哪些引擎、
 * 各自版本是多少」一次性探明并缓存，`engineOptions` 只负责把它贴到列表项上。
 *
 * 纪律：
 *   - **懒、异步、不阻塞**：启动时后台跑一次，探到值才推帧；全部失败也只是少显示几行字；
 *   - **一次就够**：结果（含 null）在本进程内缓存，切引擎不会重新拉起子进程；
 *   - **不编造**：探测不到就是 null，界面留空。
 */
import type { EngineDescriptor } from "./registry.js";

/** 引擎名 → 版本号（null = 探不到/不需要显示） */
type EngineVersionMap = Record<string, string | null>;

type EngineVersionProber = {
	/** 探一遍还没探过的引擎，返回**全量**版本表（已探过的直接用缓存） */
	refresh: () => Promise<EngineVersionMap>;
	/** 当前已知的版本表（同步，未探到的不出现） */
	known: () => EngineVersionMap;
	/** 记下一个「更准」的版本（当前引擎握手给的），并挡住后续用探测值覆盖它 */
	remember: (name: string, version: string | null) => void;
};

export function createEngineVersionProber(options: {
	descriptors: () => EngineDescriptor[];
	/** 探测失败的旁路日志（只进日志，不进对话流） */
	onLog?: (text: string) => void;
}): EngineVersionProber {
	const cache = new Map<string, string | null>();
	const inflight = new Map<string, Promise<string | null>>();

	const probe = (descriptor: EngineDescriptor): Promise<string | null> => {
		const known = inflight.get(descriptor.name);
		if (known) return known;
		const pending = (async () => {
			try {
				const value = await descriptor.version?.();
				return typeof value === "string" && value.trim() !== "" ? value.trim() : null;
			} catch (error) {
				options.onLog?.(
					`探测 ${descriptor.name} 的版本号失败：${error instanceof Error ? error.message : String(error)}`,
				);
				return null;
			}
		})();
		inflight.set(descriptor.name, pending);
		return pending;
	};

	const snapshot = (): EngineVersionMap => Object.fromEntries(cache);

	return {
		known: snapshot,
		remember(name, version) {
			// 握手给的版本最准：记下来，后面 refresh 也不会把它擦掉
			if (version && version.trim() !== "") cache.set(name, version.trim());
		},
		async refresh() {
			await Promise.all(
				options.descriptors().map(async (descriptor) => {
					if (cache.has(descriptor.name)) return;
					const value = await probe(descriptor);
					// 期间可能有 remember()（握手）写过更准的值，别覆盖
					if (!cache.has(descriptor.name)) cache.set(descriptor.name, value);
				}),
			);
			return snapshot();
		},
	};
}
