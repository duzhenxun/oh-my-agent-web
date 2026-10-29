/**
 * 引擎注册表（ADR-0024）：把「有哪些引擎可选」与「引擎各自能干到什么程度」集中到一处。
 *
 * 目标：加一个新引擎 = 写一个适配文件 + 在这里注册一行，
 * 而不是去 index / runtime / 前端各处改 if/else。
 *
 * 纪律：
 *   - 每个引擎的 SDK / 子进程只允许出现在它自己的适配文件里，引擎之间不得互相 import；
 *   - 能力矩阵必须**如实**声明：没有的写着 false，界面据此隐藏按钮，绝不假装能拦。
 */
import type { EnginePort } from "./port.js";

/**
 * 引擎能力（ADR-0024 §2）：决定界面上哪些控件出现。
 *
 * **类型只有一份**：正文在 `protocol.ts`（它同时是发给前端的快照契约）。
 * 这里以前又抄了一份字段定义，于是往 protocol 里加字段（比如 `steer`）时
 * 注册表这边不会跟着变、类型检查才发现——所以改成直接 re-export。
 */
export type { EngineCapabilities } from "../protocol.js";
import type { EngineCapabilities } from "../protocol.js";

export type EngineDescriptor = {
	/** 注册名，也就是 AGENT_WEB_ENGINE 的取值 */
	name: string;
	/** 界面显示名 */
	label: string;
	/** 顶栏 / 面板上的短标签（PI / FAKE / CODEX）；不给就用 label */
	badge?: string;
	/** 切换面板里的一句话说明：能力边界写清楚，别夸大（ADR-0024 §2） */
	description?: string;
	/** 这个引擎的模型/provider 配置由本工作台管理（只有 pi 是：models-store.json + auth.json） */
	providerConfig?: boolean;
	/**
	 * 这个引擎**自己的**版本号（切换面板每一行都要显示自己的，不只是当前那个）。
	 *
	 * 快的（pi 的 SDK 版本）直接返回字符串；要起子进程 / 读文件的返回 Promise。
	 * 探不到就返回 null：界面留空，不编版本号（ADR-0024 §2 的「如实」）。
	 */
	version?: () => string | null | Promise<string | null>;
	/**
	 * 不出现在切换面板里（除非它就是当前引擎）。
	 * `fake` 是测试引擎：环境变量能选中它，但普通用户不该在面板里点到。
	 */
	hidden?: boolean;
	capabilities: EngineCapabilities;
	create: () => EnginePort;
};

export type EngineRegistry = {
	/** 已注册的引擎名（给错误信息与调试用） */
	names: () => string[];
	/** 按名字取引擎；未知名字回落到 fallback（默认 pi），并报告这件事 */
	resolve: (name: string) => { engine: EnginePort; descriptor: EngineDescriptor; fallbackFrom: string | null };
	/** 按名字取**缓存实例**（切换引擎用：同一个引擎不该每次都 new 一个）；未知名字返回 null */
	get: (name: string) => { engine: EnginePort; descriptor: EngineDescriptor } | null;
	/** 全部描述（切换面板的列表来源） */
	descriptors: () => EngineDescriptor[];
	/** 按名字取能力矩阵；未知名字回落 */
	capabilitiesOf: (name: string) => EngineCapabilities;
};

const ALL_ON: EngineCapabilities = {
	approvals: true,
	tools: true,
	modelSwitch: true,
	thinkingLevel: true,
	resume: true,
};

export function createEngineRegistry(descriptors: EngineDescriptor[], fallbackName = "pi"): EngineRegistry {
	const byName = new Map(descriptors.map((descriptor) => [descriptor.name, descriptor]));
	const fallback = byName.get(fallbackName) ?? descriptors[0];
	if (!fallback) throw new Error("引擎注册表为空（至少要注册一个引擎）");
	/** name → 实例（懒建）；切换引擎复用它，避免每次 new 一个带状态的引擎 */
	const instances = new Map<string, EnginePort>();

	const instantiate = (descriptor: EngineDescriptor): EnginePort => {
		const known = instances.get(descriptor.name);
		if (known) return known;
		const created = descriptor.create();
		instances.set(descriptor.name, created);
		return created;
	};

	return {
		names: () => [...byName.keys()],
		descriptors: () => descriptors.map((descriptor) => ({ ...descriptor })),
		get(name) {
			const found = byName.get(name);
			return found ? { engine: instantiate(found), descriptor: found } : null;
		},
		resolve(name) {
			const found = byName.get(name);
			if (found) return { engine: instantiate(found), descriptor: found, fallbackFrom: null };
			return { engine: instantiate(fallback), descriptor: fallback, fallbackFrom: name };
		},
		capabilitiesOf: (name) => (byName.get(name) ?? fallback).capabilities,
	};
}

/** 假引擎的能力：**没有审批**（它只是剧本，不需要拦），其余从简 */
export const FAKE_CAPABILITIES: EngineCapabilities = {
	approvals: true, // 假引擎仍会走审批剧本（approve 触发词），保留 true
	tools: true,
	modelSwitch: true,
	thinkingLevel: false,
	resume: true,
	// 也实现了（内存会话 / 转录截断），用它就能走一遍「临时对话 + 派生分支」的宿主流程
	ephemeralChat: true,
	forkChat: true,
};

/** pi：能力全开，而且**只有它真能插队**（`streamingBehavior: "steer"`，见 ADR-0043） */
export const PI_CAPABILITIES: EngineCapabilities = {
	...ALL_ON,
	subagents: true,
	steer: true,
	// 临时会话（`SessionManager.inMemory`）与派生分支（按 entry 剪历史另存）都是 pi 会话存储的能力
	ephemeralChat: true,
	forkChat: true,
};
