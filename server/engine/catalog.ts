/**
 * 引擎目录（ADR-0024 的运行时视图）：注册表 + 「每个引擎自己的历史会话来源」。
 *
 * 为什么单独一层：注册表只知道「怎么造引擎」，但切换引擎时还要换**会话清单从哪来**
 * （pi 扫 `~/.pi/agent/sessions`，codex 走 app-server，fake 没有历史）。
 * 把这些绑在一起，`runtime.setEngine()` 就只依赖目录，不依赖具体引擎。
 */
import type { PiProject } from "../protocol.js";
import type { EnginePort } from "./port.js";
import type { EngineDescriptor, EngineRegistry } from "./registry.js";

export type EngineEntry = { engine: EnginePort; descriptor: EngineDescriptor };

export type EngineCatalog = {
	/** 全部注册项（切换面板的列表来源） */
	descriptors: () => EngineDescriptor[];
	/** 按名字取缓存实例；未知名字返回 null */
	get: (name: string) => EngineEntry | null;
	/** 这个引擎的历史会话来源；没有历史（或没接）返回 null */
	sessionsFor: (name: string) => (() => Promise<PiProject[]>) | null;
};

export function createEngineCatalog(options: {
	registry: EngineRegistry;
	/** 引擎名 → 会话清单提供者（key 不在表里 = 该引擎没有历史会话） */
	sessions?: Record<string, () => Promise<PiProject[]>>;
}): EngineCatalog {
	const sessions = options.sessions ?? {};
	return {
		descriptors: () => options.registry.descriptors(),
		get: (name) => options.registry.get(name),
		sessionsFor: (name) => sessions[name] ?? null,
	};
}
